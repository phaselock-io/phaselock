import { buildRegistry, NewHTTPConnector } from '@phaselock/client';
import { TodoEngine, todoEngineSchema, todoReducers } from '@todo-basic/model/ui';

// the dev server proxies the database's routes (vite.config.ts)
const SERVER_URL = window.location.origin;

// the types the Engines convert commands and synced state through, built once
const registry = buildRegistry(todoEngineSchema);

// every Engine here lives as long as the page, or until a hot reload replaces this module
const controller = new AbortController();
import.meta.hot?.dispose(() => controller.abort());

/** An Engine connected to the database, which keeps its state in memory, so every page load syncs
    afresh. */
function connect(): TodoEngine {
  // no forecasters: a command shows in the UI when the database's event for it arrives (the
  // library example forecasts, for optimistic updates)
  return new TodoEngine(null, registry, NewHTTPConnector(SERVER_URL), {
    reducers: { todo: todoReducers },
    signal: controller.signal,
    onError: (err) => console.error('the engine ended:', err),
  });
}

/** the two clients the demo shows side by side, each its own Engine, as two browsers would be */
export const clientA = connect();
export const clientB = connect();
