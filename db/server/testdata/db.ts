// The bundle the server tests run: the test model's reducers, precommit, maySee, and lookup.

import {
  type AccountSliceReducers,
  type BookSliceReducers,
  defineTestDB,
  type PatronSliceReducers,
  type Principal,
  Reject,
  type TestDBPrecommit,
  type TestDBTxn,
} from './model.gen.ts';

const ADMIN = 'admin';
const isAdmin = (p: Principal): boolean => p.traits.includes(ADMIN);

// the users the tests sign in as without creating an account first, with their traits
const TEST_USERS: Record<string, string[]> = { root: [ADMIN], p1: [] };
const isSelf = (p: Principal, user: string): boolean => p.user !== null && p.user === user;

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

const account: AccountSliceReducers = {
  accountCreated: (txn, e) =>
    txn.set.account({ user: e.user, hash: e.hash, traits: e.traits, generation: 0, views: [] }),
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
    auth.authorize(isAdmin(auth));
    if (txn.get.book(cmd.id) !== undefined) throw new Reject('book exists');
    return { stream: 'book', event: cmd };
  },
  addPatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    if (txn.get.patron(cmd.id) !== undefined) throw new Reject('patron exists');
    return { stream: `patron.${cmd.id}`, event: cmd };
  },
  renamePatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth) || isSelf(auth, cmd.id));
    requirePatron(txn, cmd.id);
    return { stream: `patron.${cmd.id}`, event: cmd };
  },
  removePatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requirePatron(txn, cmd.id);
    return { stream: `patron.${cmd.id}`, death: true };
  },
  tryHold: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth) || isSelf(auth, cmd.patron));
    const b = txn.get.book(cmd.book);
    if (b === undefined) throw new Reject('no such book');
    requirePatron(txn, cmd.patron);
    const stream = `patron.${cmd.patron}`;
    if (b.hold) {
      return { stream, event: { type: 'hold-failed', book: cmd.book, reason: 'already held' } };
    }
    return [
      { stream: 'book', event: { type: 'hold-opened', book: cmd.book } },
      { stream, event: { type: 'patron-hold', book: cmd.book } },
    ];
  },
  createAccount: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (txn.get.account(cmd.user) !== undefined) throw new Reject('account exists');
    const traits = isAdmin(auth) ? (cmd.traits ?? []) : [];
    return {
      stream: `account.${cmd.user}`,
      event: { type: 'account-created', user: cmd.user, hash: cmd.password, traits },
    };
  },
  setPassword: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth) || isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account.${cmd.user}`, event: { type: 'password-set', hash: cmd.password } };
  },
  revokeSessions: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth) || isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account.${cmd.user}`, event: { type: 'sessions-revoked' } };
  },
  grantView: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireAccount(txn, cmd.user);
    return { stream: `account.${cmd.user}`, event: { type: 'view-granted', prefix: cmd.prefix } };
  },
  revokeView: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireAccount(txn, cmd.user);
    return { stream: `account.${cmd.user}`, event: { type: 'view-revoked', prefix: cmd.prefix } };
  },
  authenticatedCommand: (auth, txn, cmd) => {
    auth.authorize(isSelf(auth, cmd.user));
    requireAccount(txn, cmd.user);
    return { stream: `account.${cmd.user}`, event: { type: 'sessions-revoked' } };
  },
};

// the bundle //

defineTestDB({
  reducers: { book, patron, account },
  precommit,
  maySee: (txn, principal) => {
    if (principal.user === null) return ['book/'];
    if (isAdmin(principal)) return ['*'];
    const out = ['book/', `patron.${principal.user}/`];
    const a = txn.get.account(principal.user);
    if (a !== undefined) out.push(...a.views);
    return out;
  },
  lookup: (txn, ident) => {
    const user = ident.kind === 'password' ? ident.identity : ident.user;
    const a = txn.get.account(user);
    if (a !== undefined) {
      return { user: a.user, traits: a.traits, generation: a.generation, secret: a.hash };
    }
    // the tests' standing users, who need no account in the log
    const traits = TEST_USERS[user];
    return traits === undefined ? null : { user, traits, generation: 0 };
  },
  // an admin account, when the operator names its user and password
  bootstrap: (ctx) => {
    const user = ctx.env('BOOTSTRAP_ADMIN');
    if (user === '') return;
    const hash = ctx.hashPassword(ctx.env('BOOTSTRAP_PASSWORD'));
    ctx.emit(`account.${user}`, { type: 'account-created', user, hash, traits: [ADMIN] });
  },
});
