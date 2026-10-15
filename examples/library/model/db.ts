/* The database's bundle: every slice's reducers; precommit, which checks who sent each command and
   that what it names exists, then answers its outcome; who may see what; the accounts behind
   sign-in; the seed data; and the daily sheet.

   Every login belongs to a patron, whose user is their patron id, except the one `admin` login
   that every librarian shares. */

import { Cron, type CronPlugin } from '@phaselock/plugins';

import {
  defineLibraryDB,
  type LibraryDBOutput,
  type LibraryDBPrecommit,
  type LibraryDBTxn,
  type LibraryDBTypes,
  type Principal,
  Reject,
} from './model.gen';
import { closeHold, holderOf, outcomes } from './outcomes';
import { adminReducers, bookReducers, loginReducers, patronReducers } from './reducers';

// the database's randomness, which the host installs
declare const crypto: { randomUUID(): string };

// the user of the librarians' shared login
const ADMIN = 'admin';
// a login name fills a key parameter, so it holds no separator of the key templates
const LOGIN_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Plugins = { cron: CronPlugin };
type Txn = LibraryDBTxn<Plugins>;

const isAdmin = (p: Principal): boolean => p.user === ADMIN;
// whether the principal is a librarian or the patron named
const isAdminOr = (p: Principal, patron: string): boolean => isAdmin(p) || p.user === patron;

function requireEdition(txn: Txn, isbn: string): void {
  if (txn.get.edition(isbn) === undefined) throw new Reject('no such edition');
}

function requireBook(txn: Txn, id: string): void {
  if (txn.get.book(id) === undefined) throw new Reject('no such book');
}

function requirePatron(txn: Txn, id: string): void {
  if (txn.get.patron(id) === undefined) throw new Reject('no such patron');
}

// the login of a signed-in patron; the librarians' shared login is the operator's to manage
function ownLogin(txn: Txn, p: Principal): { login: string; user: string } {
  const login = p.user === null || isAdmin(p) ? undefined : txn.get.user_login(p.user);
  if (p.user === null || login === undefined) throw new Reject('no such account');
  return { login, user: p.user };
}

