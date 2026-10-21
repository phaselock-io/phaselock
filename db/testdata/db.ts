// The bundle the server tests run: the test model's deciders, grantor, lookup, and bootstrap.

import { Cron, type CronPlugin } from '@phaselock/plugins';
import {
  type DbMarker,
  type DbTypes,
  defineTestDB,
  type PluginInstall,
  type Principal,
  type ReadTxn,
  Reject,
  type TestDBDeciders,
  type TestDBReadTxn,
  type TestDBTxn,
  type TestDBTypes,
  type WriteTxn,
} from './model.gen.ts';

// the database's randomness, which the host installs
declare const crypto: { randomUUID(): string };

/* The users the tests sign in as without creating an account first.  root is an admin, and r1 is
   audited: its every grant run changes its view, so a test sees each run as a view frame. */
const TEST_USERS = ['root', 'p1', 'r1', 'requester', 'raw-requester', 'flaky'];
const ROOT = 'root';
const AUDITED = 'r1';
// a user whose grant writes, which a grantor, reading only, may not
const WRITER = 'requester';
// a user whose lookup answers a different password hash on every read, which is lookup's bug
const FLAKY = 'flaky';

/* A user whose grant, and an identity whose lookup, write through the raw transaction plugins are
   bound to, which the wrapper at the end of this file holds.  Those writes pass the bundle's
   read-only context, so only the database's own check refuses them. */
const RAW_WRITER = 'raw-requester';
const RAW_LOOKUP = 'raw-lookup';
let writeTxn: WriteTxn | undefined;

// whether the principal is root or an account flagged admin
const isAdmin = (txn: TestDBReadTxn, p: Principal): boolean =>
  p.user === ROOT || (p.user !== null && txn.get.account(p.user)?.admin === true);
const isSelf = (p: Principal, user: string): boolean => p.user !== null && p.user === user;

// scans //

/* The deciders scan through their typed contexts.  The grantor scans through the raw ReadTxn the
   database binds the read context to, which the wrapper at the end of this file holds, one entry
   per batch: every batch after the first resumes from the key the last one ended with, so the
   grantor's read-set spans many batches of one walk. */
let readTxn: ReadTxn | undefined;

// the keys of every shelf that lends to a patron, fetched a batch of one at a time
function lendsTo(patron: string): string[] {
  const keys: string[] = [];
  let after: string | undefined;
  for (;;) {
    const { entries, next } = readTxn!.scan({
      pattern: {
        slice: { family: 'shelf', params: [null] },
        name: 'lend',
        local: [{ eq: patron }],
      },
      type: false,
      after,
      limit: 1,
    });
    for (const [key] of entries) keys.push(key);
    if (next === null) return keys;
    after = next;
  }
}

// the count of the grantor's runs for audited principals
let auditedRuns = 0;

// plugins //

/* A plugin's install as its package would ship one, written out by hand.  Its one request adds a
   reason to a patron's messages, through the transaction it is bound to, standing in for the
   writes to a slice of its own that a plugin's requests make.  The reason "stray" writes instead
   to a patron key that no key template names, which lands as inert bytes.  A reason "set {key}"
   writes the key it names as it stands, and "delete {slice}" deletes the slice it names, so a
   test hands the write gate any key or slice name. */
type NoticePlugin = PluginInstall<{
  post(patron: string, reason: string): void;
}>;

function installNotice<DB extends DbTypes>(): NoticePlugin & DbMarker<DB> {
  return {
    kind: 'notice',
    create(name) {
      let raw: WriteTxn | undefined;
      return {
        name,
        api: {
          post(patron, reason) {
            if (reason === 'stray') {
              raw!.set(`patron:${patron}!stray`, 'patron/messages', [reason]);
              return;
            }
            if (reason.startsWith('set ')) {
              raw!.set(reason.slice('set '.length), 'patron/messages', [reason]);
              return;
            }
            if (reason.startsWith('delete ')) {
              raw!.deleteSlice(reason.slice('delete '.length), false);
              return;
            }
            const key = `patron:${patron}!messages`;
            const messages = (raw!.get(key, 'patron/messages') as string[] | undefined) ?? [];
            messages.push(reason);
            raw!.set(key, 'patron/messages', messages);
          },
        },
        bind(txn) {
          raw = txn;
        },
      };
    },
    db: (db) => db,
  };
}

