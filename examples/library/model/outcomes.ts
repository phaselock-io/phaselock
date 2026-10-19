/* What each command an Engine sends writes, once the database has accepted it.  The database's
   precommit checks who sent a command and that what it names exists, then answers its outcome
   from here; each Engine's forecasters answer the same outcome, over what the Engine has synced,
   so the UI shows a hold or a checkout as the database will most likely decide it.

   The outcomes of the commands a patron sends read only the catalog and the patrons, which every
   Engine and the database hold; a patron's Engine holds only that patron, which is all those read
   of the patrons.  The outcomes of the librarians' own commands also read the owner of a hold from
   the admin slice, which only the librarians' Engine and the database hold.  Every command names
   its room, and an outcome reads and writes that room alone. */

import type {
  AddBook,
  AddBookOutput,
  AddEdition,
  AddEditionOutput,
  AdminEngineTxn,
  AssignPatron,
  AssignPatronOutput,
  CancelHold,
  CancelHoldOutput,
  DismissNotice,
  DismissNoticeOutput,
  EndCheckout,
  EndCheckoutOutput,
  HoldClosed,
  HoldOpened,
  PatronDismissNotice,
  PatronDismissNoticeOutput,
  PatronHoldClosed,
  PatronHoldOpened,
  RemoveBook,
  RemoveBookOutput,
  RenamePatron,
  RenamePatronOutput,
  TryCheckout,
  TryCheckoutOutput,
  TryHold,
  TryHoldOutput,
  UpdateBookRestricted,
  UpdateBookRestrictedOutput,
  UpdateEditionTitle,
  UpdateEditionTitleOutput,
  UserEngineTxn,
} from './model.gen';

const DAY = 24 * 60 * 60 * 1000;
// how long a closed-ended hold lasts
const HOLD_DAYS = 5;
// how long a checkout lasts before it is overdue
const CHECKOUT_DAYS = 60;
// how many holds and checkouts together a patron who is not a researcher may have
const MAX_HOLDS = 5;
// how many overdue checkouts bar a patron from new holds and checkouts
const MAX_OVERDUE = 2;

// what the outcomes read: every Engine's state, and the librarians'
type Txn = UserEngineTxn;
type AdminTxn = AdminEngineTxn;

/** the streams of a room's catalog, librarians' records, and each patron */
export const bookStream = (room: string) => `book:${room}` as const;
export const adminStream = (room: string) => `admin:${room}` as const;
export const patronStream = (room: string, patron: string) => `patron:${room},${patron}` as const;

function patronOf(txn: Txn, room: string, patron: string) {
  const p = txn.get.patron(room, patron);
  if (p === undefined) throw new Error('no such patron');
  return p;
}

function bookOf(txn: Txn, room: string, book: string) {
  const b = txn.get.book(room, book);
  if (b === undefined) throw new Error('no such book');
  return b;
}

// a patron's open holds and checkouts, and how many of those checkouts are overdue
function loadOf(txn: Txn, room: string, patron: string) {
  const holds = [...txn.scan.patron_hold({ room, patron }, { keys: true })].length;
  let checkouts = 0;
  let overdue = 0;
  for (const [, checkout] of txn.scan.patron_checkout({ room, patron })) {
    checkouts++;
    if (checkout.overdue) overdue++;
  }
  return { holds, checkouts, overdue };
}

/** the copies of an edition an edition-level hold can still claim: those unrestricted and free,
    less the edition-level holds already open */
export function freeCopies(txn: Txn, room: string, isbn: string): number {
  let free = 0;
  for (const { book } of txn.scan.edition_book({ room, isbn }, { keys: true })) {
    const b = txn.get.book(room, book);
    if (b !== undefined && b.status === undefined && !b.restricted) free++;
  }
  return free - [...txn.scan.edition_hold({ room, isbn }, { keys: true })].length;
}

// the title of what a hold targets, which names it in a patron's notices
function titleOf(txn: Txn, room: string, target: { book: string } | { edition: string }): string {
  const isbn = 'book' in target ? bookOf(txn, room, target.book).isbn : target.edition;
  return txn.get.edition(room, isbn)?.title ?? isbn;
}

