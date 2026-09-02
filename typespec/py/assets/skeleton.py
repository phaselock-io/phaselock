import base64
import collections.abc
import datetime
import json
import uuid
from typing import (
    Any,
    Awaitable,
    Callable,
    Coroutine,
    Generator,
    Literal,
    NotRequired,
    Protocol,
    TypedDict,
    cast,
)

import _quickjs


type JSON = dict[str, JSON] | list[JSON] | str | int | bool | None


class StoreValue(TypedDict):
    err: NotRequired[Any]
    value: NotRequired[Any]


class QueryQuestion(TypedDict):
    store: NotRequired[dict[str, None | Callable[[Any], Any]]]
    query: NotRequired[dict[str, Literal[True]]]


class QueryResult(TypedDict):
    result: Any
    dirty: bool


class QueryAnswer(TypedDict):
    store: dict[str, StoreValue]
    query: dict[str, QueryResult]


class _QueryResult:
    def __init__(self, id: str) -> None:
        self._id = id

    def __await__(self) -> Generator[QueryQuestion, QueryAnswer, Any]:
        # ask the graph for the result of a query when it's ready
        ans = yield {"query": {self._id: True}}
        return ans["query"][self._id]["result"]


class _StoreResult:
    def __init__(self, jsiter: _quickjs.Value) -> None:
        self._jsiter = jsiter

    def __await__(self) -> Generator[QueryQuestion, QueryAnswer, Any]:
        # rely on the javascript QX to ask the StoreQuestion with the right decoder attached
        got = self._jsiter.next(None)
        assert not got.done
        # capture the key in the question
        key = next(iter(got.value.store))
        # yield the question, intercept the answer
        ans = (yield got.value)["store"][key]
        # handle the answer ourselves, without JS's queryGet() and corresponding readOnly() wrapper
        if "err" in ans:
            raise ValueError(ans["err"])
        return ans["value"]


# technically we have type information of what is yielded and sent, but async python wants Any,Any
type QueryGenerator[T] = Coroutine[Any, Any, T]
type QueryFunction[QX, T] = Callable[[QX], QueryGenerator[T]]


class Query[T]:
    def __init__(self, _query: _quickjs.Value):
        self._query = _query

    @property
    def latest(self) -> T | None:
        return cast(T | None, self._query.latest)

    def subscribe(self, cb: Callable[[T], None]) -> Callable[[], None]:
        return cast(Callable[[], None], self._query.subscribe(cb))

    def close(self) -> None:
        self._query.close()

    async def result(self) -> T:
        return cast(T, await _QueryResult(self._query.id))


# TODO: only synchronous stores are currently supported, for two reasons:
#
#  - This strategy of catching an exception and converting it to a {err: "the exception"}
#    store callback does not work if the operation doesn't complete within the txn method.
#    You can union every return type like `-> None | Awaitable[None]` to allow async
#    implementations of each protocol method, but _quickjs.make_store() would need additional
#    work.  I suppose in that case, the setTimeout() definition should be written so that
#    callbacks are async as well.  Or maybe that could also be autodetected, if the callbacks
#    return coroutines instead of plain python values.
#
#  - The fx.wakeup() called within the store callback must be followed by running the event
#    loop, but supporting that would require adding an additional run() closure variable to the
#    various glue functions behind _quickjs.make_store(), since it must occur some time after
#    the Txn methods return.
#
# For now, we don't care because our only target store is LMDB, which is synchronous
# anyway.
class Txn(Protocol):
    def commit(self) -> None: ...
    def abort(self) -> None: ...
    # get shall raise a KeyError if the key is not present
    def get(self, key: str) -> collections.abc.Buffer: ...
    def set(self, key: str, value: collections.abc.Buffer) -> None: ...
    def delete(self, key: str) -> None: ...


class ReconnectInfo[C](Protocol):
    checkpoint: int | None
    commands: list[C]