/* The cron entries, which tests tick directly; their yearly specs keep the real schedule out of
   every test.  reap notes its tick to patron p1, behind a notice request, once p1 exists; zoned
   has a zone; broken throws. */
const cron = Cron.install<TestDBTypes<TestPlugins>>({
  reap: {
    spec: '0 0 1 1 *',
    hook: (txn, tick) => {
      if (txn.get.patron('p1') === undefined) return;
      txn.notice.post('p1', `requested ${tick.slot.toISOString()}`);
      const reason = `${tick.name} ${tick.slot.toISOString()} ${tick.now.toISOString()}`;
      txn.update.messages('p1', (messages) => {
        messages.push(reason);
      });
    },
  },
  zoned: { spec: 'CRON_TZ=America/New_York 0 0 1 1 *', hook: () => {} },
  broken: {
    spec: '0 0 1 1 *',
    hook: () => {
      throw new Error('the broken entry');
    },
  },
});

type TestPlugins = { notice: NoticePlugin; cron: CronPlugin };

// deciders //

function requirePatron(txn: TestDBReadTxn, id: string): void {
  if (txn.get.patron(id) === undefined) throw new Reject('no such patron');
}

function requireAccount(txn: TestDBReadTxn, user: string): void {
  if (txn.get.account(user) === undefined) throw new Reject('no such account');
}

// a patron's keys as they start
function seedPatron(txn: TestDBTxn, id: string, name: string): void {
  txn.set.patron(id, { id, name });
  txn.set.holds(id, {});
  txn.set.messages(id, []);
}

const deciders: TestDBDeciders<TestPlugins> = {
  addBook: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    if (txn.get.book(m.id) !== undefined) throw new Reject('book exists');
    txn.set.book(m.id, { id: m.id, title: m.title, added: m.added });
  },
  addPatron: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    if (txn.get.patron(m.id) !== undefined) throw new Reject('patron exists');
    seedPatron(txn, m.id, m.name);
  },
  renamePatron: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, m.id));
    requirePatron(txn, m.id);
    txn.update.patron(m.id, (p) => {
      p.name = m.name;
    });
  },
  removePatron: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requirePatron(txn, m.id);
    txn.deleteSlice.patron(m.id);
  },
  forgetPatron: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requirePatron(txn, m.id);
    txn.deleteSlice.patron(m.id, { erase: true });
  },
  resetPatron: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requirePatron(txn, m.id);
    txn.deleteSlice.patron(m.id);
    // the deleted slice reads as empty
    if (txn.get.patron(m.id) !== undefined) throw new Error('a deleted slice still reads');
    seedPatron(txn, m.id, m.name);
  },
  tryHold: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, m.patron));
    const b = txn.get.book(m.book);
    if (b === undefined) throw new Reject('no such book');
    requirePatron(txn, m.patron);
    if (b.hold) {
      txn.update.messages(m.patron, (messages) => {
        messages.push('already held');
      });
      return;
    }
    txn.update.book(m.book, (book) => {
      book.hold = true;
    });
    txn.update.holds(m.patron, (holds) => {
      holds[m.book] = true;
    });
  },
  shelve: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    const b = txn.get.book(m.book);
    if (b === undefined) throw new Reject('no such book');
    const copies = txn.scan.copy({ branch: m.branch });
    if ([...copies].some(([, c]) => c.title === b.title)) throw new Reject('title on shelf');
    txn.set.copy(m.branch, m.book, { book: m.book, title: b.title });
    // the copies as the decider's own scan sees them, the one set just above included
    const shelved = [...txn.scan.copy({ branch: m.branch }, { keys: true })];
    txn.set.shelved(
      m.branch,
      shelved.map(({ book }) => `copy:${book}`),
    );
  },
  lend: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    txn.set.lend(m.branch, m.patron, m.patron);
  },
  closeShelf: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    txn.deleteSlice.shelf(m.branch);
  },
  createAccount: (auth, txn, m) => {
    auth.authorizeAnyone();
    if (txn.get.account(m.user) !== undefined) throw new Reject('account exists');
    // only an admin creates an admin
    const admin = isAdmin(txn, auth) && m.admin === true;
    txn.set.account(m.user, {
      user: m.user,
      hash: m.password,
      admin,
      generation: 0,
      views: [],
    });
  },
  changePassword: (auth, txn, m) => {
    auth.authorize(isSelf(auth, m.user));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      a.hash = m.password;
    });
  },
  setPassword: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, m.user));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      a.hash = m.password;
    });
  },
  revokeSessions: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, m.user));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      a.generation += 1;
    });
  },
  grantView: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      if (!a.views.includes(m.prefix)) a.views.push(m.prefix);
    });
  },
  revokeView: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      a.views = a.views.filter((p) => p !== m.prefix);
    });
  },
  authenticatedMutation: (auth, txn, m) => {
    // the decider sees what the proof proved, never the proof
    const seen = JSON.stringify(m.check);
    if (seen !== '{"kind":"password"}') throw new Reject(`the decider saw ${seen}`);
    auth.authorize(isSelf(auth, m.user));
    requireAccount(txn, m.user);
    txn.update.account(m.user, (a) => {
      a.generation += 1;
    });
  },
  notify: (auth, txn, m) => {
    auth.authorize(isAdmin(txn, auth));
    requirePatron(txn, m.patron);
    // a request per reason, "uuid" standing for a fresh random one
    for (const reason of m.reasons) {
      txn.notice.post(m.patron, reason === 'uuid' ? crypto.randomUUID() : reason);
    }
    if (m.reject === true) throw new Reject('rejected after its requests');
    txn.update.messages(m.patron, (messages) => {
      messages.push('own');
    });
  },
};

