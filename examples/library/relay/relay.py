import asyncio
import contextlib
import collections.abc
import dataclasses
import json
import logging
import os
import uuid
from typing import (
    Any,
    AsyncGenerator,
    Awaitable,
    Callable,
    Coroutine,
    Dict,
    Generator,
    Iterable,
    List,
    Never,
    Set,
    Tuple,
    TypedDict,
)

from aiohttp import web
import kurrentdbclient as kdbc
import lmdb

import model


logging.basicConfig(level=logging.DEBUG)
log = logging.getLogger("relay")

# a sentinel to be used in place of patron_id for administrators
class Admin(object):
    pass

ADMIN = Admin()

PatronID = str | Admin

# note: RelayCommands is an alias in model/library.py, and model.AdminCommands is equivalent
RelayCommands = model.AdminCommands

EventQ = asyncio.Queue[kdbc.RecordedEvent]


async def waitgroup(*coros: Coroutine) -> None:
    """Run multiple coroutines to completion, or cancel the rest after one crashes."""
    try:
        async with asyncio.TaskGroup() as tg:
            for coro in coros:
                tg.create_task(coro)
    except BaseExceptionGroup as e:
        # preserve first exception... why would I ever want anything else
        raise e.exceptions[0] from None


class Sync:
    """
    A small utility for tracking round trips through the database.

    With each batch of writes we submit, we record the resulting stream position, then wait
    for the $all stream subscription to reach that position.
    """
    def __init__(self) -> None:
        self.cond = asyncio.Condition()
        self.value = 0

    async def wait_for(self, position: int) -> None:
        async with self.cond:
            while self.value < position:
                await self.cond.wait()

    async def update(self, value: int) -> None:
        self.value = value
        async with self.cond:
            self.cond.notify_all()


def assert_never(arg: Never) -> Never:
    raise AssertionError("Expected code to be unreachable")


def stream_for(event: Dict[str, Any]) -> str:
    match event["type"]:
        case "add-edition":            return "books"
        case "update-edition-title":   return "books"
        case "add-book":               return "books"
        case "update-book-restricted": return "books"
        case "remove-book":            return "books"

        case "add-patron":    return f'patron.{event["id"]}'
        case "rename-patron": return f'patron.{event["id"]}'
        case "assign-patron": return f'patron.{event["id"]}'

        case "try-hold":     return "status"
        case "cancel-hold":  return "status"
        case "try-checkout": return "status"
        case "end-checkout": return "status"
        case _: raise RuntimeError(f'unrecognized command type: {event["type"]}')


class Appender:
    """Appender appends events to the database."""
    def __init__(self, sync: Sync, client: kdbc.AsyncKurrentDBClient) -> None:
        self.sync = sync
        self.client = client

    async def append(self, new_uuids: List[str], batch: List[model.Identified[Any]]) -> None:
        log.debug(f"appending: {batch}")
        # the plural of NewEvents is "new_eventses", which you have to say with a Gollum voice.
        new_eventses = []

        # First add any newly-created uuids.
        #
        # We use KurrentDB's optimistic concurrency locks to ensure that each client-generated uuid is
        # unique.  This comes at the cost of one tiny stream per uuid in the system, which is not
        # unbearable.  But we could reduce to something like 65K streams of one event each, by:
        #
        #   - tracking all known uuids in the read model
        #   - grouping uuids into buckets by, say, the first 4 hex chars
        #   - writing an event to the bucket of each new uuid with each batch of submissions.  If
        #     the write fails, you need to wait for the new revision for that bucket stream to
        #     arrive, then retry.
        #
        # Without some sort of real-life limitation, that complexity is not justified.
        for u in new_uuids:
            new_eventses.append(
                kdbc.NewEvents(
                    stream_name=f"uuid.{u}",
                    events=[kdbc.NewEvent(type='UuidExists', data=b'{}')],
                    current_version=kdbc.StreamState.NO_STREAM,
                ),
            )

        # then add the events
        last_stream = None
        events: List[kdbc.NewEvent] = []
        for event in batch:
            id = event["id"]
            data = event["data"]
            stream = stream_for(data)
            if last_stream != stream:
                # start a new NewEvents object, with a new events list that we'll grow
                last_stream = stream
                events = []
                new_eventses.append(
                    kdbc.NewEvents(
                        stream_name=stream,
                        events=events,
                        current_version=kdbc.StreamState.ANY,
                    )
                )
            events.append(
                kdbc.NewEvent(
                    type="LibraryEvents",
                    data=json.dumps(data).encode('utf8'),
                    id=uuid.UUID(id),
                ),
            )

        position = await self.client.multi_append_to_stream(new_eventses)

        # wait for the round trip to complete, so the Reader's next call to eng.simulate can rely
        # on these events we've just written.
        await self.sync.wait_for(position)


