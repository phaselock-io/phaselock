import {
  AdminEngine,
  adminForecasters,
  adminReducers,
  bookReducers,
  parseUser,
  patronReducers,
  postLibraryCommand,
  ROOM_RE,
  roomReducers,
  UserEngine,
  userForecasters,
} from '@library/model/ui';
import {
  AuthError,
  type Connection,
  type ConnectionHooks,
  HTTPTransport,
  type Session,
  type Signal,
  type Transport,
} from '@phaselock/client';

// the database, which every Engine here reaches through the dev server's proxy (vite.config.ts)
const http = new HTTPTransport(window.location.origin);

// every Engine here lives as long as the page, or until a hot reload replaces this module
const controller = new AbortController();
import.meta.hot?.dispose(() => controller.abort());

/** A window's own way to the database, with a switch that takes it offline as a dropped network
    would: the live connection ends, every attempt after it fails at once, and the Engine queues
    its commands and retries until the switch is on again. */
export class SwitchedTransport implements Transport {
  #online = true;
  // ends each live connection when the switch goes off
  #cut = new AbortController();

  get online(): boolean {
    return this.#online;
  }

  set online(on: boolean) {
    this.#online = on;
    if (on) return;
    this.#cut.abort();
    this.#cut = new AbortController();
  }

  buildRegistry: Transport['buildRegistry'] = (schema) => http.buildRegistry(schema);

  connect(
    since: number,
    view: string | null,
    wants: string[],
    signal: Signal,
    hooks: ConnectionHooks,
    session: Session | null,
  ): Connection {
    // offline, the attempt ends as soon as it starts
    if (!this.#online) {
      setTimeout(() => hooks.onEnd(0, 'offline'));
      const offline = () => Promise.reject(new Error('offline'));
      return { backfill: offline, sendCommands: offline };
    }

    // online, the connection lasts until the Engine ends it or the switch goes off
    const lifetime = AbortSignal.any([signal as AbortSignal, this.#cut.signal]);
    return http.connect(since, view, wants, lifetime, hooks, session);
  }

  post: Transport['post'] = (commands, session) => {
    if (!this.#online) return Promise.reject(new Error('offline'));
    return http.post(commands, session);
  };
}

// room stuff; for hosting a demo with many rooms

/* The room in the page's URL, `/<room>`.  A page without one mints a room and puts it in the URL,
   replacing the bare address, so Back does not mint another and the link a visitor shares is the
   room. */
function pageRoom(): { room: string; minted: boolean } {
  const path = window.location.pathname.slice(1);
  if (ROOM_RE.test(path)) return { room: path, minted: false };
  return { room: crypto.randomUUID(), minted: true };
}

/** the room every window here is in */
export const { room, minted } = pageRoom();

// the room exists before anyone signs in to it; for a room that exists, CreateRoom writes nothing
const created = await postLibraryCommand(http, { type: 'create-room', room });
if (created.kind !== 'ok') throw new Error(`the room was not created: ${JSON.stringify(created)}`);
if (minted) history.replaceState(null, '', `/${room}`);

/** a command without its room, which the window sending it names */
export type Unroomed<C> = C extends unknown ? Omit<C, 'room'> : never;

/** one window's Engine, the switch on its way to the database, and who it is signed in as */
export type Client<E> = { engine: E; transport: SwitchedTransport; room: string; user: string };

/* Every seeded login's password is `password` (see the seed in the model's bundle), so each window
   signs itself in rather than asking. */
function signIn(login: string): Promise<Session> {
  return http.login({ kind: 'password', identity: `${room}:${login}`, password: 'password' });
}

function onError(err: unknown) {
  // a room an hour old is erased, which refuses its tokens; a reload creates the room afresh
  if (err instanceof AuthError) {
    window.location.reload();
    return;
  }
  console.error('the engine ended:', err);
}

// the user id's own half, the patron's id for a patron
function userOf(session: Session): string {
  const user = parseUser(session.user);
  if (user === null) throw new Error('a session for a user outside any room');
  return user.id;
}

function patron(session: Session): Client<UserEngine> {
  const transport = new SwitchedTransport();
  const engine = new UserEngine(transport, {
    session,
    reducers: { book: bookReducers, patron: patronReducers, room: roomReducers },
    forecasters: userForecasters,
    signal: controller.signal,
    onError,
  });
  return { engine, transport, room, user: userOf(session) };
}

function librarian(session: Session): Client<AdminEngine> {
  const transport = new SwitchedTransport();
  const engine = new AdminEngine(transport, {
    session,
    reducers: {
      book: bookReducers,
      patron: patronReducers,
      admin: adminReducers,
      room: roomReducers,
    },
    forecasters: adminForecasters,
    signal: controller.signal,
    onError,
  });
  return { engine, transport, room, user: userOf(session) };
}

const [adminSession, aliceSession, bobSession] = await Promise.all([
  signIn('admin'),
  signIn('alice'),
  signIn('bob'),
]);

/** the windows the demo shows side by side, each signed in as its own user, as three browsers
    would be */
export const admin = librarian(adminSession);
export const alice = patron(aliceSession);
export const bob = patron(bobSession);

// room stuff: the reaper erases a room's own record with the rest of the room, which open
// connections see, so a reload creates the room afresh
let roomSeen = false;
admin.engine
  .newQuery((qx) => qx.get.room_created(room))
  .subscribe((created) => {
    if (created !== undefined) roomSeen = true;
    else if (roomSeen) window.location.reload();
  });
