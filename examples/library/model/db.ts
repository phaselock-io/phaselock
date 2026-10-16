/* The database's bundle: every slice's reducers; precommit, which checks who sent each command and
   that what it names exists, then answers its outcome; who may see what; the accounts behind
   sign-in; the seed data; and the daily sheet.

   Every login belongs to a patron, whose id is their patron id, except the one `admin` login that
   every librarian shares, which is flagged as a librarian's.  The library lives in rooms (see
   rooms.ts), so every stream and command names its room, and a user id is `<room>.<id>`. */

import { Cron, type CronPlugin } from '@phaselock/plugins';

import {
  type CreateRoomOutput,
  defineLibraryDB,
  type LibraryDBOutput,
  type LibraryDBPrecommit,
  type LibraryDBTxn,
  type LibraryDBTypes,
  type Principal,
  Reject,
} from './model.gen';
import { adminStream, bookStream, closeHold, holderOf, outcomes, patronStream } from './outcomes';
import { adminReducers, bookReducers, loginReducers, patronReducers } from './reducers';
import {
  parseIdentity,
  parseUser,
  reapRooms,
  ROOM_RE,
  roomReducers,
  roomRegistryReducers,
  userId,
} from './rooms';

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

// whether the principal is a librarian of the room
function isLibrarian(txn: Txn, p: Principal, room: string): boolean {
  const u = parseUser(p.user);
  if (u?.room !== room) return false;
  const login = txn.get.user_login(room, u.id);
  return login !== undefined && txn.get.login(room, login)?.librarian === true;
}

// whether the principal is the patron named, or a librarian of the patron's room
function isLibrarianOr(txn: Txn, p: Principal, room: string, patron: string): boolean {
  const u = parseUser(p.user);
  return (u?.room === room && u.id === patron) || isLibrarian(txn, p, room);
}

function requireEdition(txn: Txn, room: string, isbn: string): void {
  if (txn.get.edition(room, isbn) === undefined) throw new Reject('no such edition');
}

function requireBook(txn: Txn, room: string, id: string): void {
  if (txn.get.book(room, id) === undefined) throw new Reject('no such book');
}

function requirePatron(txn: Txn, room: string, id: string): void {
  if (txn.get.patron(room, id) === undefined) throw new Reject('no such patron');
}