def wrap(event: kdbc.RecordedEvent, alt_data: str | None = None) -> str:
    """Wrap an event in an envelope of metadata, to match typescript's Committed type."""
    return '{"position": %d, "id": "%s", "data": %s}'%(
        event.commit_position,
        str(event.id),
        alt_data or event.data.decode('utf8'),
    )


class Subscriber:
    """Subscriber subscribes to the database."""
    def __init__(
        self, sync: Sync, eng: model.RelayEngine, client: kdbc.AsyncKurrentDBClient,
    ) -> None:
        self.sync = sync
        self.eng = eng
        self.client = client
        self.watches: Dict[PatronID, List[Callable[[str], None]]] = {}
        self.q: asyncio.Queue[kdbc.RecordedEvent] = asyncio.Queue(100)

    async def start(self) -> None:
        # catch up to current state once before turning on the webserver
        since = self.eng.reconnect()
        async with await self.client.read_all(
            commit_position=since,
            resolve_links=True,
            filter_by_stream_name=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                "patron.",
                "status",
                "vstatus",
                "sync",
            ),
        ) as stream:
            batch = []
            async for event in stream:
                batch.append(event)
                if len(batch) == 1000:
                    await self.update_read_model(batch)
                    batch = []
        if batch:
            await self.update_read_model(batch)

        self.eng.caught_up()

    async def run(self) -> None:
        await waitgroup(self.collect(), self.process())

    async def collect(self) -> None:
        """
        TODO: this may not be doing what I want it to; what I want is to only apply backpressure to
        the network when there are 1000 unprocessed events in the queue... but what I think is
        happening is that the collector is always stopped while processing occurs.  This is unlike
        the go version, where different goroutines can actually run on different hardware threads.

        This needs testing.
        """
        since = self.eng.reconnect()
        async with await self.client.subscribe_to_all(
            commit_position=since,
            resolve_links=True,
            filter_by_stream_name=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                "patron.",
                "status",
                "vstatus",
                "sync",
            ),
        ) as stream:
            async for event in stream:
                await self.q.put(event)

    async def process(self) -> None:
        while True:
            # get one or more events from collector
            batch = []
            batch.append(await self.q.get())
            while not self.q.empty():
                batch.append(self.q.get_nowait())

            await self.update_read_model(batch)
            self.dispatch(batch)

    async def update_read_model(self, batch: List[kdbc.RecordedEvent]) -> None:
        # first read all the json
        events = []
        for event in batch:
            events.append({
                "position": event.commit_position,
                "id": str(event.id),
                "data": json.loads(event.data),
            })

        # apply updates to the read model
        self.eng.recv_events(events)

        # notify anybody who was waiting for a round-trip
        await self.sync.update(batch[-1].commit_position)

    def dispatch(self, batch: List[kdbc.RecordedEvent]) -> None:
        # also dispatch the events to the various watches
        for event in batch:
            wrapped = wrap(event)
            match event.stream_name.split(".", maxsplit=1):
                # events with global distribution
                case ("books",):
                    for put in (put for w in self.watches.values() for put in w):
                        put(wrapped)

                # events with limited distribution
                case ("status",):
                    j = json.loads(event.data)
                    typ = j["type"]
                    if typ in ("cancel-hold", "expire-hold", "end-checkout"):
                        # global distribution for these event types
                        for put in (put for w in self.watches.values() for put in w):
                            put(wrapped)
                    else:
                        # admin-only distribution for the rest
                        for put in self.watches.get(ADMIN, []):
                            put(wrapped)

                case ("patron", patron_id):
                    # each patron sees their own patron events
                    for put in self.watches.get(patron_id, []):
                        put(wrapped)
                    # and admins see everyone
                    for put in self.watches.get(ADMIN, []):
                        put(wrapped)

                # events needing sanitization
                case ("vstatus",):
                    # we'll need to examine the contents of this message type
                    j = json.loads(event.data)
                    typ = j["type"]

                    # calculate sanitized versions for specific events
                    sanitized = None
                    if typ in ("new-vhold", "new-vcheckout"):
                        temp = dict(j)
                        del temp["patron"]
                        sanitized = wrap(event, json.dumps(temp))

                    # actually distribute the events
                    for put, w_patron_id in (
                        (put, w_patron_id) for w_patron_id, w in self.watches.items() for put in w
                    ):
                        # skip admins; they don't care about vstatus
                        if w_patron_id == ADMIN: continue
                        if typ == "vhold-rejected" and w_patron_id != j["patron"]:
                            # this event is only for the patron whose hold was rejected
                            continue
                        elif sanitized and w_patron_id != j["patron"]:
                            # emit sanitized message
                            put(sanitized)
                        else:
                            # emit full message
                            put(wrapped)
                case _:
                    raise RuntimeError("no subscription to event", event)

    async def catchup(
        self, patron_id: PatronID, since: int,
    ) -> AsyncGenerator[Tuple[str, int]]:
        patron_stream_prefix = "patron." + ("" if patron_id == ADMIN else str(patron_id))
        async with await self.client.read_all(
            commit_position=since,
            resolve_links=True,
            filter_by_stream_name=True,
            filter_by_prefix=True,
            filter_include=(
                "books",
                patron_stream_prefix,
                "status",
                "vstatus",
            ),
        ) as stream:
            async for event in stream:
                # TODO: why is this necessary?  Seems really annoying...
                if event.commit_position == since: continue
                if event.stream_name not in ("status", "vstatus"):
                    yield wrap(event), event.commit_position
                    continue
                # we'll need to examine the event to know how to distribute it
                j = json.loads(event.data)
                typ = j["type"]
                if event.stream_name == "status":
                    # admin gets all status events, users get some
                    if patron_id == ADMIN or typ in ("cancel-hold", "expire-hold", "end-checkout"):
                        yield wrap(event), event.commit_position
                    continue
                # vstatus stream needs sanitizing
                assert event.stream_name == "vstatus"
                if typ == "vhold-rejected":
                    # only yield those which match our patron_id
                    if patron_id == j["patron"]:
                        yield wrap(event), event.commit_position
                    continue
                if typ in ("new-vhold", "new-vcheckout") and patron_id != j["patron"]:
                    # sanitize
                    del j["patron"]
                yield wrap(event, json.dumps(j)), event.commit_position


    async def stream(self, patron_id: PatronID, since: int, w: Writer) -> None:
        """Start with a catchup subscription, then move to a live subscription."""

        # first do a cold catchup, which may take a while (we don't want to collect live events yet)
        async for event, position in self.catchup(patron_id, since):
            await w.put_start(event)
            since = position

        # now subscribe to live events
        self.watches.setdefault(patron_id, []).append(w.put_live)
        try:
            # do a hot catchup to make sure we don't miss any events
            async for event, position in self.catchup(patron_id, since):
                await w.put_start(event)
                since = position

            # transition to the liveq, discarding duplicate events
            await w.go_live(since)

            # now just wait to be canceled
            await asyncio.Future()

        finally:
            filtered = [p for p in self.watches[patron_id] if p is not w.put_live]
            if filtered:
                self.watches[patron_id] = filtered
            else:
                del self.watches[patron_id]