// the bundle //

const bundle = defineTestDB<TestPlugins>({
  deciders,
  grant: (txn, principal) => {
    if (principal.user === null) return ['book!'];
    if (principal.user === WRITER) {
      // the grantor's txn offers no writes, so only a cast reaches them
      (txn as unknown as TestDBTxn).set.messages('p1', ['from grant']);
    }
    if (principal.user === RAW_WRITER) {
      writeTxn!.set('patron:p1!messages', 'patron/messages', ['from grant']);
    }
    if (isAdmin(txn, principal)) return ['*'];
    const out = ['book!', `patron:${principal.user}!`];
    const a = txn.get.account(principal.user);
    if (a !== undefined) out.push(...a.views);
    // the shelves that lend to the user
    for (const key of lendsTo(principal.user)) out.push(key.slice(0, key.indexOf('!') + 1));
    if (principal.user === AUDITED) out.push(`shelf:run-${++auditedRuns}!`);
    return out;
  },
  lookup: (txn, ident) => {
    const user = ident.kind === 'password' ? ident.identity : ident.user;
    if (user === RAW_LOOKUP) {
      writeTxn!.set('patron:p1!messages', 'patron/messages', ['from lookup']);
    }
    const a = txn.get.account(user);
    if (a !== undefined) {
      return { user: a.user, generation: a.generation, passwordHash: a.hash };
    }
    if (user === FLAKY) return { user, generation: 0, passwordHash: crypto.randomUUID() };
    // the tests' standing users, who need no account in the log
    return TEST_USERS.includes(user) ? { user, generation: 0 } : null;
  },
  // an admin account, when the operator names its user and password
  bootstrap: (txn, ctx) => {
    const user = ctx.env('BOOTSTRAP_ADMIN');
    if (user === '') return;
    const hash = ctx.hashPassword(ctx.env('BOOTSTRAP_PASSWORD'));
    txn.set.account(user, {
      user,
      hash,
      admin: true,
      generation: 0,
      views: [],
    });
  },
  plugins: { notice: installNotice(), cron },
});

// the raw transaction the read context is bound to, which the grantor scans through
const { bindRead } = bundle;
bundle.bindRead = (txn) => {
  readTxn = txn;
  bindRead(txn);
};

// the raw transaction the write context is bound to, which the grantor and lookup write through
const { bindWrite } = bundle;
bundle.bindWrite = (txn) => {
  writeTxn = txn;
  bindWrite(txn);
};
