// The JS side of the QuickJS host.  Hands the bundle's slots transactions over the natives
// (__pl_get, __pl_scan, __pl_set, __pl_del), which convert every value through the bundle's
// registry under the type the call names, and exposes one entry point per slot on
// globalThis.__host.

globalThis.__host = (function () {
  // the read transaction over global keys that precommit, maySee, and lookup read through
  const rx = {
    get: (key, type) => __pl_get(key, type),
    scan: (req) => __pl_scan(req),
  };

  // a reducer's transaction: its stream's local keys, prefixed here
  function reducerTxn(stream) {
    const prefix = stream + '!';
    return {
      get: (key, type) => __pl_get(prefix + key, type),
      set: (key, type, value) => __pl_set(prefix + key, type, value),
      del: (key) => __pl_del(prefix + key),
      // a pattern over the stream's own keys, resumed and answered with local keys
      scan(req) {
        const pattern = { stream, name: req.name, local: req.local };
        const after = req.after === undefined ? undefined : prefix + req.after;
        const { entries, next } = __pl_scan({ ...req, pattern, after });
        return {
          entries: entries.map(([k, v]) => [k.slice(prefix.length), v]),
          next: next === null ? null : next.slice(prefix.length),
        };
      },
    };
  }

  const bundle = () => globalThis.__bundle;

  return {
    precommit(cmd, principal) {
      const out = bundle().precommit(rx, cmd, principal);
      if (typeof out === 'string') return out;
      if (!Array.isArray(out)) throw new Error('precommit must return a reason or a list');
      return out.map((item) => ({
        stream: item.stream,
        death: item.death === true,
        event: item.death === true ? null : item.event,
      }));
    },
    bootstrap() {
      const seed = bundle().bootstrap;
      const out = [];
      if (!seed) return out;
      seed({
        emit: (stream, event) => out.push({ stream, death: false, event }),
        hashPassword: (plain) => __pl_hash(plain),
        env: (name) => __pl_env(name),
      });
      return out;
    },
    reduce(family, stream, events) {
      const slice = bundle().reducers?.[family];
      if (!slice) return false;
      slice.reducer(reducerTxn(stream), events, stream, false);
      return true;
    },
    maySee: (principal) => bundle().maySee(rx, principal),
    lookup(ident) {
      const r = bundle().lookup(rx, ident);
      return r == null ? null : r;
    },
    generation(principal) {
      const r = bundle().lookup(rx, { kind: 'token', user: principal.user, traits: principal.traits });
      return r == null ? -1 : (r.generation ?? 0);
    },
  };
})();
