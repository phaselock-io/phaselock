import { jsonEvent, KurrentDBClient, START, STREAM_NAME } from '@kurrent/kurrentdb-client';
import type { AllStreamResolvedEvent, AllStreamSubscription } from '@kurrent/kurrentdb-client';
import { checkTodoEvents } from '@todo-basic/model/server';
import { WebSocket, WebSocketServer } from 'ws';
import type { MessageEvent } from 'ws';

// assume all events go into one stream
const TODO_STREAM = 'todo';
// only one event type in this demo
const EVENT_TYPE = 'TodoEvents';
// what we listen on
const LISTEN_PORT = 3001;
const KURRENT_CONNECTION_STRING = 'kurrentdb://admin:changeit@localhost:2113?tls=false';

function handleWebsocketConnection(client: KurrentDBClient, socket: WebSocket) {
  let subscription: AllStreamSubscription;

  // one close function to close everything and log the reason
  let dead = false;
  const closeConnection = (event: string, ...args: any[]) => {
    if (dead) return;
    dead = true;
    console.log(`on ${event}:`, ...args);
    socket.close();
    subscription?.unsubscribe();
  };

  // a helper to wrap non-error event handlers with try/catch
  const catchErrors = (event: string, fn: () => void) => {
    if (dead) return;
    try {
      fn();
    } catch (e: unknown) {
      closeConnection(event, e);
    }
  };

  socket.on('error', (e) => closeConnection('error', `websocket died: ${e}`));

  // if client can't keep up with KurrentDB, pause subscriptions to not fill up memory
  let nQueued = 0;
  const queueLimit = 64;
  let paused = false;
  const socketSend = (data: string, options?: any) =>
    catchErrors('socketSend', () => {
      if (++nQueued > queueLimit) {
        if (!paused) {
          subscription.pause();
          paused = true;
        }
      }
      socket.send(data, options, () => {
        if (--nQueued < queueLimit / 2) {
          if (paused) {
            subscription.resume();
            paused = false;
          }
        }
      });
    });

  // the first received message is a handshake which sets everything up
  socket.once('message', (ev: MessageEvent) =>
    catchErrors('message', () => {
      const msg = JSON.parse(ev as any);
      if (!msg || typeof msg !== 'object') {
        closeConnection('message', 'bad handshake');
        return;
      }

      // handshake is complete, install the command handler
      socket.on('message', (ev: MessageEvent) =>
        catchErrors('message', () => {
          const msg = JSON.parse(ev as any);

          // validate command wrapper
          if (!msg || typeof msg !== 'object' || typeof msg.id != 'string') {
            closeConnection('message', 'bad command');
            return;
          }

          // validate command body
          const errs = checkTodoEvents(msg.data);
          if (errs.length > 0) {
            closeConnection('message', `invalid command: ${errs.join(', ')}`);
            return;
          }

          // append to event stream
          const event = jsonEvent({
            type: EVENT_TYPE,
            id: msg.id,
            data: msg.data,
          });
          client.appendToStream(TODO_STREAM, [event]);
        }),
      );

      // configure our subscription
      const since = msg.since;
      subscription = client.subscribeToAll({
        fromPosition: since ? { commit: since, prepare: since } : START,
        resolveLinkTos: true,
        filter: {
          filterOn: STREAM_NAME,
          prefixes: ['todo'],
          checkpointInterval: 1000,
        },
      });

      subscription.on('error', (e) => closeConnection('sub error', 'subscription died:', e));

      subscription.on('end', () => closeConnection('sub end', 'unexpected subscription EOF'));

      subscription.once('caughtUp', () =>
        catchErrors('sub caughtUp', () => {
          socketSend('caughtup');
        }),
      );

      subscription.on('data', (ev: AllStreamResolvedEvent) =>
        catchErrors('sub data', () => {
          // de-dupe: KurrentDB redelivers the event at `since`
          const position = Number(ev.commitPosition);
          if (position === since) return;
          socketSend(
            JSON.stringify({
              position: position,
              id: ev.event!.id,
              data: ev.event!.data,
            }),
          );
        }),
      );
    }),
  );
}

function main() {
  // assume non-tls, connecting to localhost, with default creds
  const client = KurrentDBClient.connectionString`${KURRENT_CONNECTION_STRING}`;

  // start a websocket server
  const server = new WebSocketServer({ port: LISTEN_PORT });

  server.on('connection', (socket) => handleWebsocketConnection(client, socket));

  console.log(`todo-basic server is listening on ${LISTEN_PORT}`);
}

main();