// the login of a signed-in patron of the room; the librarians' shared login is the operator's to
// manage
function ownLogin(txn: Txn, p: Principal, room: string): { login: string; id: string } {
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

// the demo's starting state in a room: the catalog, the patrons, and the logins
function seed(room: string): CreateRoomOutput {
  const out: CreateRoomOutput = [];

  // each seeded event a millisecond after the last, so the books keep the order they were added
  let at = Date.now();
  const next = () => new Date(at++);

  // the catalog
  for (const [isbn, title] of EDITIONS) {
    out.push({
      stream: bookStream(room),
      event: { type: 'add-edition', room, isbn, title, timestamp: next() },
    });
    for (const restricted of [false, true]) {
      const id = crypto.randomUUID();
      out.push({
        stream: bookStream(room),
        event: { type: 'add-book', room, id, isbn, restricted, timestamp: next() },
      });
    }
  }

  // the patrons and their logins
  for (const p of PATRONS) {
    const id = crypto.randomUUID();
    const stream = patronStream(room, id);
    out.push({ stream, event: { type: 'patron-created', id, name: p.name, color: p.color } });
    if (p.researcher) {
      out.push({
        stream,
        event: { type: 'assign-patron', room, id, researcher: true, timestamp: next() },
      });
    }
    out.push({
      stream: `login:${room}`,
      event: {
        type: 'login-created',
        login: p.login,
        user: id,
        password: PASSWORD,
        librarian: false,
      },
    });
  }

  // the librarians' login
  out.push({
    stream: `login:${room}`,
    event: {
      type: 'login-created',
      login: 'admin',
      user: crypto.randomUUID(),
      password: PASSWORD,
      librarian: true,
    },
  });
  return out;
}

const precommit: LibraryDBPrecommit<Plugins> = {
  // a patron's commands, which a patron sends for themselves and a librarian for anyone

  renamePatron: (auth, txn, cmd) => {
    auth.authorize(isLibrarianOr(txn, auth, cmd.room, cmd.id));
    requirePatron(txn, cmd.room, cmd.id);
    return { stream: patronStream(cmd.room, cmd.id), event: cmd };
  },
  tryHold: (auth, txn, cmd) => {
    auth.authorize(isLibrarianOr(txn, auth, cmd.room, cmd.patron));
    requirePatron(txn, cmd.room, cmd.patron);
    if ('book' in cmd.target) {
      requireBook(txn, cmd.room, cmd.target.book);
    } else {
      requireEdition(txn, cmd.room, cmd.target.edition);
    }
    if (txn.get.hold(cmd.room, cmd.id) !== undefined) throw new Reject('hold exists');
    return outcomes.tryHold(txn, cmd);
  },
  cancelHold: (auth, txn, cmd) => {
    auth.authorize(isLibrarianOr(txn, auth, cmd.room, cmd.patron));
    if (txn.get.patron_hold(cmd.room, cmd.patron, cmd.id) === undefined) {
      throw new Reject('no such hold');
    }
    return outcomes.cancelHold(txn, cmd, parseUser(auth.user)?.id !== cmd.patron);
  },
  patronDismissNotice: (auth, txn, cmd) => {
    auth.authorize(isLibrarianOr(txn, auth, cmd.room, cmd.patron));
    if (txn.get.patron_notice(cmd.room, cmd.patron, cmd.id) === undefined) {
      throw new Reject('no such notice');
    }
    return { stream: patronStream(cmd.room, cmd.patron), event: cmd };
  },

  // a patron's account, which only its patron changes; the database has checked the proof

  changePassword: (auth, txn, cmd) => {
    auth.authorize(parseUser(auth.user)?.room === cmd.room);
    const { login, id } = ownLogin(txn, auth, cmd.room);
    return [
      {
        stream: `login:${cmd.room}`,
        event: { type: 'password-changed', login, password: cmd.new },
      },
      {
        stream: patronStream(cmd.room, id),
        event: { type: 'patron-password-changed', timestamp: new Date() },
      },
    ];
  },
  deleteAccount: (auth, txn, cmd) => {
    auth.authorize(parseUser(auth.user)?.room === cmd.room);
    const room = cmd.room;
    const { login, id } = ownLogin(txn, auth, room);
    if (!txn.scan.patron_checkout({ room, patron: id }, { keys: true }).next().done) {
      throw new Reject('return every book first');
    }

    /* The account's open holds close with it, in the catalog and the librarians' record of
       their owner, and its patron stream ends with its history erased. */
    const holds = [...txn.scan.patron_hold({ room, patron: id }, { keys: true })].flatMap(
      ({ hold }) => {
        const closed = { type: 'hold-closed', id: hold, reason: 'account deleted' } as const;
        return [
          { stream: bookStream(room), event: closed },
          { stream: adminStream(room), event: closed },
        ];
      },
    );
    return [
      { stream: `login:${room}`, event: { type: 'login-deleted', login, user: id } },
      { stream: patronStream(room, id), death: true, erase: true },
      holds,
    ];
  },

  // the librarians' commands

  addEdition: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    if (txn.get.edition(cmd.room, cmd.isbn) !== undefined) throw new Reject('edition exists');
    return { stream: bookStream(cmd.room), event: cmd };
  },
  updateEditionTitle: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requireEdition(txn, cmd.room, cmd.isbn);
    return { stream: bookStream(cmd.room), event: cmd };
  },
  addBook: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requireEdition(txn, cmd.room, cmd.isbn);
    if (txn.get.book(cmd.room, cmd.id) !== undefined) throw new Reject('book exists');
    return { stream: bookStream(cmd.room), event: cmd };
  },
  updateBookRestricted: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requireBook(txn, cmd.room, cmd.id);
    return outcomes.updateBookRestricted(txn, cmd);
  },
  removeBook: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requireBook(txn, cmd.room, cmd.id);
    // a checkout needs its book to end
    const status = txn.get.book(cmd.room, cmd.id)!.status;
    if (status !== undefined && 'checkout' in status) throw new Reject('the book is checked out');
    return outcomes.removeBook(txn, cmd);
  },
  assignPatron: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requirePatron(txn, cmd.room, cmd.id);
    return outcomes.assignPatron(txn, cmd);
  },
  tryCheckout: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    requirePatron(txn, cmd.room, cmd.patron);
    requireBook(txn, cmd.room, cmd.book);
    if (txn.get.checkout(cmd.room, cmd.id) !== undefined) throw new Reject('checkout exists');
    return outcomes.tryCheckout(txn, cmd);
  },
  endCheckout: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    if (txn.get.patron_checkout(cmd.room, cmd.patron, cmd.checkout) === undefined) {
      throw new Reject('no such checkout');
    }
    return outcomes.endCheckout(txn, cmd);
  },
  dismissNotice: (auth, txn, cmd) => {
    auth.authorize(isLibrarian(txn, auth, cmd.room));
    if (txn.get.admin_notice(cmd.room, cmd.id) === undefined) throw new Reject('no such notice');
    return { stream: adminStream(cmd.room), event: cmd };
  },

  // the database's own command: anyone may sign up in a room, and the account's patron id is new

  createAccount: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (txn.get.room(cmd.room) === undefined) throw new Reject('no such room');
    if (!LOGIN_RE.test(cmd.login)) throw new Reject('a login name is 1 to 64 of [A-Za-z0-9_-]');
    if (txn.get.login(cmd.room, cmd.login) !== undefined) throw new Reject('login taken');
    if (cmd.color !== undefined && !COLOR_RE.test(cmd.color)) {
      throw new Reject('a color is #rrggbb in lowercase hex');
    }

    // without a color of its own, the account takes the next of the patrons' colors
    const patrons = [...txn.scan.patron({ room: cmd.room }, { keys: true })].length;
    const color = cmd.color ?? PATRON_COLORS[patrons % PATRON_COLORS.length];
    const id = crypto.randomUUID();
    return [
      {
        stream: `login:${cmd.room}`,
        event: {
          type: 'login-created',
          login: cmd.login,
          user: id,
          password: cmd.password,
          librarian: false,
        },
      },
      {
        stream: patronStream(cmd.room, id),
        event: { type: 'patron-created', id, name: cmd.name, color },
      },
    ];
  },

  // room stuff; for hosting a demo with many rooms

  // anyone may create a room; for one that exists it writes nothing, otherwise it seeds the room
  createRoom: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (!ROOM_RE.test(cmd.room)) throw new Reject('a room id is a lowercase uuid');
    if (txn.get.room(cmd.room) !== undefined) return [];
    const created = { type: 'room-created', room: cmd.room, created: new Date() } as const;
    return [
      { stream: 'rooms', event: created },
      { stream: `room:${cmd.room}`, event: created },
      ...seed(cmd.room),
    ];
  },
};

