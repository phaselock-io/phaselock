// What the UI needs from the model: the Engines, their predictors and queries, and the types its
// queries and mutations use.

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
  UserPatronInfo,
} from './model.gen';
export { adminPredictors, userPredictors } from './predictors';
export { adminQueries, userQueries } from './queries';
export { postLibraryMutation } from './model.gen';
// room stuff; for hosting a demo with many rooms
export { parseUser, ROOM_LIFETIME_MS, ROOM_RE } from './rooms';
