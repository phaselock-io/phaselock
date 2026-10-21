/* The database's bundle: the deciders, which check who sent each mutation and that what it names
   exists, then carry it out, most through the predictor the Engines run; who may see what; the
   accounts behind sign-in; the seed data; and the daily sheet.

   Every login belongs to a patron, whose id is their patron id, except the one `admin` login that
   every librarian shares, which is flagged as a librarian's.  The library lives in rooms (see
   rooms.ts), so every slice and mutation names its room, and a user id is `<room>.<id>`. */

import { Cron, type CronPlugin } from '@phaselock/plugins';

import {
  defineLibraryDB,
  type LibraryDBDeciders,
  type LibraryDBReadTxn,
  type LibraryDBTxn,
  type LibraryDBTypes,
  type Principal,
  Reject,
} from './model.gen';
import { adminPredictors, closeOwnedHold, releaseHold, userPredictors } from './predictors';
import { parseIdentity, parseUser, reapRooms, recordRoom, ROOM_RE, userId } from './rooms';

// the database's randomness, which the host installs
declare const crypto: { randomUUID(): string };

// a login name fills a key parameter, so it holds no separator of the key templates
const LOGIN_RE = /^[A-Za-z0-9_-]{1,64}$/;
// a patron's color, which the UI puts in a style, so it is a plain hex color and nothing else
const COLOR_RE = /^#[0-9a-f]{6}$/;

// the colors a new patron takes in turn when their account names none, distinct from the green
// the UI marks actions with
const PATRON_COLORS = ['#db666e', '#208fdf', '#a36cea', '#dfab20', '#e64c87', '#677ee9'];

type Plugins = { cron: CronPlugin };
type Txn = LibraryDBTxn;
type ReadTxn = LibraryDBReadTxn;

// whether the principal is a librarian of the room
function isLibrarian(txn: ReadTxn, p: Principal, room: string): boolean {
  const u = parseUser(p.user);
  if (u?.room !== room) return false;
  const login = txn.get.user_login(room, u.id);
  return login !== undefined && txn.get.login(room, login)?.librarian === true;
}

// whether the principal is the patron named
function isPatron(p: Principal, room: string, patron: string): boolean {
  const u = parseUser(p.user);
  return u?.room === room && u.id === patron;
}

// whether the principal is the patron named, or a librarian of the patron's room
function isLibrarianOr(txn: ReadTxn, p: Principal, room: string, patron: string): boolean {
  return isPatron(p, room, patron) || isLibrarian(txn, p, room);
}

function requireEdition(txn: ReadTxn, room: string, isbn: string): void {
  if (txn.get.edition(room, isbn) === undefined) throw new Reject('no such edition');
}

function requireBook(txn: ReadTxn, room: string, id: string): void {
  if (txn.get.book(room, id) === undefined) throw new Reject('no such book');
}

function requirePatron(txn: ReadTxn, room: string, id: string): void {
  if (txn.get.patron(room, id) === undefined) throw new Reject('no such patron');
}

// the login of a signed-in patron of the room; the librarians' shared login is the operator's to
// manage
function ownLogin(txn: ReadTxn, p: Principal, room: string): { login: string; id: string } {
  const u = parseUser(p.user);
  const login = u?.room === room ? txn.get.user_login(room, u.id) : undefined;
  if (u === null || login === undefined || txn.get.login(room, login)?.librarian !== false) {
    throw new Reject('no such account');
  }
  return { login, id: u.id };
}

/* The demo's hash of `password`, which every seeded login shares, so the UI can sign each window
   in without asking.  A real deployment seeds no patrons, and seeds its librarians' login with a
   password the operator names, as `ctx.hashPassword(ctx.env('ADMIN_PASSWORD'))`. */
const PASSWORD =
  '$argon2id$v=19$m=19456,t=2,p=1$Q5DUnO7oOsLNn2Dbq0onlg$BtsQQtohUlcUy4tUcXf91Cz3CrOcd1ewdp6Aplntmfk';

// the seeded catalog: two copies of each edition, one of them restricted
const EDITIONS = [
  ['978-0-14-143956-3', 'Great Expectations'],
  ['978-0-14-143960-0', 'A Tale of Two Cities'],
  ['978-0-06-088328-7', 'One Hundred Years of Solitude'],
  ['978-0-14-044793-4', 'War and Peace'],
];

// the seeded patrons: their login names, names, colors, and whether each is a researcher
const PATRONS = [
  { login: 'alice', name: 'Alice', color: '#db666e', researcher: true },
  { login: 'bob', name: 'Bob', color: '#208fdf', researcher: false },
];

// a login, and the index of its user's login name
function addLogin(
  txn: Txn,
  room: string,
  login: string,
  user: string,
  password: string,
  librarian: boolean,
): void {
  txn.set.login(room, login, { user, password, librarian });
  txn.set.user_login(room, user, login);
}

