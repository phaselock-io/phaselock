/* Room stuff, for hosting the demo with many rooms in one database.  Every visitor gets a room of
   their own, a private copy of the library seeded with the demo's data, and shares it by sharing
   its link.  A room lives for an hour from its creation; then the reaper erases every stream of
   the room, and the next CreateRoom for its id seeds it afresh.

   A user id is `<room>.<id>`, two uuids joined by a dot, which is no separator of the key
   templates, so a signed-in user's room comes from the token the database signed.  A sign-in
   identity is `<room>:<login>`. */

import type { Tick } from '@phaselock/plugins';

import type {
  LibraryDBOutput,
  LibraryDBTxn,
  RoomRegistrySliceReducers,
  RoomSliceReducers,
} from './model.gen';

/** how long a room lives from its creation, before the reaper erases it */
export const ROOM_LIFETIME_MS = 60 * 60 * 1000;

/** a room id, which the UI mints */
export const ROOM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** the user id of a user of a room */
export function userId(room: string, id: string): string {
  return `${room}.${id}`;
}

/** a user id's room and the user's id in it, or null for anything that is not exactly two parts,
    the anonymous principal's null included */
export function parseUser(user: string | null): { room: string; id: string } | null {
  const parts = user?.split('.') ?? [];
  return parts.length === 2 ? { room: parts[0], id: parts[1] } : null;
}

/** a sign-in identity's room and login name, or null for anything that is not exactly two parts */
export function parseIdentity(identity: string): { room: string; login: string } | null {
  const parts = identity.split(':');
  return parts.length === 2 ? { room: parts[0], login: parts[1] } : null;
}

/** the room's own record, which every Engine in the room syncs */
export const roomReducers: RoomSliceReducers = {
  roomCreated: (txn, e) => {
    txn.set.room_created(e.created);
  },
};

/** every room, which the database keeps to know which rooms to reap */
export const roomRegistryReducers: RoomRegistrySliceReducers = {
  roomCreated: (txn, e) => {
    txn.set.room(e.room, e.created);
  },
  roomDeleted: (txn, e) => {
    txn.del.room(e.room);
  },
};

/** The reaper, a cron hook: every room an hour old ends, each of its streams with its history
    erased, so its disk comes back.  A death of a stream that never lived writes nothing. */
export function reapRooms(txn: LibraryDBTxn, tick: Tick): LibraryDBOutput[] {
  const out: LibraryDBOutput[] = [];
  for (const [{ room }, created] of txn.scan.room()) {
    if (tick.now.getTime() - created.getTime() < ROOM_LIFETIME_MS) continue;

    // the room's single streams, and each of its patrons'
    const streams = [`book:${room}`, `admin:${room}`, `login:${room}`, `room:${room}`];
    for (const { patron } of txn.scan.patron({ room }, { keys: true })) {
      streams.push(`patron:${room},${patron}`);
    }
    for (const stream of streams) out.push({ stream, death: true, erase: true });
    out.push({ stream: 'rooms', event: { type: 'room-deleted', room } });
  }
  return out;
}
