// The bundle the server tests run: the test model's reducers, precommit, maySee, and lookup.

import {
  type AccountSliceReducers,
  type BookSliceReducers,
  defineTestDB,
  type PatronSliceReducers,
  type Principal,
  type ReadTxn,
  Reject,
  type ShelfSliceReducers,
  type TestDBPrecommit,
  type TestDBTxn,
} from './model.gen.ts';

/* The users the tests sign in as without creating an account first.  root is an admin, and r1 is
   audited: its every maySee run changes its view, so a test sees each run as a view frame. */
const TEST_USERS = ['root', 'p1', 'r1'];
const ROOT = 'root';
const AUDITED = 'r1';

// whether the principal is root or an account flagged admin
const isAdmin = (txn: TestDBTxn, p: Principal): boolean =>
  p.user === ROOT || (p.user !== null && txn.get.account(p.user)?.admin === true);
const isSelf = (p: Principal, user: string): boolean => p.user !== null && p.user === user;

// scans //

/* Precommit and the reducers scan through their typed contexts.  maySee scans through the raw
   ReadTxn the database hands it, which the wrapper at the end of this file holds while it runs,
   one entry per batch: every batch after the first resumes from the key the last one ended
   with, so maySee's read-set spans many batches of one walk. */
let readTxn: ReadTxn | undefined;

// the keys of every shelf that lends to a patron, fetched a batch of one at a time
function lendsTo(patron: string): string[] {
  const keys: string[] = [];
  let after: string | undefined;
  for (;;) {
    const { entries, next } = readTxn!.scan({
      pattern: { stream: { family: 'shelf', params: [null] }, name: 'lend', local: [{ eq: patron }] },
      type: false,
      after,
      limit: 1,
    });
    for (const [key] of entries) keys.push(key);
    if (next === null) return keys;
    after = next;
  }
}

// the count of maySee's runs for audited principals
let auditedRuns = 0;

// reducers //

const book: BookSliceReducers = {
  addBook: (txn, e) => txn.set.book(e.id, { id: e.id, title: e.title, added: e.added }),
  holdOpened: (txn, e) =>
    txn.update.book(e.book, (b) => {
      b.hold = true;
    }),
};

const patron: PatronSliceReducers = {
  addPatron: (txn, e) => {
    txn.set.patron({ id: e.id, name: e.name });
    txn.set.holds({});
    txn.set.messages([]);
  },
  renamePatron: (txn, e) =>
    txn.update.patron((p) => {
      p.name = e.name;
    }),
  patronHold: (txn, e) =>
    txn.update.holds((holds) => {
      holds[e.book] = true;
    }),
  holdFailed: (txn, e) =>
    txn.update.messages((messages) => {
      messages.push(e.reason);
    }),
};

const shelf: ShelfSliceReducers = {
  shelved: (txn, e) => {
    txn.set.copy(e.book, { book: e.book, title: e.title });
    // the copies as the reducer's own scan sees them, the one set just above included
    txn.set.shelved([...txn.scan.copy({}, { keys: true })].map(({ book }) => `copy:${book}`));
  },
  lend: (txn, e) => txn.set.lend(e.patron, e.patron),
};

const account: AccountSliceReducers = {
  accountCreated: (txn, e) =>
    txn.set.account({ user: e.user, hash: e.hash, admin: e.admin, generation: 0, views: [] }),
  passwordSet: (txn, e) =>
    txn.update.account((a) => {
      a.hash = e.hash;
    }),
  sessionsRevoked: (txn) =>
    txn.update.account((a) => {
      a.generation += 1;
    }),
  viewGranted: (txn, e) =>
    txn.update.account((a) => {
      if (!a.views.includes(e.prefix)) a.views.push(e.prefix);
    }),
  viewRevoked: (txn, e) =>
    txn.update.account((a) => {
      a.views = a.views.filter((p) => p !== e.prefix);
    }),
};

// precommit //

function requirePatron(txn: TestDBTxn, id: string): void {
  if (txn.get.patron(id) === undefined) throw new Reject('no such patron');
}

function requireAccount(txn: TestDBTxn, user: string): void {
  if (txn.get.account(user) === undefined) throw new Reject('no such account');
}