/** The events that close a hold: the catalog's, the librarians' record of its owner's, and its
    patron's, which says why.  notify is whether the patron is told with a notice, as they are of
    every close they did not make. */
export function closeHold(
  txn: Txn,
  room: string,
  hold: string,
  patron: string,
  why: string,
  notify: boolean,
): [
  { stream: `book:${string}`; event: HoldClosed },
  { stream: `admin:${string}`; event: HoldClosed },
  { stream: `patron:${string},${string}`; event: PatronHoldClosed },
] {
  const h = txn.get.hold(room, hold);
  if (h === undefined) throw new Error('no such hold');
  const reason = `Your hold on ${titleOf(txn, room, h.target)} closed: ${why}`;
  const closed = { type: 'hold-closed', id: hold, reason } as const;
  return [
    { stream: bookStream(room), event: closed },
    { stream: adminStream(room), event: closed },
    {
      stream: patronStream(room, patron),
      event: { type: 'patron-hold-closed', id: hold, reason, notify },
    },
  ];
}

/** the patron who owns an open hold, as the librarians' record names them */
export function holderOf(txn: AdminTxn, room: string, hold: string): string {
  const patron = txn.get.hold_owner(room, hold);
  if (patron === undefined) throw new Error('no such hold');
  return patron;
}

// when a free unrestricted copy of an edition leaves the pool, the edition-level holds that no
// longer fit close, newest first
function overflow(txn: AdminTxn, room: string, isbn: string, why: string) {
  const excess = 1 - freeCopies(txn, room, isbn);
  if (excess <= 0) return [];
  const holds = [...txn.scan.edition_hold({ room, isbn }, { keys: true })]
    .flatMap(({ hold }) => txn.get.hold(room, hold) ?? [])
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return holds
    .slice(0, excess)
    .flatMap((h) => closeHold(txn, room, h.id, holderOf(txn, room, h.id), why, true));
}

// a hold opens, or fails with a notice to its patron
function tryHold(txn: Txn, cmd: TryHold): TryHoldOutput {
  const room = cmd.room;
  const fail = (why: string): TryHoldOutput => ({
    stream: patronStream(room, cmd.patron),
    event: {
      type: 'hold-failed',
      id: cmd.id,
      reason: `Your hold on ${titleOf(txn, room, cmd.target)} could not be placed: ${why}`,
    },
  });

  // the patron's own limits
  const patron = patronOf(txn, room, cmd.patron);
  if (cmd.open && !patron.researcher) return fail('only a researcher may hold open-ended');
  const load = loadOf(txn, room, cmd.patron);
  if (!patron.researcher && load.holds + load.checkouts >= MAX_HOLDS) {
    return fail(`too many holds (${load.holds}) and checkouts (${load.checkouts})`);
  }
  if (load.overdue >= MAX_OVERDUE) return fail('too many overdue checkouts');

  // is the hold on one book?
  let isbn: string;
  if ('book' in cmd.target) {
    // the book itself must be free, and a restricted one is for researchers
    const book = bookOf(txn, room, cmd.target.book);
    if (book.restricted && !patron.researcher) return fail('only a researcher may hold this book');
    if (book.status !== undefined) {
      return fail('hold' in book.status ? 'the book is already held' : 'the book is checked out');
    }
    // a restricted book is outside the pool that edition-level holds claim from
    if (book.restricted) return opened(cmd);
    isbn = book.isbn;
  } else {
    isbn = cmd.target.edition;
  }

  // The hold takes one copy from the pool of the edition's unrestricted copies.
  /* If you are arriving here from the demo, this is the line that generates the error message you
     see after following the steps.  The business logic is expressed as a plain TypeScript function,
     typed according to what model.tsp declares.  The same logic provides both database consistency
     and optimistic updates, because this function is called from both `precommit.tryHold()` (db.ts)
     and `userForecasters.tryHold()` (ui.ts). */
  if (freeCopies(txn, room, isbn) < 1) return fail('every copy is already held or checked out');
  return opened(cmd);
}