const precommit: LibraryDBPrecommit<Plugins> = {
  // a patron's commands, which a patron sends for themselves and a librarian for anyone

  renamePatron: (auth, txn, cmd) => {
    auth.authorize(isAdminOr(auth, cmd.id));
    requirePatron(txn, cmd.id);
    return { stream: `patron:${cmd.id}`, event: cmd };
  },
  tryHold: (auth, txn, cmd) => {
    auth.authorize(isAdminOr(auth, cmd.patron));
    requirePatron(txn, cmd.patron);
    if ('book' in cmd.target) {
      requireBook(txn, cmd.target.book);
    } else {
      requireEdition(txn, cmd.target.edition);
    }
    if (txn.get.hold(cmd.id) !== undefined) throw new Reject('hold exists');
    return outcomes.tryHold(txn, cmd);
  },
  cancelHold: (auth, txn, cmd) => {
    auth.authorize(isAdminOr(auth, cmd.patron));
    if (txn.get.patron_hold(cmd.patron, cmd.id) === undefined) throw new Reject('no such hold');
    return outcomes.cancelHold(txn, cmd, auth.user !== cmd.patron);
  },
  patronDismissNotice: (auth, txn, cmd) => {
    auth.authorize(isAdminOr(auth, cmd.patron));
    if (txn.get.patron_notice(cmd.patron, cmd.id) === undefined) {
      throw new Reject('no such notice');
    }
    return { stream: `patron:${cmd.patron}`, event: cmd };
  },

  // a patron's account, which only its patron changes; the database has checked the proof

  changePassword: (auth, txn, cmd) => {
    auth.authorize(auth.user !== null);
    const { login, user } = ownLogin(txn, auth);
    return [
      { stream: 'login', event: { type: 'password-changed', login, password: cmd.new } },
      {
        stream: `patron:${user}`,
        event: { type: 'patron-password-changed', timestamp: new Date() },
      },
    ];
  },
  deleteAccount: (auth, txn) => {
    auth.authorize(auth.user !== null);
    const { login, user } = ownLogin(txn, auth);
    if (!txn.scan.patron_checkout({ patron: user }, { keys: true }).next().done) {
      throw new Reject('return every book first');
    }

    /* The account's open holds close with it, in the catalogue and the librarians' record of
       their owner, and its patron stream ends with its history erased. */
    const holds = [...txn.scan.patron_hold({ patron: user }, { keys: true })].flatMap(
      ({ hold }) => {
        const closed = { type: 'hold-closed', id: hold, reason: 'account deleted' } as const;
        return [
          { stream: 'book' as const, event: closed },
          { stream: 'admin' as const, event: closed },
        ];
      },
    );
    return [
      { stream: 'login', event: { type: 'login-deleted', login, user } },
      { stream: `patron:${user}`, death: true, erase: true },
      holds,
    ];
  },

  // the librarians' commands

  addEdition: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    if (txn.get.edition(cmd.isbn) !== undefined) throw new Reject('edition exists');
    return { stream: 'book', event: cmd };
  },
  updateEditionTitle: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireEdition(txn, cmd.isbn);
    return { stream: 'book', event: cmd };
  },
  addBook: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireEdition(txn, cmd.isbn);
    if (txn.get.book(cmd.id) !== undefined) throw new Reject('book exists');
    return { stream: 'book', event: cmd };
  },
  updateBookRestricted: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireBook(txn, cmd.id);
    return outcomes.updateBookRestricted(txn, cmd);
  },
  removeBook: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requireBook(txn, cmd.id);
    // a checkout needs its book to end
    const status = txn.get.book(cmd.id)!.status;
    if (status !== undefined && 'checkout' in status) throw new Reject('the book is checked out');
    return outcomes.removeBook(txn, cmd);
  },
  assignPatron: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requirePatron(txn, cmd.id);
    return outcomes.assignPatron(txn, cmd);
  },
  tryCheckout: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    requirePatron(txn, cmd.patron);
    requireBook(txn, cmd.book);
    if (txn.get.checkout(cmd.id) !== undefined) throw new Reject('checkout exists');
    return outcomes.tryCheckout(txn, cmd);
  },
  endCheckout: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    if (txn.get.patron_checkout(cmd.patron, cmd.checkout) === undefined) {
      throw new Reject('no such checkout');
    }
    return outcomes.endCheckout(txn, cmd);
  },
  dismissNotice: (auth, txn, cmd) => {
    auth.authorize(isAdmin(auth));
    if (txn.get.admin_notice(cmd.id) === undefined) throw new Reject('no such notice');
    return { stream: 'admin', event: cmd };
  },

  // the database's own command: anyone may sign up, and the account's patron id is new

  createAccount: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (!LOGIN_RE.test(cmd.login)) throw new Reject('a login name is 1 to 64 of [A-Za-z0-9_-]');
    if (txn.get.login(cmd.login) !== undefined) throw new Reject('login taken');
    const user = crypto.randomUUID();
    return [
      {
        stream: 'login',
        event: { type: 'login-created', login: cmd.login, user, password: cmd.password },
      },
      { stream: `patron:${user}`, event: { type: 'patron-created', id: user, name: cmd.name } },
    ];
  },
};

/* The daily sheet, at midnight UTC: closed-ended holds past their expiry close, and checkouts past
   theirs become overdue.  It sweeps the catalogue's open holds and checkouts, and reads whose each
   one is from the librarians' record of their owners. */