/* The daily sheet, at midnight UTC: closed-ended holds past their expiry close, and checkouts past
   theirs become overdue.  It sweeps every room's catalog for open holds and checkouts, and reads
   whose each one is from the librarians' record of their owners. */
function dailySheet(txn: Txn, now: Date): LibraryDBOutput[] {
  const out: LibraryDBOutput[] = [];
  for (const [{ room, hold }, h] of txn.scan.hold()) {
    if (h.expires === undefined || h.expires > now) continue;
    out.push(...closeHold(txn, room, hold, holderOf(txn, room, hold), 'it expired', true));
  }
  for (const [{ room, checkout }, c] of txn.scan.checkout()) {
    if (c.overdue || c.expires > now) continue;
    const patron = txn.get.checkout_owner(room, checkout);
    if (patron === undefined) throw new Error('no such checkout');
    out.push(
      { stream: bookStream(room), event: { type: 'checkout-overdue', id: checkout } },
      {
        stream: patronStream(room, patron),
        event: { type: 'patron-checkout-overdue', id: checkout },
      },
    );
  }
  return out;
}

const cron = Cron.install<LibraryDBTypes<Plugins>>({
  'daily-sheet': { spec: '@daily', hook: (txn, tick) => dailySheet(txn, tick.now) },
  // room stuff: every minute, the rooms an hour old are erased
  'reap-rooms': { spec: '* * * * *', hook: reapRooms },
});

defineLibraryDB<Plugins>({
  reducers: {
    book: bookReducers,
    patron: patronReducers,
    admin: adminReducers,
    login: loginReducers,
    // room stuff
    room: roomReducers,
    rooms: roomRegistryReducers,
  },
  precommit,
  // a patron may see their room's catalog and their own record, and a librarian everything
  // synced in the room; everyone in a room sees the room's own record
  maySee: (txn, principal) => {
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
