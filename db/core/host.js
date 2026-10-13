// The JS side of the QuickJS host.  Hands the bundle's slots transactions over the natives
// (__pl_get, __pl_scan, __pl_set, __pl_del), which convert every value through the bundle's
// registry under the type the call names, installs crypto over __pl_random, and exposes one
// entry point per slot, and per plugin command the core makes, on globalThis.__host.

// the Web Crypto randomness a bundle may use, over the kernel's CSPRNG
globalThis.crypto = {
  getRandomValues(array) {
    const bytes = new Uint8Array(__pl_random(array.byteLength));
    new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes);
    return array;
  },
  randomUUID() {
    // 128 random bits, marked as RFC 9562 version 4, in hex grouped 8-4-4-4-12
    const b = new Uint8Array(__pl_random(16));
    b[6] = 0x40 | (b[6] & 0x0f);
    b[8] = 0x80 | (b[8] & 0x3f);
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const group = (from, to) => hex.slice(from, to);
    return [group(0, 8), group(8, 12), group(12, 16), group(16, 20), group(20, 32)].join('-');
  },
};

globalThis.__host = (function () {
  // the outputs plugin requests emit during one call into the bundle, in call order
  let emitted = [];

  // the read transaction over global keys that precommit, maySee, and lookup read through, which
  // also takes what a plugin request emits
  const rx = {
    get: (key, type) => __pl_get(key, type),
    scan: (req) => __pl_scan(req),
    emit(outputs) {
      for (const output of outputs) emitted.push(output);
    },
  };

  // run a slot that requests nothing, as maySee and lookup, where a plugin request is a bug
  function withoutRequests(slot, fn) {
    try {
      const out = fn();
      if (emitted.length > 0) throw new Error(`${slot} made a plugin request`);
      return out;
    } finally {
      emitted = [];
    }
  }

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

  // outputs as the core reads them
  const items = (outputs) =>
    outputs.map((item) => ({
      stream: item.stream,
      death: item.death === true,
      erase: item.death === true && item.erase === true,
      event: item.death === true ? null : item.event,
    }));

  return {
    precommit(data, principal) {
      // the handler's outputs, after what its plugin requests emitted while it ran; a rejection or
      // a throw drops them all
      let out;
      let requests;
      try {
        out = bundle().precommit(rx, data, principal);
        requests = emitted;
      } finally {
        emitted = [];
      }
      if (typeof out === 'string') return out;
      if (!Array.isArray(out)) throw new Error('precommit must return a reason or a list');
      return items([...requests, ...out]);
    },
    // every entry of every cron install, as [install, entry, spec], in install and entry order
    cronEntries() {
      const out = [];
      for (const [install, plugin] of Object.entries(bundle().plugins)) {
        if (plugin.kind !== 'cron') continue;
        for (const e of plugin.config.entries) out.push([install, e.name, e.spec]);
      }
      return out;
    },
    // A cron entry's tick, as its install's command: what the plugin emitted while it ran, its
    // hook's outputs among them, then what it returned.  A throw drops them all.
    tick(install, entry, slot, now) {
      const cmd = { entry, slot: new Date(slot), now: new Date(now) };
      let out;
      let emits;
      try {
        out = bundle().plugins[install].run(rx, cmd);
        emits = emitted;
      } finally {
        emitted = [];
      }
      if (!Array.isArray(out)) throw new Error(`plugin ${install} must return a list`);
      return items([...emits, ...out]);
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
    maySee: (principal) => withoutRequests('maySee', () => bundle().maySee(rx, principal)),
    lookup(ident) {
      const r = withoutRequests('lookup', () => bundle().lookup(rx, ident));
      return r == null ? null : r;
    },
    generation(principal) {
      const ident = { kind: 'token', user: principal.user };
      const r = withoutRequests('lookup', () => bundle().lookup(rx, ident));
      return r == null ? -1 : (r.generation ?? 0);
    },
  };
})();