// the demo's starting state in a room: the catalog, the patrons, and the logins
function seed(txn: Txn, room: string): void {
  // each seeded edition and book a millisecond after the last, so the books keep the order they
  // were added
  let at = Date.now();
  const next = () => new Date(at++);

  // the catalog, as a librarian adds it
  for (const [isbn, title] of EDITIONS) {
    adminPredictors.addEdition(txn, { type: 'add-edition', room, isbn, title, timestamp: next() });
    for (const restricted of [false, true]) {
      const id = crypto.randomUUID();
      const timestamp = next();
      adminPredictors.addBook(txn, { type: 'add-book', room, id, isbn, restricted, timestamp });
    }
  }

  // the patrons and their logins
  for (const p of PATRONS) {
    const id = crypto.randomUUID();
    txn.set.patron(room, id, { id, name: p.name, color: p.color, researcher: p.researcher });
    addLogin(txn, room, p.login, id, PASSWORD, false);
  }

  // the librarians' login
  addLogin(txn, room, 'admin', crypto.randomUUID(), PASSWORD, true);
}

const deciders: LibraryDBDeciders<Plugins> = {
  // a patron's mutations, which a patron sends for themselves and a librarian for anyone

  renamePatron: (auth, txn, m) => {
    auth.authorize(isLibrarianOr(txn, auth, m.room, m.id));
    requirePatron(txn, m.room, m.id);
    adminPredictors.renamePatron(txn, m);
  },
  tryHold: (auth, txn, m) => {
    auth.authorize(isLibrarianOr(txn, auth, m.room, m.patron));
    requirePatron(txn, m.room, m.patron);
    if ('book' in m.target) {
      requireBook(txn, m.room, m.target.book);
    } else {
      requireEdition(txn, m.room, m.target.edition);
    }
    if (txn.get.hold(m.room, m.id) !== undefined) throw new Reject('hold exists');
    adminPredictors.tryHold(txn, m);
  },
  patronDismissNotice: (auth, txn, m) => {
    auth.authorize(isLibrarianOr(txn, auth, m.room, m.patron));
    if (txn.get.patron_notice(m.room, m.patron, m.id) === undefined) {
      throw new Reject('no such notice');
    }
    adminPredictors.patronDismissNotice(txn, m);
  },

  // a patron's own hold, which only its patron cancels

  cancelHold: (auth, txn, m) => {
    auth.authorize(isPatron(auth, m.room, m.patron));
    if (txn.get.patron_hold(m.room, m.patron, m.id) === undefined) {
      throw new Reject('no such hold');
    }
    userPredictors.cancelHold(txn, m);

    // the librarians' record of the hold goes too, which the patron's Engine does not hold
    txn.del.hold_owner(m.room, m.id);
  },

  // a patron's account, which only its patron changes; the database has checked the proof

  changePassword: (auth, txn, m) => {
    auth.authorize(parseUser(auth.user)?.room === m.room);
    const { login, id } = ownLogin(txn, auth, m.room);
    txn.update.login(m.room, login, (l) => (l.password = m.new));
    txn.update.patron(m.room, id, (patron) => (patron.passwordChanged = new Date()));
  },
  deleteAccount: (auth, txn, m) => {
    auth.authorize(parseUser(auth.user)?.room === m.room);
    const room = m.room;
    const { login, id } = ownLogin(txn, auth, room);
    if (!txn.scan.patron_checkout({ room, patron: id }, { keys: true }).next().done) {
      throw new Reject('return every book first');
    }

    /* The account's open holds close with it, in the catalog and the librarians' record of
       their owner, and its patron slice is deleted with its history erased. */
    const holds = [...txn.scan.patron_hold({ room, patron: id }, { keys: true })];
    for (const { hold } of holds) {
      releaseHold(txn, room, hold);
      txn.del.hold_owner(room, hold);
    }
    txn.del.login(room, login);
    txn.del.user_login(room, id);
    txn.deleteSlice.patron(room, id, { erase: true });
  },

  // the librarians' mutations

  addEdition: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    if (txn.get.edition(m.room, m.isbn) !== undefined) throw new Reject('edition exists');
    adminPredictors.addEdition(txn, m);
  },
  updateEditionTitle: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requireEdition(txn, m.room, m.isbn);
    adminPredictors.updateEditionTitle(txn, m);
  },
  addBook: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requireEdition(txn, m.room, m.isbn);
    if (txn.get.book(m.room, m.id) !== undefined) throw new Reject('book exists');
    adminPredictors.addBook(txn, m);
  },
  updateBookRestricted: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requireBook(txn, m.room, m.id);
    adminPredictors.updateBookRestricted(txn, m);
  },
  removeBook: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requireBook(txn, m.room, m.id);
    // a checkout needs its book to end
    const status = txn.get.book(m.room, m.id)!.status;
    if (status !== undefined && 'checkout' in status) throw new Reject('the book is checked out');
    adminPredictors.removeBook(txn, m);
  },
  assignPatron: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requirePatron(txn, m.room, m.id);
    adminPredictors.assignPatron(txn, m);
  },
  tryCheckout: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    requirePatron(txn, m.room, m.patron);
    requireBook(txn, m.room, m.book);
    if (txn.get.checkout(m.room, m.id) !== undefined) throw new Reject('checkout exists');
    adminPredictors.tryCheckout(txn, m);
  },
  endCheckout: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    if (txn.get.patron_checkout(m.room, m.patron, m.checkout) === undefined) {
      throw new Reject('no such checkout');
    }
    adminPredictors.endCheckout(txn, m);
  },
  dismissNotice: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    if (txn.get.admin_notice(m.room, m.id) === undefined) throw new Reject('no such notice');
    adminPredictors.dismissNotice(txn, m);
  },
  libraryCancelHold: (auth, txn, m) => {
    auth.authorize(isLibrarian(txn, auth, m.room));
    if (txn.get.patron_hold(m.room, m.patron, m.id) === undefined) {
      throw new Reject('no such hold');
    }
    adminPredictors.libraryCancelHold(txn, m);
  },

  // the database's own mutation: anyone may sign up in a room, and the account's patron id is new

  createAccount: (auth, txn, m) => {
    auth.authorizeAnyone();
    if (txn.get.room(m.room) === undefined) throw new Reject('no such room');
    if (!LOGIN_RE.test(m.login)) throw new Reject('a login name is 1 to 64 of [A-Za-z0-9_-]');
    if (txn.get.login(m.room, m.login) !== undefined) throw new Reject('login taken');
    if (m.color !== undefined && !COLOR_RE.test(m.color)) {
      throw new Reject('a color is #rrggbb in lowercase hex');
    }

    // without a color of its own, the account takes the next of the patrons' colors
    const patrons = [...txn.scan.patron({ room: m.room }, { keys: true })].length;
    const color = m.color ?? PATRON_COLORS[patrons % PATRON_COLORS.length];
    const id = crypto.randomUUID();
    addLogin(txn, m.room, m.login, id, m.password, false);
    txn.set.patron(m.room, id, { id, name: m.name, color, researcher: false });
  },

  // room stuff; for hosting a demo with many rooms

  // anyone may create a room; for one that exists it writes nothing, otherwise it seeds the room
  createRoom: (auth, txn, m) => {
    auth.authorizeAnyone();
    if (!ROOM_RE.test(m.room)) throw new Reject('a room id is a lowercase uuid');
    if (txn.get.room(m.room) !== undefined) return;
    recordRoom(txn, m.room, new Date());
    seed(txn, m.room);
  },
};

