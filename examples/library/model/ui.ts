// What the UI needs from the model: the Engines, their reducers, forecasters, and queries, and the
// types its queries and commands use.

import type { AdminEngineForecasters, UserEngineForecasters } from './model.gen';
import { outcomes } from './outcomes';

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
export { adminQueries, userQueries } from './queries';
export { adminReducers, bookReducers, patronReducers } from './reducers';
export { postLibraryCommand } from './model.gen';
// room stuff; for hosting a demo with many rooms
export { parseUser, ROOM_LIFETIME_MS, ROOM_RE, roomReducers } from './rooms';

/** a patron's forecasts: every command they send, as the database will most likely decide it */
export const userForecasters: UserEngineForecasters = {
  renamePatron: outcomes.renamePatron,
  tryHold: outcomes.tryHold,
  cancelHold: (txn, cmd) => outcomes.cancelHold(txn, cmd, false),
  patronDismissNotice: outcomes.patronDismissNotice,
};

/** the librarians' forecasts, which cover every command they send */
export const adminForecasters: AdminEngineForecasters = {
  ...userForecasters,
  // a librarian cancels a hold for its patron
  cancelHold: (txn, cmd) => outcomes.cancelHold(txn, cmd, true),
  addEdition: outcomes.addEdition,
  updateEditionTitle: outcomes.updateEditionTitle,
  addBook: outcomes.addBook,
  updateBookRestricted: outcomes.updateBookRestricted,
  removeBook: outcomes.removeBook,
  assignPatron: outcomes.assignPatron,
  tryCheckout: outcomes.tryCheckout,
  endCheckout: outcomes.endCheckout,
  dismissNotice: outcomes.dismissNotice,
};