class Writer:
    """
    Writer is responsibe for sending events on the websocket.

    It also provides tools for the Subscriber to transition from catchup subscriptions (based on
    reading from the database) to live subscriptions (based on in-memory dispatch of a shared $all
    stream subscription).
    """
    def __init__(self, patron_id: PatronID, ws: web.WebSocketResponse) -> None:
        self.patron_id = patron_id
        self.ws = ws
        self.startq: asyncio.Queue[None | str] = asyncio.Queue(10)
        self.liveq: asyncio.Queue[str] = asyncio.Queue(100)
        # call _run() now so we have a handle for canceling it
        self.coro = self._run()

    async def run(self) -> None:
        await self.coro

    async def _run(self) -> None:
        # drain the startq until we see the None sentinel, ending that stream
        while True:
            msg = await self.startq.get()
            if msg is None: break
            await self._send(msg)

        # send a caughtup message
        await self._send("caughtup")

        # then drain the liveq forever
        while True:
            msg = await self.liveq.get()
            await self._send(msg)

    async def _send(self, msg: str) -> None:
        log.debug(f"send: {msg}")
        await self.ws.send_str(msg)

    async def put_start(self, msg: str) -> None:
        await self.startq.put(msg)

    def put_live(self, msg: str) -> None:
        try:
            self.liveq.put_nowait(msg)
        except asyncio.QueueFull:
            self.fell_behind()

    def fell_behind(self) -> None:
        try:
            self.coro.throw(UserError("fell behind"))
        except StopIteration:
            pass

    async def go_live(self, since: int) -> None:
        """
        Transition from reading startq to reading liveq, making sure to discard any duplicate
        events on liveq that we may have noticed during the hot catchup step.
        """
        # discard any duplicate events from liveq
        while True:
            try:
                # pop duplicates from the queue
                event = self.liveq.get_nowait()
            except asyncio.QueueEmpty:
                # liveq is empty
                break
            position = json.loads(event)["position"]
            if position <= since: continue
            # oops this isn't a duplicate; make it the last event on the startq
            await self.startq.put(event)
            break
        # push a sentinel to the startq, so self._run() will switch
        await self.startq.put(None)