const precommit: TestDBPrecommit = {
  addBook: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    if (txn.get.book(cmd.id) !== undefined) throw new Reject('book exists');
    return { stream: 'book', event: cmd };
  },
  addPatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    if (txn.get.patron(cmd.id) !== undefined) throw new Reject('patron exists');
    return { stream: `patron:${cmd.id}`, event: cmd };
  },
  renamePatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, cmd.id));
    requirePatron(txn, cmd.id);
    return { stream: `patron:${cmd.id}`, event: cmd };
  },
  removePatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    requirePatron(txn, cmd.id);
    return { stream: `patron:${cmd.id}`, death: true };
  },
  tryHold: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, cmd.patron));
    const b = txn.get.book(cmd.book);
    if (b === undefined) throw new Reject('no such book');
    requirePatron(txn, cmd.patron);
    const stream = `patron:${cmd.patron}` as const;
    if (b.hold) {
      return { stream, event: { type: 'hold-failed', book: cmd.book, reason: 'already held' } };
    }
    return [
      { stream: 'book', event: { type: 'hold-opened', book: cmd.book } },
      { stream, event: { type: 'patron-hold', book: cmd.book } },
    ];
  },
  shelve: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    const b = txn.get.book(cmd.book);
    if (b === undefined) throw new Reject('no such book');
    const copies = txn.scan.copy({ branch: cmd.branch });
    if ([...copies].some(([, c]) => c.title === b.title)) throw new Reject('title on shelf');
    return {
      stream: `shelf:${cmd.branch}`,
      event: { type: 'shelved', book: cmd.book, title: b.title },
    };
  },
  lend: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    return { stream: `shelf:${cmd.branch}`, event: cmd };
  },
  closeShelf: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    return { stream: `shelf:${cmd.branch}`, death: true };
  },
  createAccount: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (txn.get.account(cmd.user) !== undefined) throw new Reject('account exists');
    // only an admin creates an admin
    const admin = isAdmin(txn, auth) && cmd.admin === true;
    return {
      stream: `account:${cmd.user}`,
      event: { type: 'account-created', user: cmd.user, hash: cmd.password, admin },
    };
  },
  setPassword: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account:${cmd.user}`, event: { type: 'password-set', hash: cmd.password } };
  },
  revokeSessions: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth) || isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account:${cmd.user}`, event: { type: 'sessions-revoked' } };
  },
  grantView: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    requireAccount(txn, cmd.user);
    return { stream: `account:${cmd.user}`, event: { type: 'view-granted', prefix: cmd.prefix } };
  },
  revokeView: (auth, txn, cmd) => {
    auth.authorize(isAdmin(txn, auth));
    requireAccount(txn, cmd.user);
    return { stream: `account:${cmd.user}`, event: { type: 'view-revoked', prefix: cmd.prefix } };
  },
  authenticatedCommand: (auth, txn, cmd) => {
    auth.authorize(isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account:${cmd.user}`, event: { type: 'sessions-revoked' } };
  },
};

// the bundle //

const bundle = defineTestDB({
  reducers: { book, patron, shelf, account },
  precommit,
  maySee: (txn, principal) => {
    if (principal.user === null) return ['book!'];
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
    const a = txn.get.account(user);
    if (a !== undefined) {
      return { user: a.user, generation: a.generation, secret: a.hash };
    }
    // the tests' standing users, who need no account in the log
    return TEST_USERS.includes(user) ? { user, generation: 0 } : null;
  },
  // an admin account, when the operator names its user and password
  bootstrap: (ctx) => {
    const user = ctx.env('BOOTSTRAP_ADMIN');
    if (user === '') return;
    const hash = ctx.hashPassword(ctx.env('BOOTSTRAP_PASSWORD'));
    ctx.emit(`account:${user}`, { type: 'account-created', user, hash, admin: true });
  },
});

// maySee, holding its transaction while it runs
const { maySee: maySeeSlot } = bundle;
bundle.maySee = (txn, principal) => {
  readTxn = txn;
  try {
    return maySeeSlot(txn, principal);
  } finally {
    readTxn = undefined;
  }
};
