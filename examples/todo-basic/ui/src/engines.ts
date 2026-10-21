import { HTTPTransport } from '@phaselock/client';
import { TodoEngine } from '@todo-basic/model/ui';

// the database, under /phaselock, which every Engine here reaches through the dev server's proxy
// (vite.config.ts)
const transport = new HTTPTransport(`${window.location.origin}/phaselock`);

// every Engine here lives as long as the page, or until a hot reload replaces this module
const controller = new AbortController();
import.meta.hot?.dispose(() => controller.abort());

/** connect() returns an Engine that syncs database state to an in-memory store */
function connect(): TodoEngine {
  // this demo has no predictors, so it doesn't do optimistic updates
  return new TodoEngine(transport, {
    // this demo has no users, so every Engine syncs as anonymous
    session: null,
    signal: controller.signal,
    onError: (err) => console.error('the engine ended:', err),
  });
}

/** the two clients the demo shows side by side, each its own Engine, as two browsers would be */
export const clientA = connect();
export const clientB = connect();