const cron = Cron.install<LibraryDBTypes<Plugins>>({
  'daily-sheet': {
    spec: '@daily',
    hook: (txn, tick) => {
      const out: LibraryDBOutput[] = [];
      for (const [{ hold }, h] of txn.scan.hold()) {
        if (h.expires === undefined || h.expires > tick.now) continue;
        out.push(...closeHold(txn, hold, holderOf(txn, hold), 'it expired', true));
      }
      for (const [{ checkout }, c] of txn.scan.checkout()) {
        if (c.overdue || c.expires > tick.now) continue;
        const patron = txn.get.checkout_owner(checkout);
        if (patron === undefined) throw new Error('no such checkout');
        out.push(
          { stream: 'book', event: { type: 'checkout-overdue', id: checkout } },
          {
            stream: `patron:${patron}` as const,
            event: { type: 'patron-checkout-overdue', id: checkout },
          },
        );
      }
      return out;
    },
  },
});

/* The demo's hash of `password`, which every seeded login shares, so the UI can sign each window
   in without asking.  A real deployment seeds no patrons, and seeds its librarians' login with a
   password the operator names, as `ctx.hashPassword(ctx.env('ADMIN_PASSWORD'))`. */
const PASSWORD =
  '$argon2id$v=19$m=19456,t=2,p=1$Q5DUnO7oOsLNn2Dbq0onlg$BtsQQtohUlcUy4tUcXf91Cz3CrOcd1ewdp6Aplntmfk';

// the seeded catalogue: two copies of each edition, one of them restricted
const EDITIONS = [
  ['978-1-4842-4585-9', 'Versioning in an Event Sourced System'],
  ['978-1-4842-2553-0', 'Implementing Domain-Driven Design'],
  ['978-1-09-812345-6', 'Building Local-First Software'],
  ['978-0-13-709431-2', 'Designing Offline-First Web Apps with Sync Engines'],
];

// the seeded patrons: their patron ids, login names, names, and whether each is a researcher
const PATRONS = [
  { id: 'patron-1', login: 'alice', name: 'Alice', researcher: true },
  { id: 'patron-2', login: 'bob', name: 'Bob', researcher: false },
];

defineLibraryDB<Plugins>({
  reducers: {
    book: bookReducers,
    patron: patronReducers,
    admin: adminReducers,
    login: loginReducers,
  },
  precommit,
  // anyone may see the catalogue, a patron their own record, and a librarian everything synced
  maySee: (_txn, principal) => {
    if (principal.user === null) return ['book!'];
    if (isAdmin(principal)) return ['book!', 'patron:*', 'admin!'];
    return ['book!', `patron:${principal.user}!`];
  },
  // a login by name for a sign-in, and by its user for a token
  lookup: (txn, ident) => {
    let login: string | undefined;
    if (ident.kind === 'password') {
      login = LOGIN_RE.test(ident.identity) ? ident.identity : undefined;
    } else {
      login = txn.get.user_login(ident.user);
    }
    const found = login === undefined ? undefined : txn.get.login(login);
    if (found === undefined) return null;
    return { user: found.user, passwordHash: found.password };
  },
  bootstrap: (ctx) => {
    // each seeded event a millisecond after the last, so the books keep the order they were added
    let at = Date.now();
    const next = () => new Date(at++);

    // the catalogue
    for (const [isbn, title] of EDITIONS) {
      ctx.emit('book', { type: 'add-edition', isbn, title, timestamp: next() });
      for (const restricted of [false, true]) {
        const id = crypto.randomUUID();
        ctx.emit('book', { type: 'add-book', id, isbn, restricted, timestamp: next() });
      }
    }

    // the patrons and their logins
    for (const p of PATRONS) {
      ctx.emit(`patron:${p.id}`, { type: 'patron-created', id: p.id, name: p.name });
      if (p.researcher) {
        ctx.emit(`patron:${p.id}`, {
          type: 'assign-patron',
          id: p.id,
          researcher: true,
          timestamp: next(),
        });
      }
      ctx.emit('login', { type: 'login-created', login: p.login, user: p.id, password: PASSWORD });
    }

    // the librarians' login
    ctx.emit('login', { type: 'login-created', login: ADMIN, user: ADMIN, password: PASSWORD });
  },
  plugins: { cron },
});