// the events of a hold that opens; a closed-ended hold expires some days after it was placed
function opened(cmd: TryHold): TryHoldOutput {
  const hold: HoldOpened = {
    type: 'hold-opened',
    id: cmd.id,
    target: cmd.target,
    timestamp: cmd.timestamp,
  };
  const own: PatronHoldOpened = { type: 'patron-hold-opened', id: cmd.id, target: cmd.target };
  if (!cmd.open) {
    hold.expires = own.expires = new Date(cmd.timestamp.getTime() + HOLD_DAYS * DAY);
  }
  return [
    { stream: bookStream(cmd.room), event: hold },
    { stream: patronStream(cmd.room, cmd.patron), event: own },
    {
      stream: adminStream(cmd.room),
      event: { type: 'hold-owner', hold: cmd.id, patron: cmd.patron },
    },
  ];
}

// a checkout opens, closing the patron's own hold on the book if they have one, or fails with a
// notice to the librarians
function tryCheckout(txn: Txn, cmd: TryCheckout): TryCheckoutOutput {
  const room = cmd.room;
  const fail = (reason: string): TryCheckoutOutput => [
    {
      stream: adminStream(room),
      event: { type: 'checkout-failed', id: cmd.id, patron: cmd.patron, book: cmd.book, reason },
    },
  ];

  // the book must not be out, and a restricted one is for researchers
  const patron = patronOf(txn, room, cmd.patron);
  const book = bookOf(txn, room, cmd.book);
  if (book.status !== undefined && 'checkout' in book.status) {
    return fail('the book is already checked out');
  }
  if (book.restricted && !patron.researcher) return fail('the book is restricted');

  // the patron's own hold on this book, or on its edition
  let ours: string | undefined;
  if (book.status !== undefined) {
    const held = txn.get.patron_hold(room, cmd.patron, book.status.hold);
    if (held !== undefined) ours = book.status.hold;
  } else {
    for (const [{ hold }, h] of txn.scan.patron_hold({ room, patron: cmd.patron })) {
      if ('edition' in h.target && h.target.edition === book.isbn) {
        ours = hold;
        break;
      }
    }
  }

  /* The domain does not say whether the hold limit and the overdue rule apply to checkouts; they
     do here.  A checkout that fulfills the patron's own hold takes no new place in the limit. */
  const load = loadOf(txn, room, cmd.patron);
  if (!patron.researcher && ours === undefined && load.holds + load.checkouts >= MAX_HOLDS) {
    return fail(`too many holds (${load.holds}) and checkouts (${load.checkouts})`);
  }
  if (load.overdue >= MAX_OVERDUE) return fail('too many overdue checkouts');

  // without a hold of their own, the patron may not take a copy someone else holds
  if (ours === undefined) {
    if (book.status !== undefined) return fail('the book is held by someone else');
    if (!book.restricted && freeCopies(txn, room, book.isbn) < 1) {
      return fail('every copy is held by someone else');
    }
  }

  // the checkout opens
  const expires = new Date(cmd.timestamp.getTime() + CHECKOUT_DAYS * DAY);
  const out: TryCheckoutOutput = [
    {
      stream: bookStream(room),
      event: {
        type: 'checkout-opened',
        id: cmd.id,
        book: cmd.book,
        expires,
        timestamp: cmd.timestamp,
      },
    },
    {
      stream: patronStream(room, cmd.patron),
      event: { type: 'patron-checkout-opened', id: cmd.id, book: cmd.book, expires },
    },
    {
      stream: adminStream(room),
      event: { type: 'checkout-owner', checkout: cmd.id, patron: cmd.patron },
    },
  ];

  // and the hold it fulfills closes
  if (ours !== undefined) out.push(...closeHold(txn, room, ours, cmd.patron, 'checked out', false));
  return out;
}

// a hold canceled by a librarian rather than its patron notifies the patron
function cancelHold(txn: Txn, cmd: CancelHold, byLibrary: boolean): CancelHoldOutput {
  const why = byLibrary ? 'canceled by the library' : 'canceled';
  return closeHold(txn, cmd.room, cmd.id, cmd.patron, why, byLibrary);
}

function endCheckout(_txn: Txn, cmd: EndCheckout): EndCheckoutOutput {
  const ended = { type: 'checkout-ended', id: cmd.checkout, timestamp: cmd.timestamp } as const;
  return [
    { stream: bookStream(cmd.room), event: ended },
    { stream: adminStream(cmd.room), event: ended },
    {
      stream: patronStream(cmd.room, cmd.patron),
      event: { type: 'patron-checkout-ended', id: cmd.checkout },
    },
  ];
}

