import {
  AdminEngine,
  adminForecasters,
  adminReducers,
  bookReducers,
  patronReducers,
  UserEngine,
  userForecasters,
} from '@library/model/ui';
import {
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

/** one window's Engine and the switch on its way to the database */
export type Client<E> = { engine: E; transport: SwitchedTransport };

/* Every seeded login's password is `password` (see the bundle's bootstrap in the model), so each
   window signs itself in rather than asking. */
function signIn(login: string): Promise<Session> {
  return http.login({ kind: 'password', identity: login, password: 'password' });
}

function onError(err: unknown) {
  console.error('the engine ended:', err);
}

function patron(session: Session): Client<UserEngine> {
  const transport = new SwitchedTransport();
  const engine = new UserEngine(transport, {
    session,
    reducers: { book: bookReducers, patron: patronReducers },
    forecasters: userForecasters,
    signal: controller.signal,
    onError,
  });
  return { engine, transport };
}

function librarian(session: Session): Client<AdminEngine> {
  const transport = new SwitchedTransport();
  const engine = new AdminEngine(transport, {
    session,
    reducers: { book: bookReducers, patron: patronReducers, admin: adminReducers },
    forecasters: adminForecasters,
    signal: controller.signal,
    onError,
  });
  return { engine, transport };
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
