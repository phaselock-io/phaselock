// The JS half of the native host, which runs before the model's native bundle.  It installs what
// the Engine needs of its host (timers, AbortController, randomness), and it adapts the Kotlin
// side to the Engine's contracts: a Transport whose every call becomes an event for Kotlin, a
// Store over the native LMDB store, and a Registry over the native conversion kernel.
//
// The natives are on `__pl`.  Everything Kotlin delivers arrives through `__host`, whose methods
// the native host calls by name.  Kotlin holds numbers, never JS values: every connection,
// backfill, send, push, engine, and query is an id in a table here.

'use strict';

(() => {
  const pl = globalThis.__pl;

  // the skeleton's representations
  const JS = 1;
  const MSGPACK = 3;

  // an event for Kotlin, which the native host hands over when the call that raised it returns
  const emit = (...event) => pl.emit(event);

  // what an error says, with its stack when it has one
  function describe(e) {
    if (e instanceof Error) return e.stack ? `${e.name}: ${e.message}\n${e.stack}` : `${e.name}: ${e.message}`;
    return String(e);
  }

  // a Uint8Array's own bytes as an ArrayBuffer, which the natives take as bin
  function buffer(u8) {
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  // the host's globals //////////////////////////////////////////////////////

  globalThis.console = {
    log: (...args) => pl.log(args.map((a) => (typeof a === 'string' ? a : describe(a))).join(' ')),
  };
  globalThis.console.error = globalThis.console.log;
  globalThis.console.warn = globalThis.console.log;

  if (typeof globalThis.process === 'undefined') {
    globalThis.process = { env: { NODE_ENV: 'production' } };
  }

  // timers, by id: the native host keeps their deadlines and fires each through __host.fire
  const timers = new Map();
  let nextTimer = 1;
  globalThis.setTimeout = (fn, ms = 0) => {
    const id = nextTimer++;
    timers.set(id, fn);
    pl.timer(id, Math.max(0, Number(ms) || 0));
    return id;
  };
  globalThis.clearTimeout = (id) => {
    if (timers.delete(id)) pl.clearTimer(id);
  };

  // signals fire their listeners synchronously when aborted, as a browser's do
  class Signal {
    constructor() {
      this.aborted = false;
      this.reason = undefined;
      this.listeners = [];
    }
    addEventListener(type, fn) {
      if (type === 'abort' && !this.aborted) this.listeners.push(fn);
    }
    removeEventListener(_type, fn) {
      this.listeners = this.listeners.filter((l) => l !== fn);
    }
    fire(reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason;
      const listeners = this.listeners;
      this.listeners = [];
      for (const l of listeners) l();
    }
    static any(signals) {
      const s = new Signal();
      for (const each of signals) {
        if (each.aborted) {
          s.fire(each.reason);
          return s;
        }
      }
      for (const each of signals) each.addEventListener('abort', () => s.fire(each.reason));
      return s;
    }
  }
  globalThis.AbortSignal = Signal;
  globalThis.AbortController = class {
    constructor() {
      this.signal = new Signal();
    }
    abort(reason = new Error('aborted')) {
      this.signal.fire(reason);
    }
  };

  globalThis.crypto = {
    getRandomValues(bytes) {
      bytes.set(new Uint8Array(pl.random(bytes.length)));
      return bytes;
    },
  };

  // the registry and the store /////////////////////////////////////////////

  // each schema's Registry over the native kernel, compiled once
  const registries = new Map();
  function registryOf(schema) {
    let reg = registries.get(schema);
    if (reg === undefined) {
      const id = pl.registry(schema);
      reg = {
        id,
        mutations: schema.mutations ?? '',
        convert: (type, value, from, to) => pl.convert(id, type, value, from, to),
        ops: (bytes, edit) => pl.ops(bytes, edit),
      };
      registries.set(schema, reg);
    }
    return reg;
  }

  // The Store over a native LMDB store: each transaction commits when its function returns and
  // aborts when it throws.  A read transaction offers the read half alone.
  function nativeStore(store, reg) {
    function run(writable, fn) {
      const t = pl.begin(store, reg.id, writable);
      const txn = {
        get: (key, type, rep) => pl.get(t, key, type, rep),
        scan: (req) => pl.scan(t, req),
      };
      if (writable) {
        txn.set = (key, type, rep, value) => pl.set(t, key, type, rep, value);
        txn.del = (key) => pl.del(t, key);
        txn.delPrefix = (prefix) => pl.delPrefix(t, prefix);
        txn.applyEdits = (edits) => pl.applyEdits(t, edits);
        txn.applyParked = (slice, fromSeq) => pl.applyParked(t, slice, fromSeq);
        txn.applySnapshot = (selector, skip) => pl.applySnapshot(t, selector, skip);
      }
      let result;
      try {
        result = fn(txn);
      } catch (e) {
        pl.abort(t);
        throw e;
      }
      pl.commit(t);
      return result;
    }
    return { write: (fn) => run(true, fn), read: (fn) => run(false, fn) };
  }

  // the transport ///////////////////////////////////////////////////////////

  // the live calls Kotlin answers, by id
  const connections = new Map();
  const backfills = new Map();
  const sends = new Map();
  let nextConnection = 1;
  let nextBackfill = 1;
  let nextSend = 1;

  /* The Transport an engine is built over.  connect, backfill, and sendMutations each become an
     event for Kotlin, which answers through __host; an abort becomes one too.  Kotlin settles
     every backfill and send it was handed, an aborted one included. */
  function transportFor(hosted) {
    return {
      buildRegistry(schema) {
        hosted.reg = registryOf(schema);
        return hosted.reg;
      },
      connect(since, view, wants, signal, hooks, session) {
        const id = nextConnection++;
        connections.set(id, hooks);
        signal.addEventListener('abort', () => {
          if (connections.has(id)) emit('abortConnection', id);
        });
        emit('connect', hosted.id, id, since, view, wants, session === null ? null : session.handle);
        return {
          backfill(b) {
            return new Promise((resolve, reject) => {
              const bid = nextBackfill++;
              backfills.set(bid, { b, resolve, reject });
              b.signal.addEventListener('abort', () => {
                if (backfills.has(bid)) emit('abortBackfill', bid);
              });
              emit('backfill', id, bid, b.selector, b.until, b.resume);
            });
          },
          sendMutations(mutations) {
            return new Promise((resolve, reject) => {
              const sid = nextSend++;
              sends.set(sid, { resolve, reject });
              const wire = mutations.map((m) => [m.series, m.n, m.id, buffer(m.data)]);
              emit('send', id, sid, wire);
            });
          },
        };
      },
      post: () => Promise.reject(new Error('the Engine never posts')),
    };
  }

  // engines and queries /////////////////////////////////////////////////////

  // the engines by id: each its Engine, its bundle entry, the controller that ends it, and the
  // Registry it built
  const engines = new Map();
  // the open queries by id
  const queries = new Map();

  function engineOf(id) {
    const e = engines.get(id);
    if (e === undefined) throw new Error(`no engine ${id}`);
    return e;
  }

  // a query's results as events, each encoded by encode
  function serve(id, query, encode) {
    queries.set(id, query);
    query.subscribe((value) => {
      let bytes;
      try {
        bytes = encode(value);
      } catch (e) {
        emit('queryFailed', id, describe(e));
        return;
      }
      emit('queryResult', id, bytes);
    });
  }

  // what Kotlin calls //////////////////////////////////////////////////////

  globalThis.__host = {
    fire(id) {
      const fn = timers.get(id);
      if (fn === undefined) return;
      timers.delete(id);
      fn();
    },

    createEngine(id, name, session, store) {
      const entry = globalThis.__engines?.[name];
      if (entry === undefined) throw new Error(`the native bundle has no engine ${name}`);
      const hosted = { id, entry, reg: null, controller: new AbortController(), engine: null };
      engines.set(id, hosted);
      hosted.engine = entry.create(transportFor(hosted), {
        session: session === null ? null : { handle: session },
        store: store === null ? undefined : (reg) => nativeStore(store, reg),
        signal: hosted.controller.signal,
        onError: (e) => emit('ended', id, describe(e), e?.name === 'AuthError'),
      });
    },

    closeEngine(id) {
      const hosted = engines.get(id);
      if (hosted === undefined) return;
      engines.delete(id);
      hosted.controller.abort();
    },

    reconnectNow(id) {
      engineOf(id).engine.reconnectNow();
    },

    sendMutation(id, bytes) {
      const { engine, reg } = engineOf(id);
      engine.sendMutation(reg.convert(reg.mutations, bytes, MSGPACK, JS));
    },

    sendOnlineMutation(id, call, bytes) {
      const { engine, reg } = engineOf(id);
      engine.sendOnlineMutation(reg.convert(reg.mutations, bytes, MSGPACK, JS)).then(
        (result) => emit('onlineSettled', call, result, null),
        (e) => emit('onlineSettled', call, null, describe(e)),
      );
    },

    // a declared query, its call converted under the queries' wire type and each result under
    // the query's id plus #result
    query(id, engineId, bytes) {
      const { engine, entry, reg } = engineOf(engineId);
      if (entry.queries === undefined) throw new Error('the engine serves no declared queries');
      const call = reg.convert(entry.queries.wire, bytes, MSGPACK, JS);
      const resultType = `${call[0]}#result`;
      const query = entry.queries.serve(engine, call);
      serve(id, query, (value) => buffer(reg.convert(resultType, value, JS, MSGPACK)));
    },

    // the Engine's status, every part of it as one plain value, its dates in epoch milliseconds
    statusQuery(id, engineId) {
      const { engine } = engineOf(engineId);
      const ms = (date) => (date === null ? null : date.getTime());
      const query = engine.newQuery((qx) => {
        const connection = qx.status.connection();
        const progress = qx.status.progress();
        return {
          connection: { ...connection, nextAttemptAt: ms(connection.nextAttemptAt) },
          progress: {
            ...progress,
            backfills: progress.backfills.map((b) => ({ ...b, retryAt: ms(b.retryAt) })),
          },
          outbox: qx.status.outbox(),
        };
      });
      serve(id, query, (value) => pl.encode(value));
    },

    closeQuery(id) {
      const query = queries.get(id);
      if (query === undefined) return;
      queries.delete(id);
      query.close();
    },

    // a connection's hooks; one that has ended hears nothing more
    connOpen(id, epoch, head) {
      connections.get(id)?.onOpen(epoch, head);
    },
    connView(id, token, position, selectors) {
      connections.get(id)?.onView(token, position, selectors);
    },
    connEdits(id, edits) {
      connections.get(id)?.onEdits(edits);
    },
    connLive(id, position) {
      connections.get(id)?.onLive(position);
    },
    connVouch(id, position) {
      connections.get(id)?.onVouch(position);
    },
    connEnd(id, code, reason, fatal) {
      const hooks = connections.get(id);
      if (hooks === undefined) return;
      connections.delete(id);
      let err;
      if (fatal !== null) {
        err = new Error(fatal);
        err.name = 'AuthError';
        err.status = code;
      }
      hooks.onEnd(code, reason, err);
    },

    // one delivery of a backfill, settled for Kotlin once the Engine has committed it
    push(id, push, item) {
      const call = backfills.get(id);
      if (call === undefined) {
        emit('pushSettled', push, 'the backfill has ended');
        return;
      }
      call.b.push(item).then(
        () => emit('pushSettled', push, null),
        (e) => emit('pushSettled', push, describe(e)),
      );
    },
    backfillSettled(id, outcome, error) {
      const call = backfills.get(id);
      if (call === undefined) return;
      backfills.delete(id);
      if (error === null) call.resolve(outcome);
      else call.reject(new Error(error));
    },

    // the outcomes of a send, as /mutations answers them, or why it failed
    sendSettled(id, outcomes, error) {
      const call = sends.get(id);
      if (call === undefined) return;
      sends.delete(id);
      if (error !== null) {
        call.reject(new Error(error));
        return;
      }
      call.resolve(
        outcomes.map(([kind, v]) => {
          switch (kind) {
            case 'ok':
              return { kind, position: v };
            case 'reject':
              return { kind, reason: v };
            case 'conflict':
              return { kind, current: v };
            default:
              throw new Error(`unknown mutation outcome ${kind}`);
          }
        }),
      );
    },
  };
})();