/* The daily sheet, at midnight UTC: closed-ended holds past their expiry close, and checkouts past
   theirs become overdue.  It sweeps every room's catalog for open holds and checkouts, and reads
   whose each one is from the librarians' record of their owners. */
function dailySheet(txn: Txn, now: Date): void {
  // the expired holds, gathered before any of them closes
  const expired = [...txn.scan.hold()].filter(
    ([, h]) => h.expires !== undefined && h.expires <= now,
  );
  for (const [{ room, hold }] of expired) closeOwnedHold(txn, room, hold, 'it expired', true);

  // the checkouts past their expiry, gathered before any of them changes
  const overdue = [...txn.scan.checkout()].filter(([, c]) => !c.overdue && c.expires <= now);
  for (const [{ room, checkout }] of overdue) {
    const patron = txn.get.checkout_owner(room, checkout);
    if (patron === undefined) throw new Error('no such checkout');
    txn.update.checkout(room, checkout, (c) => (c.overdue = true));
    txn.update.patron_checkout(room, patron, checkout, (c) => (c.overdue = true));
  }
}

const cron = Cron.install<LibraryDBTypes<Plugins>>({
  'daily-sheet': { spec: '@daily', hook: (txn, tick) => dailySheet(txn, tick.now) },
  // room stuff: every minute, the rooms an hour old are erased
  'reap-rooms': { spec: '* * * * *', hook: reapRooms },
});

defineLibraryDB<Plugins>({
  deciders,
  // a patron may see their room's catalog and their own record, and a librarian everything
  // synced in the room; everyone in a room sees the room's own record
  grant: (txn, principal) => {
    const u = parseUser(principal.user);
    if (u === null) return [];
    const room = `room:${u.room}!`;
    if (isLibrarian(txn, principal, u.room)) {
      return [`book:${u.room}!`, `patron:${u.room},*`, `admin:${u.room}!`, room];
    }
    return [`book:${u.room}!`, `patron:${u.room},${u.id}!`, room];
  },
  // a login by its room and name for a sign-in, and by its user for a token
  lookup: (txn, ident) => {
    let room: string;
    let login: string | undefined;
    if (ident.kind === 'password') {
      const parsed = parseIdentity(ident.identity);
      if (parsed === null || !ROOM_RE.test(parsed.room) || !LOGIN_RE.test(parsed.login)) {
        return null;
      }
      room = parsed.room;
      login = parsed.login;
    } else {
      const parsed = parseUser(ident.user);
      if (parsed === null) return null;
      room = parsed.room;
      login = txn.get.user_login(room, parsed.id);
    }
    const found = login === undefined ? undefined : txn.get.login(room, login);
    if (found === undefined) return null;
    return { user: userId(room, found.user), passwordHash: found.password };
  },
  plugins: { cron },
});