class Engine[QX, E, C]:
    def __init__(
        self,
        bundle: str,
        engine_cls: str,
        # if store is None, InMemStore (from typescript) is used
        store: Callable[[bool], Txn] | None,
        qx_factory: Callable[[_quickjs.Value], QX],
        migrate: str | None,
        reducer: str,
    ) -> None:
        self._js = _quickjs.QuickJS()
        self._qx_factory = qx_factory

        # The Engine api is already callback-based, not async, so a very simple event loop is
        # enough to support setTimeout().  Support setTimeout() with non-zero delay is not needed.
        self._run = self._js.eval(
            '''// run a closure that returns a value, so we don't pollute global namespace
            (() => {
                const fns = [];

                // define a global setTimeout
                globalThis.setTimeout = (fn, timeout) => {
                    if (timeout !== undefined && timeout !== 0) {
                        throw new Error("setTimeout with nonzero timeout not supported");
                    }
                    fns.push(fn);
                };

                // return a run() function
                let running = false;
                return () => {
                    if (running) return;
                    running = true;
                    try {
                        let fn;
                        while((fn = fns.shift())){
                            fn();
                        }
                    } finally {
                        running = false;
                    }
                };
            })();''',
            file="Engine.run",
        )

        with open(bundle) as f:
            text = f.read()
        sourcemap_index = text.find("//# sourceMappingURL=")
        if sourcemap_index == -1:
            sourcemap = None
        else:
            b64 = text[sourcemap_index:].split(",", maxsplit=1)[1].split("\n", maxsplit=1)[0]
            sourcemap = json.loads(base64.b64decode(b64))

        flags = 1 | (1<<5) # JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY
        self.module = self._js.eval(text, file=bundle, sourcemap=sourcemap, flags=flags)

        if store is None:
            storejs = None
        else:
            ExternalStore = self.module.ExternalStore
            encodeProto = self.module.encodeProto
            if ExternalStore is None or encodeProto is None:
                raise ValueError(
                    "both ExternalStore and encodeProto must be exported by typescript stub "
                    "if a Store is configured (otherwise in-memory store will be used)"
                )
            storejs = _quickjs.make_store(self._js, ExternalStore, encodeProto, store)

        callbacks: dict[str, Any] = {
            "migrate": migrate and self.module[migrate],
            "reducer": self.module[reducer],
        }

        self._engine: _quickjs.Value = self._js.eval(
            "(cls, store, callbacks) => new cls(store, callbacks)",
        )(self.module[engine_cls], storejs, callbacks)

    def new_query[T](self, generator: QueryFunction[QX, T]) -> Query[T]:
        # bind the qx_factory without binding `self`, because that would create
        # an unbroken cyclic gc between languages:
        # - Query object holds queryfunc
        # - queryfunc holds self
        # - self holds QuickJS
        # - QuickJS holds QueryGraph
        # - QueryGraph holds Query
        qx_factory = self._qx_factory

        # queryfunc will wrap the python generator in a javascript iterator
        def queryfunc(jsqx: _quickjs.Value) -> Any:
            g = generator(qx_factory(jsqx))
            first = True

            def nextfunc(val: Any = None) -> Any:
                nonlocal first
                if first:
                    first = False
                    val = None
                try:
                    return {"value": g.send(val), "done": False}

                except StopIteration as e:
                    # javascript will not access our return value
                    # and we will receive it in callbacks totally unmodified
                    return {"value": _quickjs.Opaque(e.value), "done": True}

            return {"next": nextfunc}

        # call javascript engine.newQuery() to get javascript QueryImpl
        _query = self._engine.newQuery(queryfunc, True)

        # wrap javascript query in python wrapper
        query: Query[T] = Query(_query)

        # now run the engine
        self._run()

        return query

    def recv_events(self, events: list[Any]) -> None:
        self._engine.recvEvents(events)
        self._run()

    def fell_behind(self) -> None:
        self._engine.fellBehind()
        self._run()

    def caught_up(self) -> None:
        self._engine.caughtUp()
        self._run()

    def reconnect(self) -> int | None:
        info: ReconnectInfo[C] | None = None

        def on_result(x: ReconnectInfo | None) -> None:
            nonlocal info
            info = x

        self._engine.reconnect(on_result)
        self._run()

        return info.checkpoint if info else None

    def simulate[T](
        self,
        fn: Callable[[Any, list[E]], T],
        undecoded_events: list[Identified[Any]] | None = None,
    ) -> T:
        sentinel = object()
        result: Any = sentinel

        def on_result(r: Any | None) -> None:
            nonlocal result
            result = r

        self._engine.simulate(fn, on_result, undecoded_events)
        self._run()

        assert result is not sentinel
        return cast(T, result)

# helpers for dealing with metadata-wrapped event types

class Identified[T](TypedDict):
    id: str
    data: T

def check_identified(
    val: Any, subchecker: Callable[[Any, str], list[str]], path: str = "<root>",
) -> list[str]:
    if not isinstance(val, dict):
        return [path + f': is a {type(val).__name__}, not json object']
    problems = []
    if 'id' not in val:
        problems += [path + ': missing required key id']
    elif not isinstance((id := val['id']), str):
        problems += [path + f'.id: is a {type(id).__name__}, not a str']
    else:
        try:
            _ = uuid.UUID(id)
        except ValueError:
            problems += [path + '.id: invalid uuid']
    if 'data' not in val:
        problems += [path + ': missing required key data']
    else:
        problems += subchecker(val['data'], path + '.data')

    return problems
