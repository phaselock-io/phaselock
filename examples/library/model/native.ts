/* The bundle a native client runs in the JS engine its host embeds: each Engine with its
   predictors, and the declared queries it serves to the app, which calls them by name. */

import {
  AdminEngine,
  type AdminQuery,
  dispatchAdminQuery,
  dispatchUserQuery,
  installEngines,
  LocalAdminQueries,
  LocalUserQueries,
  UserEngine,
  type UserQuery,
} from './model.gen';
import { adminPredictors, userPredictors } from './predictors';
import { adminQueries, userQueries } from './queries';

installEngines({
  UserEngine: {
    create: (transport, options) =>
      new UserEngine(transport, { ...options, predictors: userPredictors }),
    queries: {
      wire: 'UserQuery',
      serve: (engine: UserEngine, call: UserQuery) =>
        dispatchUserQuery(new LocalUserQueries(engine, userQueries), call),
    },
  },
  AdminEngine: {
    create: (transport, options) =>
      new AdminEngine(transport, { ...options, predictors: adminPredictors }),
    queries: {
      wire: 'AdminQuery',
      serve: (engine: AdminEngine, call: AdminQuery) =>
        dispatchAdminQuery(new LocalAdminQueries(engine, adminQueries), call),
    },
  },
});