/* Restricting a book closes a book-level hold on it by a patron who is not a researcher, and takes
   a free copy out of the pool, which closes the edition-level holds that no longer fit.  The holds
   close ahead of the change, as they do for every command that closes holds. */
function updateBookRestricted(
  txn: AdminTxn,
  cmd: UpdateBookRestricted,
): UpdateBookRestrictedOutput {
  const room = cmd.room;
  const book = bookOf(txn, room, cmd.id);
  const out: UpdateBookRestrictedOutput = [];

  // is the book newly restricted?
  if (cmd.restricted && !book.restricted) {
    if (book.status === undefined) {
      out.push(...overflow(txn, room, book.isbn, 'a copy was restricted'));
    } else if ('hold' in book.status) {
      const holder = holderOf(txn, room, book.status.hold);
      if (!patronOf(txn, room, holder).researcher) {
        const why = 'the book was restricted';
        out.push(...closeHold(txn, room, book.status.hold, holder, why, true));
      }
    }
  }
  out.push({ stream: bookStream(room), event: cmd });
  return out;
}

// removing a book closes a book-level hold on it, or takes a free copy out of the pool
function removeBook(txn: AdminTxn, cmd: RemoveBook): RemoveBookOutput {
  const room = cmd.room;
  const book = bookOf(txn, room, cmd.id);
  const out: RemoveBookOutput = [];
  if (book.status !== undefined && 'hold' in book.status) {
    const holder = holderOf(txn, room, book.status.hold);
    out.push(...closeHold(txn, room, book.status.hold, holder, 'the book was removed', true));
  } else if (book.status === undefined && !book.restricted) {
    out.push(...overflow(txn, room, book.isbn, 'a copy was removed'));
  }
  out.push({ stream: bookStream(room), event: cmd });
  return out;
}

// a patron who is no longer a researcher loses their holds on restricted books
function assignPatron(txn: Txn, cmd: AssignPatron): AssignPatronOutput {
  const room = cmd.room;
  const out: AssignPatronOutput = [];
  if (!cmd.researcher) {
    for (const [{ hold }, h] of txn.scan.patron_hold({ room, patron: cmd.id })) {
      if ('book' in h.target && txn.get.book(room, h.target.book)?.restricted) {
        out.push(...closeHold(txn, room, hold, cmd.id, 'you are no longer a researcher', true));
      }
    }
  }
  out.push({ stream: patronStream(room, cmd.id), event: cmd });
  return out;
}

// the commands that are their own events, each on the stream it names

function renamePatron(_txn: Txn, cmd: RenamePatron): RenamePatronOutput {
  return { stream: patronStream(cmd.room, cmd.id), event: cmd };
}

function patronDismissNotice(_txn: Txn, cmd: PatronDismissNotice): PatronDismissNoticeOutput {
  return { stream: patronStream(cmd.room, cmd.patron), event: cmd };
}

function addEdition(_txn: Txn, cmd: AddEdition): AddEditionOutput {
  return { stream: bookStream(cmd.room), event: cmd };
}

function updateEditionTitle(_txn: Txn, cmd: UpdateEditionTitle): UpdateEditionTitleOutput {
  return { stream: bookStream(cmd.room), event: cmd };
}

function addBook(_txn: Txn, cmd: AddBook): AddBookOutput {
  return { stream: bookStream(cmd.room), event: cmd };
}

function dismissNotice(_txn: Txn, cmd: DismissNotice): DismissNoticeOutput {
  return { stream: adminStream(cmd.room), event: cmd };
}

/** every outcome, by command, which precommit answers once it has checked the command, and which
    the forecasters answer as the database will most likely decide it */
export const outcomes = {
  renamePatron,
  tryHold,
  cancelHold,
  patronDismissNotice,
  addEdition,
  updateEditionTitle,
  addBook,
  updateBookRestricted,
  removeBook,
  assignPatron,
  tryCheckout,
  endCheckout,
  dismissNotice,
};