class UserError(Exception):
    pass


class Reader:
    """
    Reader reads incoming commands from the
    """
    def __init__(
        self,
        eng: model.RelayEngine,
        appender: Appender,
        patron_id: PatronID,
        ws: web.WebSocketResponse,
    ) -> None:
        self.eng = eng
        self.appender = appender
        self.patron_id = patron_id
        self.ws = ws
        # size of the queue is the maximum batch size we can process
        self.q: asyncio.Queue[model.Identified[Any]] = asyncio.Queue(100)

        if patron_id == ADMIN:
            self.validator = eng.module["validateAdminCommands"]
        else:
            func = eng.module["validateUserCommands"]
            self.validator = lambda rx, events: func(rx, events, self.patron_id)

    async def run(self) -> None:
        await waitgroup(self.collect(), self.process())

    async def collect(self) -> None:
        """Collect websocket messages as they arrive, to be processed in batches."""
        async for msg in self.ws:
            log.debug(f"recv: {msg}")
            if msg.type == web.WSMsgType.ERROR:
                # websocket failed
                if isinstance(msg.data, TimeoutError):
                    # ConnectionErrors are logged at debug level because they're rarely useful
                    raise ConnectionError("timeout")
                # unknown errors are logged at error level, so we can learn them and decide if they
                # are useful or not
                if isinstance(msg.data, BaseException):
                    raise msg.data
                raise ValueError(
                    f"websocket failed with type=ERROR but no exception: data={msg.data}"
                )

            # make sure each event is structurally valid
            obj = msg.json()
            errors = model.check_identified(obj, model.check_admin_commands)
            if errors:
                raise UserError(errors)

            await self.q.put(obj)

        # we are out of messages; cancel the remaining concurrent tasks by raising an exception
        raise ConnectionError("Reader() is out of messages")

    async def process(self) -> None:
        """Process events in batches, provided by collect()."""
        while True:
            # get one or more events from collector
            batch = []
            batch.append(await self.q.get())
            while not self.q.empty():
                batch.append(self.q.get_nowait())

            # make sure each event is semantically valid
            new_uuids, errors = self.eng.simulate(self.validator, batch)
            if errors:
                raise UserError(errors)

            await self.appender.append(new_uuids, batch)


WsHandler = Callable[[web.Request], Coroutine[Any, Any, web.WebSocketResponse]]


def cancelable_request(fn: WsHandler) -> WsHandler:
    """Cancel any connected sockets if the app-wide cancel event is set."""
    async def _fn(request: web.Request) -> web.WebSocketResponse:
        cancel_event = request.app["cancel_event"]
        cancel = asyncio.create_task(cancel_event.wait())
        handler = asyncio.create_task(fn(request))

        _ = await asyncio.wait([cancel, handler], return_when=asyncio.FIRST_COMPLETED)
        if cancel.done():
            handler.cancel()
            return await handler
        else:
            cancel.cancel()
            return handler.result()
    return _fn


route = web.RouteTableDef()

