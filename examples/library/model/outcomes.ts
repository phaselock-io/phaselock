/* What each command an Engine sends writes, once the database has accepted it.  The database's
   precommit checks who sent a command and that what it names exists, then answers its outcome
   from here; each Engine's forecasters answer the same outcome, over what the Engine has synced,
   so the UI shows a hold or a checkout as the database will most likely decide it.

   The outcomes of the commands a patron sends read only the catalogue and the patrons, which every
   Engine and the database hold; a patron's Engine holds only that patron, which is all those read
   of the patrons.  The outcomes of the librarians' own commands also read the owner of a hold from
   the admin slice, which only the librarians' Engine and the database hold. */

import type {
  AdminEngineForecasters,
  AdminEngineTxn,
  AssignPatron,
  AssignPatronOutput,
  CancelHold,
  CancelHoldOutput,
  EndCheckout,
  EndCheckoutOutput,
  HoldClosed,
  HoldOpened,
  PatronHoldClosed,
  PatronHoldOpened,
  RemoveBook,
  RemoveBookOutput,
  TryCheckout,
  TryCheckoutOutput,
  TryHold,
  TryHoldOutput,
  UpdateBookRestricted,
  UpdateBookRestrictedOutput,
  UserEngineForecasters,
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

function patronOf(txn: Txn, patron: string) {
  const p = txn.get.patron(patron);
  if (p === undefined) throw new Error('no such patron');
  return p;
}

function bookOf(txn: Txn, book: string) {
  const b = txn.get.book(book);
  if (b === undefined) throw new Error('no such book');
  return b;
}

// a patron's open holds and checkouts, and how many of those checkouts are overdue
function loadOf(txn: Txn, patron: string) {
  const holds = [...txn.scan.patron_hold({ patron }, { keys: true })].length;
  let checkouts = 0;
  let overdue = 0;
  for (const [, checkout] of txn.scan.patron_checkout({ patron })) {
    checkouts++;
    if (checkout.overdue) overdue++;
  }
  return { holds, checkouts, overdue };
}

/** the copies of an edition an edition-level hold can still claim: those unrestricted and free,
    less the edition-level holds already open */
export function freeCopies(txn: Txn, isbn: string): number {
  let free = 0;
  for (const { book } of txn.scan.edition_book({ isbn }, { keys: true })) {
    const b = txn.get.book(book);
    if (b !== undefined && b.status === undefined && !b.restricted) free++;
  }
  return free - [...txn.scan.edition_hold({ isbn }, { keys: true })].length;
}

// the title of what a hold targets, which names it in a patron's notices
function titleOf(txn: Txn, target: { book: string } | { edition: string }): string {
  const isbn = 'book' in target ? bookOf(txn, target.book).isbn : target.edition;
  return txn.get.edition(isbn)?.title ?? isbn;
}

/** The events that close a hold: the catalogue's, the librarians' record of its owner's, and its
    patron's, which says why.  notify is whether the patron is told with a notice, as they are of
    every close they did not make. */
export function closeHold(
  txn: Txn,
  hold: string,
  patron: string,
  why: string,
  notify: boolean,
): [
  { stream: 'book'; event: HoldClosed },
  { stream: 'admin'; event: HoldClosed },
  { stream: `patron:${string}`; event: PatronHoldClosed },
] {
  const h = txn.get.hold(hold);
  if (h === undefined) throw new Error('no such hold');
  const reason = `Your hold on ${titleOf(txn, h.target)} closed: ${why}`;
  const closed = { type: 'hold-closed', id: hold, reason } as const;
  return [
    { stream: 'book', event: closed },
    { stream: 'admin', event: closed },
    {
      stream: `patron:${patron}`,
      event: { type: 'patron-hold-closed', id: hold, reason, notify },
    },
  ];
}

/** the patron who owns an open hold, as the librarians' record names them */
export function holderOf(txn: AdminTxn, hold: string): string {
  const patron = txn.get.hold_owner(hold);
  if (patron === undefined) throw new Error('no such hold');
  return patron;
}

// when a free unrestricted copy of an edition leaves the pool, the edition-level holds that no
// longer fit close, newest first
function overflow(txn: AdminTxn, isbn: string, why: string) {
  const excess = 1 - freeCopies(txn, isbn);
  if (excess <= 0) return [];
  const holds = [...txn.scan.edition_hold({ isbn }, { keys: true })]
    .flatMap(({ hold }) => txn.get.hold(hold) ?? [])
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  return holds
    .slice(0, excess)
    .flatMap((h) => closeHold(txn, h.id, holderOf(txn, h.id), why, true));
}

// a hold opens, or fails with a notice to its patron
function tryHold(txn: Txn, cmd: TryHold): TryHoldOutput {
  const fail = (why: string): TryHoldOutput => ({
    stream: `patron:${cmd.patron}`,
    event: {
      type: 'hold-failed',
      id: cmd.id,
      reason: `Your hold on ${titleOf(txn, cmd.target)} could not be placed: ${why}`,
    },
  });

  // the patron's own limits
  const patron = patronOf(txn, cmd.patron);
  if (cmd.open && !patron.researcher) return fail('only a researcher may hold open-ended');
  const load = loadOf(txn, cmd.patron);
  if (!patron.researcher && load.holds + load.checkouts >= MAX_HOLDS) {
    return fail(`too many holds (${load.holds}) and checkouts (${load.checkouts})`);
  }
  if (load.overdue >= MAX_OVERDUE) return fail('too many overdue checkouts');

  // is the hold on one book?
  let isbn: string;
  if ('book' in cmd.target) {
    // the book itself must be free, and a restricted one is for researchers
    const book = bookOf(txn, cmd.target.book);
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

  // the hold takes one copy from the pool of the edition's unrestricted copies
  if (freeCopies(txn, isbn) < 1) return fail('every copy is already held or checked out');
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
    { stream: 'book', event: hold },
    { stream: `patron:${cmd.patron}`, event: own },
    { stream: 'admin', event: { type: 'hold-owner', hold: cmd.id, patron: cmd.patron } },
  ];
}

// a checkout opens, closing the patron's own hold on the book if they have one, or fails with a
// notice to the librarians
function tryCheckout(txn: Txn, cmd: TryCheckout): TryCheckoutOutput {
  const fail = (reason: string): TryCheckoutOutput => [
    {
      stream: 'admin',
      event: { type: 'checkout-failed', id: cmd.id, patron: cmd.patron, book: cmd.book, reason },
    },
  ];

  // the book must not be out, and a restricted one is for researchers
  const patron = patronOf(txn, cmd.patron);
  const book = bookOf(txn, cmd.book);
  if (book.status !== undefined && 'checkout' in book.status) {
    return fail('the book is already checked out');
  }
  if (book.restricted && !patron.researcher) return fail('the book is restricted');

  // the patron's own hold on this book, or on its edition
  let ours: string | undefined;
  if (book.status !== undefined) {
    if (txn.get.patron_hold(cmd.patron, book.status.hold) !== undefined) ours = book.status.hold;
  } else {
    for (const [{ hold }, h] of txn.scan.patron_hold({ patron: cmd.patron })) {
      if ('edition' in h.target && h.target.edition === book.isbn) {
        ours = hold;
        break;
      }
    }
  }

  /* The domain does not say whether the hold limit and the overdue rule apply to checkouts; they
     do here.  A checkout that fulfills the patron's own hold takes no new place in the limit. */
  const load = loadOf(txn, cmd.patron);
  if (!patron.researcher && ours === undefined && load.holds + load.checkouts >= MAX_HOLDS) {
    return fail(`too many holds (${load.holds}) and checkouts (${load.checkouts})`);
  }
  if (load.overdue >= MAX_OVERDUE) return fail('too many overdue checkouts');

  // without a hold of their own, the patron may not take a copy someone else holds
  if (ours === undefined) {
    if (book.status !== undefined) return fail('the book is held by someone else');
    if (!book.restricted && freeCopies(txn, book.isbn) < 1) {
      return fail('every copy is held by someone else');
    }
  }

  // the checkout opens
  const expires = new Date(cmd.timestamp.getTime() + CHECKOUT_DAYS * DAY);
  const checkout = {
    stream: 'book',
    event: {
      type: 'checkout-opened',
      id: cmd.id,
      book: cmd.book,
      expires,
      timestamp: cmd.timestamp,
    },
  } as const;
  const own = {
    stream: `patron:${cmd.patron}`,
    event: { type: 'patron-checkout-opened', id: cmd.id, book: cmd.book, expires },
  } as const;
  const owner = {
    stream: 'admin',
    event: { type: 'checkout-owner', checkout: cmd.id, patron: cmd.patron },
  } as const;
  if (ours === undefined) return [checkout, own, owner];

  // and the hold it fulfills closes
  return [checkout, own, owner, ...closeHold(txn, ours, cmd.patron, 'checked out', false)];
}

// a hold canceled by a librarian rather than its patron notifies the patron
function cancelHold(txn: Txn, cmd: CancelHold, byLibrary: boolean): CancelHoldOutput {
  const why = byLibrary ? 'canceled by the library' : 'canceled';
  return closeHold(txn, cmd.id, cmd.patron, why, byLibrary);
}

function endCheckout(_txn: Txn, cmd: EndCheckout): EndCheckoutOutput {
  const ended = { type: 'checkout-ended', id: cmd.checkout, timestamp: cmd.timestamp } as const;
  return [
    { stream: 'book', event: ended },
    { stream: 'admin', event: ended },
    { stream: `patron:${cmd.patron}`, event: { type: 'patron-checkout-ended', id: cmd.checkout } },
  ];
}

/* Restricting a book closes a book-level hold on it by a patron who is not a researcher, and takes
   a free copy out of the pool, which closes the edition-level holds that no longer fit.  The holds
   close ahead of the change, as they do for every command that closes holds. */
function updateBookRestricted(
  txn: AdminTxn,
  cmd: UpdateBookRestricted,
): UpdateBookRestrictedOutput {
  const book = bookOf(txn, cmd.id);
  const out: UpdateBookRestrictedOutput = [];

  // is the book newly restricted?
  if (cmd.restricted && !book.restricted) {
    if (book.status === undefined) {
      out.push(...overflow(txn, book.isbn, 'a copy was restricted'));
    } else if ('hold' in book.status) {
      const holder = holderOf(txn, book.status.hold);
      if (!patronOf(txn, holder).researcher) {
        out.push(...closeHold(txn, book.status.hold, holder, 'the book was restricted', true));
      }
    }
  }
  out.push({ stream: 'book', event: cmd });
  return out;
}

// removing a book closes a book-level hold on it, or takes a free copy out of the pool
function removeBook(txn: AdminTxn, cmd: RemoveBook): RemoveBookOutput {
  const book = bookOf(txn, cmd.id);
  const out: RemoveBookOutput = [];
  if (book.status !== undefined && 'hold' in book.status) {
    out.push(
      ...closeHold(
        txn,
        book.status.hold,
        holderOf(txn, book.status.hold),
        'the book was removed',
        true,
      ),
    );
  } else if (book.status === undefined && !book.restricted) {
    out.push(...overflow(txn, book.isbn, 'a copy was removed'));
  }
  out.push({ stream: 'book', event: cmd });
  return out;
}

// a patron who is no longer a researcher loses their holds on restricted books
function assignPatron(txn: Txn, cmd: AssignPatron): AssignPatronOutput {
  const out: AssignPatronOutput = [];
  if (!cmd.researcher) {
    for (const [{ hold }, h] of txn.scan.patron_hold({ patron: cmd.id })) {
      if ('book' in h.target && txn.get.book(h.target.book)?.restricted) {
        out.push(...closeHold(txn, hold, cmd.id, 'you are no longer a researcher', true));
      }
    }
  }
  out.push({ stream: `patron:${cmd.id}`, event: cmd });
  return out;
}

/** every outcome, by command; a command not named here is its own event, on the stream it names */
export const outcomes = {
  tryHold,
  cancelHold,
  tryCheckout,
  endCheckout,
  updateBookRestricted,
  removeBook,
  assignPatron,
};

/** a patron's forecasts: every command they send, as the database will most likely decide it */
export const userForecasters: UserEngineForecasters = {
  renamePatron: (_txn, cmd) => ({ stream: `patron:${cmd.id}`, event: cmd }),
  tryHold,
  cancelHold: (txn, cmd) => cancelHold(txn, cmd, false),
  patronDismissNotice: (_txn, cmd) => ({ stream: `patron:${cmd.patron}`, event: cmd }),
};

/** the librarians' forecasts, which cover every command they send */
export const adminForecasters: AdminEngineForecasters = {
  ...userForecasters,
  // a librarian cancels a hold for its patron
  cancelHold: (txn, cmd) => cancelHold(txn, cmd, true),
  addEdition: (_txn, cmd) => ({ stream: 'book', event: cmd }),
  updateEditionTitle: (_txn, cmd) => ({ stream: 'book', event: cmd }),
  addBook: (_txn, cmd) => ({ stream: 'book', event: cmd }),
  updateBookRestricted,
  removeBook,
  assignPatron,
  tryCheckout,
  endCheckout,
  dismissNotice: (_txn, cmd) => ({ stream: 'admin', event: cmd }),
};
