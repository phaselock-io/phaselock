/* What each mutation an Engine sends writes.  Each Engine's predictors write it over what the
   Engine has synced, so the UI shows a hold or a checkout as the database will most likely decide
   it; the database's deciders check who sent a mutation and that what it names exists, then call
   the same predictor over the database's own state, which carries the mutation out.

   The predictors of the mutations a patron sends read and write only the catalog and the patrons,
   which every Engine and the database hold; a patron's Engine holds only that patron, which is all
   those read of the patrons.  The librarians' record of whose each hold and checkout is lives in
   the admin slice, which only the librarians' Engine and the database hold, so the librarians'
   predictors keep that record too, and read a hold's owner from it.  Every mutation names its
   room, and a predictor reads and writes that room alone.

   A predictor the Engine runs is passed `pending`, and marks the holds and checkouts it opens as
   pending, which the UI shows until the database's edits replace them.  A decider calls a
   predictor without it, so the database never writes the mark. */

import type {
  AdminEnginePredictors,
  AdminEngineTxn,
  Hold,
  TryHold,
  UserEnginePredictors,
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

// what the predictors read and write: every Engine's state, and the librarians'
type Txn = UserEngineTxn;
type AdminTxn = AdminEngineTxn;

// the mark of a hold or checkout that is only a prediction, which only the overlay ever holds
function mark(pending?: true) {
  return pending ? { pending } : {};
}

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
function freeCopies(txn: Txn, room: string, isbn: string): number {
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

// holds //

/** A hold leaves the catalog: its key goes, and so does its mark on its book, or its place in its
    edition's index.  Answers the hold as it was. */
export function releaseHold(txn: Txn, room: string, hold: string): Hold {
  const h = txn.get.hold(room, hold);
  if (h === undefined) throw new Error('no such hold');
  txn.del.hold(room, hold);
  if ('book' in h.target) {
    txn.update.book(room, h.target.book, (book) => delete book.status);
  } else {
    txn.del.edition_hold(room, h.target.edition, hold);
  }
  return h;
}

/* A hold closes in the catalog and for its patron, who learns why.  notify is whether the patron
   is told with a notice, as they are of every close they did not make. */
function closeHold(
  txn: Txn,
  room: string,
  hold: string,
  patron: string,
  why: string,
  notify: boolean,
): void {
  const h = releaseHold(txn, room, hold);
  txn.del.patron_hold(room, patron, hold);
  if (notify) {
    const reason = `Your hold on ${titleOf(txn, room, h.target)} closed: ${why}`;
    txn.set.patron_notice(room, patron, hold, { id: hold, reason });
  }
}

// the patron who owns an open hold, as the librarians' record names them
function holderOf(txn: AdminTxn, room: string, hold: string): string {
  const patron = txn.get.hold_owner(room, hold);
  if (patron === undefined) throw new Error('no such hold');
  return patron;
}

/** a hold closes everywhere it is kept: in the catalog, for the patron the librarians' record
    names, and in that record */
export function closeOwnedHold(
  txn: AdminTxn,
  room: string,
  hold: string,
  why: string,
  notify: boolean,
): void {
  closeHold(txn, room, hold, holderOf(txn, room, hold), why, notify);
  txn.del.hold_owner(room, hold);
}

// when a free unrestricted copy of an edition leaves the pool, the edition-level holds that no
// longer fit close, newest first
function overflow(txn: AdminTxn, room: string, isbn: string, why: string): void {
  const excess = 1 - freeCopies(txn, room, isbn);
  if (excess <= 0) return;
  const holds = [...txn.scan.edition_hold({ room, isbn }, { keys: true })]
    .flatMap(({ hold }) => txn.get.hold(room, hold) ?? [])
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  for (const h of holds.slice(0, excess)) closeOwnedHold(txn, room, h.id, why, true);
}

// a hold opens in the catalog and for its patron; a closed-ended hold expires some days after it
// was placed
function openHold(txn: Txn, m: TryHold, pending?: true): void {
  const expires = m.open ? {} : { expires: new Date(m.timestamp.getTime() + HOLD_DAYS * DAY) };
  const own = { id: m.id, target: m.target, ...expires, ...mark(pending) };
  txn.set.hold(m.room, m.id, { ...own, timestamp: m.timestamp });
  txn.set.patron_hold(m.room, m.patron, m.id, own);

  // a book-level hold marks its book; an edition-level hold claims any free copy
  if ('book' in m.target) {
    const hold = m.id;
    txn.update.book(m.room, m.target.book, (book) => (book.status = { hold }));
  } else {
    txn.set.edition_hold(m.room, m.target.edition, m.id, true);
  }
}

// the tables //

/** a patron's predictions: every mutation they send, as the database will most likely decide it */
export const userPredictors: UserEnginePredictors = {
  renamePatron: (txn, m) => {
    txn.update.patron(m.room, m.id, (patron) => (patron.name = m.name));
  },

  // a hold opens, or fails with a notice to its patron
  tryHold: (txn, m, pending) => {
    const room = m.room;
    const fail = (why: string) => {
      const reason = `Your hold on ${titleOf(txn, room, m.target)} could not be placed: ${why}`;
      txn.set.patron_notice(room, m.patron, m.id, { id: m.id, reason });
    };

    // the patron's own limits
    const patron = patronOf(txn, room, m.patron);
    if (m.open && !patron.researcher) return fail('only a researcher may hold open-ended');
    const load = loadOf(txn, room, m.patron);
    if (!patron.researcher && load.holds + load.checkouts >= MAX_HOLDS) {
      return fail(`too many holds (${load.holds}) and checkouts (${load.checkouts})`);
    }
    if (load.overdue >= MAX_OVERDUE) return fail('too many overdue checkouts');

    // is the hold on one book?
    let isbn: string;
    if ('book' in m.target) {
      // the book itself must be free, and a restricted one is for researchers
      const book = bookOf(txn, room, m.target.book);
      if (book.restricted && !patron.researcher) {
        return fail('only a researcher may hold this book');
      }
      if (book.status !== undefined) {
        return fail('hold' in book.status ? 'the book is already held' : 'the book is checked out');
      }
      // a restricted book is outside the pool that edition-level holds claim from
      if (book.restricted) return openHold(txn, m, pending);
      isbn = book.isbn;
    } else {
      isbn = m.target.edition;
    }

    // The hold takes one copy from the pool of the edition's unrestricted copies.
    /* If you are arriving here from the demo, this is the line that generates the error message
       you see after following the steps.  The business logic is expressed as a plain TypeScript
       function, typed according to what model.tsp declares.  The same logic provides both
       database consistency and optimistic updates, because this predictor runs both in the
       patron's Engine and in the database, where `deciders.tryHold()` (db.ts) calls it through
       the librarians' predictor below. */
    if (freeCopies(txn, room, isbn) < 1) return fail('every copy is already held or checked out');
    openHold(txn, m, pending);
  },

  // a patron cancels their own hold, so no notice
  cancelHold: (txn, m) => {
    releaseHold(txn, m.room, m.id);
    txn.del.patron_hold(m.room, m.patron, m.id);
  },

  patronDismissNotice: (txn, m) => {
    txn.del.patron_notice(m.room, m.patron, m.id);
  },
};

/** The librarians' predictions, which cover every mutation their Engine sends and keep the
    librarians' record of whose each hold and checkout is.  The deciders call these, over the
    database's own state, which holds every slice they write. */
export const adminPredictors: AdminEnginePredictors = {
  // a patron's mutations, which a librarian sends on the patron's behalf

  renamePatron: userPredictors.renamePatron,
  patronDismissNotice: userPredictors.patronDismissNotice,

  // a hold that opens, as the librarians see it: their record names its patron
  tryHold: (txn, m, pending) => {
    userPredictors.tryHold(txn, m, pending);
    if (txn.get.hold(m.room, m.id) !== undefined) txn.set.hold_owner(m.room, m.id, m.patron);
  },

  // a librarian cancels a patron's hold, so the patron is told
  libraryCancelHold: (txn, m) => {
    closeHold(txn, m.room, m.id, m.patron, 'canceled by the library', true);
    txn.del.hold_owner(m.room, m.id);
  },

  // checkouts

  // a checkout opens, closing the patron's own hold on the book if they have one, or fails with a
  // notice to the librarians
  tryCheckout: (txn, m, pending) => {
    const room = m.room;
    const fail = (reason: string) => txn.set.admin_notice(room, m.id, { id: m.id, reason });

    // the book must not be out, and a restricted one is for researchers
    const patron = patronOf(txn, room, m.patron);
    const book = bookOf(txn, room, m.book);
    if (book.status !== undefined && 'checkout' in book.status) {
      return fail('the book is already checked out');
    }
    if (book.restricted && !patron.researcher) return fail('the book is restricted');

    // the patron's own hold on this book, or on its edition
    let ours: string | undefined;
    if (book.status !== undefined) {
      const held = txn.get.patron_hold(room, m.patron, book.status.hold);
      if (held !== undefined) ours = book.status.hold;
    } else {
      for (const [{ hold }, h] of txn.scan.patron_hold({ room, patron: m.patron })) {
        if ('edition' in h.target && h.target.edition === book.isbn) {
          ours = hold;
          break;
        }
      }
    }

    /* The domain does not say whether the hold limit and the overdue rule apply to checkouts;
       they do here.  A checkout that fulfills the patron's own hold takes no new place in the
       limit. */
    const load = loadOf(txn, room, m.patron);
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

    // the hold it fulfills closes
    if (ours !== undefined) closeOwnedHold(txn, room, ours, 'checked out', false);

    // and the checkout opens in the catalog, for its patron, and in the librarians' record
    const expires = new Date(m.timestamp.getTime() + CHECKOUT_DAYS * DAY);
    const checkout = { id: m.id, book: m.book, expires, overdue: false, ...mark(pending) };
    txn.set.checkout(room, m.id, checkout);
    txn.update.book(room, m.book, (b) => (b.status = { checkout: m.id }));
    txn.set.patron_checkout(room, m.patron, m.id, checkout);
    txn.set.checkout_owner(room, m.id, m.patron);
  },

  // a checkout ends in the catalog, for its patron, and in the librarians' record
  endCheckout: (txn, m) => {
    const checkout = txn.get.checkout(m.room, m.checkout);
    if (checkout === undefined) throw new Error('no such checkout');
    txn.del.checkout(m.room, m.checkout);
    txn.update.book(m.room, checkout.book, (book) => delete book.status);
    txn.del.patron_checkout(m.room, m.patron, m.checkout);
    txn.del.checkout_owner(m.room, m.checkout);
  },

  // the catalog

  addEdition: (txn, m) => {
    txn.set.edition(m.room, m.isbn, { isbn: m.isbn, title: m.title });
  },

  updateEditionTitle: (txn, m) => {
    txn.update.edition(m.room, m.isbn, (edition) => (edition.title = m.title));
  },

  addBook: (txn, m) => {
    const book = { id: m.id, isbn: m.isbn, restricted: m.restricted, timestamp: m.timestamp };
    txn.set.book(m.room, m.id, book);
    txn.set.edition_book(m.room, m.isbn, m.id, true);
  },

  /* Restricting a book closes a book-level hold on it by a patron who is not a researcher, and
     takes a free copy out of the pool, which closes the edition-level holds that no longer fit.
     The holds close ahead of the change, as they do for every mutation that closes holds. */
  updateBookRestricted: (txn, m) => {
    const room = m.room;
    const book = bookOf(txn, room, m.id);

    // is the book newly restricted?
    if (m.restricted && !book.restricted) {
      if (book.status === undefined) {
        overflow(txn, room, book.isbn, 'a copy was restricted');
      } else if ('hold' in book.status) {
        const hold = book.status.hold;
        if (!patronOf(txn, room, holderOf(txn, room, hold)).researcher) {
          closeOwnedHold(txn, room, hold, 'the book was restricted', true);
        }
      }
    }
    txn.update.book(room, m.id, (b) => (b.restricted = m.restricted));
  },

  // removing a book closes a book-level hold on it, or takes a free copy out of the pool
  removeBook: (txn, m) => {
    const room = m.room;
    const book = bookOf(txn, room, m.id);
    if (book.status !== undefined && 'hold' in book.status) {
      closeOwnedHold(txn, room, book.status.hold, 'the book was removed', true);
    } else if (book.status === undefined && !book.restricted) {
      overflow(txn, room, book.isbn, 'a copy was removed');
    }
    txn.del.book(room, m.id);
    txn.del.edition_book(room, book.isbn, m.id);
  },

  // patrons and notices

  // a patron who is no longer a researcher loses their holds on restricted books
  assignPatron: (txn, m) => {
    const room = m.room;
    if (!m.researcher) {
      // the patron's holds, gathered before any of them closes
      const holds = [...txn.scan.patron_hold({ room, patron: m.id })];
      for (const [{ hold }, h] of holds) {
        if ('book' in h.target && txn.get.book(room, h.target.book)?.restricted) {
          closeOwnedHold(txn, room, hold, 'you are no longer a researcher', true);
        }
      }
    }
    txn.update.patron(room, m.id, (patron) => (patron.researcher = m.researcher));
  },

  dismissNotice: (txn, m) => {
    txn.del.admin_notice(m.room, m.id);
  },
};