@route.get("/ws")  # type: ignore
@cancelable_request
async def ws_handler(request: web.Request) -> web.WebSocketResponse:
    eng = request.app["engine"]
    client = request.app["client"]
    subscriber = request.app["subscriber"]
    appender = request.app["appender"]

    # enable heartbeat every 55 seconds, to keep nginx or any NAT layers from timing out in 60
    ws = web.WebSocketResponse(autoping=True, heartbeat=55)
    try:
        await ws.prepare(request)

        # first message is a handshake: {"patron": "...", "since": 123}
        handshake_msg = await ws.receive_json()
        # TODO: have some real authentication
        patron_id: PatronID = handshake_msg.get("patron") or ADMIN
        since: int | None = handshake_msg.get("since")

        w = Writer(patron_id, ws)
        r = Reader(eng, appender, patron_id, ws)

        await waitgroup(w.run(), r.run(), subscriber.stream(patron_id, since, w))

        return ws

    except ConnectionError as e:
        log.debug(f"broken connection: {e}")
        # Return the ws response or otherwise aiohttp gets confused.  If we raise an exception here
        # aiohttp insists on logging it, so this seems to be the quiet "go away" strategy.
        return ws
    except Exception as e:
        log.error(e)
        raise
    finally:
        await ws.close()


@contextlib.asynccontextmanager
async def setupKurrent(
    eng: model.RelayEngine, connstr: str,
) -> AsyncGenerator[kdbc.AsyncKurrentDBClient, Subscriber]:
    async with kdbc.AsyncKurrentDBClient(connstr) as client:
        yield client


@contextlib.asynccontextmanager
async def setupWebserver(listen_spec: str, app_data: Dict[str, Any]) -> AsyncGenerator[None]:
    App = web.Application()
    for k, v in app_data.items():
        App[k] = v

    # close websockets when we get a close signal (see @cancelable_request)
    cancel_event = asyncio.Event()
    App["cancel_event"] = cancel_event

    async def on_shutdown(app: web.Application) -> None:
        cancel_event.set()

    App.on_shutdown.append(on_shutdown)

    App.add_routes(route)
    runner = web.AppRunner(App)
    await runner.setup()

    host, port = listen_spec.split(":")
    site = web.TCPSite(runner, host, int(port or "80"))
    listening = f"http://{host or 'localhost'}:{port or '80'}"

    await site.start()

    try:
        yield
    finally:
        await site.stop()
        await runner.cleanup()

# configure a persistent lmdb-based Store
env = lmdb.Environment(os.path.join(os.path.dirname(__file__), ".lmdb"))

class LmdbTxn(model.Txn):
    UNDEFINED = object()

    def __init__(self, txn: lmdb.Transaction) -> None:
        self.txn = txn

    def commit(self) -> None:
        self.txn.commit()

    def abort(self) -> None:
        self.txn.abort()

    def get(self, key: str) -> collections.abc.Buffer:
        value = self.txn.get(key=key.encode('utf8'), default=self.UNDEFINED)
        if value is self.UNDEFINED:
            raise KeyError(key)
        assert isinstance(value, collections.abc.Buffer)
        return value

    def set(self, key: str, value: collections.abc.Buffer) -> None:
        self.txn.put(key.encode('utf8'), value, overwrite=True)

    def delete(self, key: str) -> None:
        self.txn.delete(key.encode('utf8'))


async def amain(connstr: str) -> None:
    # set up the sync engine
    eng = model.RelayEngine(
        os.path.join(os.path.dirname(__file__), "relay.js"),
        lambda write: LmdbTxn(env.begin(write=True, buffers=True)),
        "relayMigrate",
        "relayReducer",
    )

    # set up our kurrentdb client
    async with setupKurrent(eng, connstr) as client:

        # create the appender and subscriber
        sync = Sync()
        appender = Appender(sync, client)
        subscriber = Subscriber(sync, eng, client)

        # let the subscriber catch up to current state before accepting websocket connections
        await subscriber.start()

        # set up the webserver
        async with setupWebserver("localhost:3001", {
            "engine": eng,
            "client": client,
            "appender": appender,
            "subscriber": subscriber,
        }):

            print("ready")

            # run until we are canceled
            await subscriber.run()


if __name__ == "__main__":
    connstr = "kurrentdb://admin:changeit@localhost:2113?tls=false"
    try:
        asyncio.run(amain(connstr))
    except KeyboardInterrupt:
        pass
