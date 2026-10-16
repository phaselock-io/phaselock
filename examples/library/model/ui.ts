// What the UI needs from the model: the Engines, their reducers, forecasters, and queries, and the
// types its queries and commands use.
export { AdminEngine, UserEngine } from './model.gen';
export type {
  AdminBookInfo,
  AdminEditionInfo,
  AdminEngineQueryTxn,
  ConnectionStatus,
  Notice,
  Patron,
  PatronHold,
  Query,
  QueryFunction,
  UserBookInfo,
  UserEngineQueryTxn,
} from './model.gen';
export { adminForecasters, userForecasters } from './outcomes';
export { adminQueries, userQueries } from './queries';
export { adminReducers, bookReducers, patronReducers } from './reducers';
export { postLibraryCommand } from './model.gen';
// room stuff; for hosting a demo with many rooms
export { parseUser, ROOM_LIFETIME_MS, ROOM_RE, roomReducers } from './rooms';
