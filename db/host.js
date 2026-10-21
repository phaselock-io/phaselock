// The JS side of the QuickJS host.  Binds the bundle's contexts, once, to a transaction over the
// natives (__pl_get, __pl_scan, __pl_set, __pl_del, __pl_delete_slice), which convert every value
// through the bundle's registry under the type the call names and read through the write buffer
// of the call running, installs crypto over __pl_random, and exposes one entry point per slot,
// and per plugin mutation the core makes, on globalThis.__host.

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
  // The transaction every slot runs over, whichever call is running: its natives read and write
  // through that call's write buffer, which the core keeps as the mutation's edits, and refuse a
  // write from a call that only reads.
  const txn = {
    get: (key, type) => __pl_get(key, type),
    scan: (req) => __pl_scan(req),
    set: (key, type, value) => __pl_set(key, type, value),
    del: (key) => __pl_del(key),
    deleteSlice: (slice, erase) => __pl_delete_slice(slice, erase === true),
  };

  const bundle = () => globalThis.__bundle;

  return {
    // bind the bundle's contexts to the transaction, once, after the bundle is evaluated
    load() {
      bundle().bindWrite(txn);
      bundle().bindRead(txn);
    },
    // null when decide carried the mutation out, or the reason it rejected it
    decide: (data, principal) => bundle().decide(data, principal),
    // every entry of every cron install, as [install, entry, spec], in install and entry order
    cronEntries() {
      const out = [];
      for (const [install, plugin] of Object.entries(bundle().plugins)) {
        if (plugin.kind !== 'cron') continue;
        for (const e of plugin.config.entries) out.push([install, e.name, e.spec]);
      }
      return out;
    },
    // a cron entry's tick, as its install's mutation
    tick(install, entry, slot, now) {
      const mutation = { entry, slot: new Date(slot), now: new Date(now) };
      bundle().plugins[install].run(mutation);
    },
    bootstrap() {
      const seed = bundle().bootstrap;
      if (!seed) return;
      seed({
        hashPassword: (plain) => __pl_hash(plain),
        env: (name) => __pl_env(name),
      });
    },
    grant: (principal) => bundle().grant(principal),
    lookup(ident) {
      const r = bundle().lookup(ident);
      return r == null ? null : r;
    },
    generation(principal) {
      const r = bundle().lookup({ kind: 'token', user: principal.user });
      return r == null ? -1 : (r.generation ?? 0);
    },
    // the password hash lookup answers for a principal's token, or null for none
    passwordHash(principal) {
      if (principal.user === null) return null;
      const r = bundle().lookup({ kind: 'token', user: principal.user });
      if (r == null || r.passwordHash == null) return null;
      if (typeof r.passwordHash !== 'string') {
        throw new Error('lookup answered a passwordHash that is not a string');
      }
      return r.passwordHash;
    },
  };
})();
