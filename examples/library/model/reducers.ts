/*

from: https://github.com/ddd-by-examples/library

A public library allows patrons to place books on hold at its various library branches. Available
books can be placed on hold only by one patron at any given point in time. Books are either
circulating or restricted, and can have retrieval or usage fees. A restricted book can only be held
by a researcher patron. A regular patron is limited to five holds at any given moment, while a
researcher patron is allowed an unlimited number of holds. An open-ended book hold is active until
the patron checks out the book, at which time it is completed. A closed-ended book hold that is not
completed within a fixed number of days after it was requested will expire. This check is done at
the beginning of a day by taking a look at daily sheet with expiring holds. Only a researcher patron
can request an open-ended hold duration. Any patron with more than two overdue checkouts at a
library branch will get a rejection if trying a hold at that same library branch. A book can be
checked out for up to 60 days. Check for overdue checkouts is done by taking a look at daily sheet
with overdue checkouts. Patron interacts with his/her current holds, checkouts, etc. by taking a
look at patron profile. Patron profile looks like a daily sheet, but the information there is
limited to one patron and is not necessarily daily. Currently a patron can see current holds (not
canceled nor expired) and current checkouts (including overdue).  Also, he/she is able to hold a
book and cancel a hold.

How actually a patron knows which books are there to lend? Library has its catalogue of books where
books are added together with their specific instances. A specific book instance of a book can be
added only if there is book with matching ISBN already in the catalogue. Book must have non-empty
title and price. At the time of adding an instance we decide whether it will be Circulating or
Restricted. This enables us to have book with same ISBN as circulated and restricted at the same
time (for instance, there is a book signed by the author that we want to keep as Restricted)

*/

import {
  AddBook,
  AddEdition,
  AddPatron,
  AdminCommands,
  AdminRX,
  AssignPatron,
  Book,
  BookRX,
  CancelHold,
  DeciderEvents,
  DeciderRX,
  decodeAdminCommands,
  decodeUserCommands,
  Edition,
  EndCheckout,
  EndVHold,
  ExpireHold,
  Hold,
  LibraryEvents,
  NewVCheckout,
  NewVHold,
  NoSet,
  OverdueCheckout,
  PatronRX,
  Reducer,
  RelayRX,
  RemoveBook,
  RenamePatron,
  StatusRX,
  TryCheckout,
  TryHold,
  UpdateBookRestricted,
  UpdateEditionTitle,
  UserCommands,
  UserRX,
  VCheckout,
  VHold,
  VHoldRejected,
  VStatusRX,
} from './model.gen';

// XXX: migrations?

////////////////////////
// Precommit function //
////////////////////////

type AllEvents = BookEvents | PatronEvents | AdminEvents;
type Committable = { stream: string, event: AllEvents};

function* precommitTryCheckout(
  rx: BookRX & PatronRX & AdminRX,
  cmd: TryCheckout,
): Reducer<string | Committable | Committable[] > {
  /* the domain description does not mention if hold limits and overdue restrictions
     apply to checkouts, but let us assume that they do */
  const patron = yield* rx.get.patron(e.patron);
  const book = yield* rx.get.book(e.book);
  const edition = yield* rx.get.edition(book.isbn);

  // sanity check
  if (book.status && 'checkout' in book.status) {
    return 'book is already checked out';
  }

  // restricted books cannot be checked out
  if (!patron.researcher && book.restricted) {
    return 'book is restricted';
  }

  // does this patron have a hold on this book?
  let ourHold: string = '';
  if (book.status?.hold) {
    if (book.status.hold in patron.holds) {
      ourHold = book.status.hold;
    }
  } else {
    for (const hold of Object.keys(edition.holds)) {
      if (hold in patron.holds) {
        ourHold = hold;
        break;
      }
    }
  }

  // would this patron exceed their limit of holds + checkouts?
  if (!patron.researcher && !ourHold) {
    const nholds = Object.keys(patron.holds).length;
    const ncheckouts = Object.keys(patron.checkouts).length;
    if (nholds + ncheckouts >= 5) {
      // too many holds; ignore
      return `too many holds (${nholds}) + checkouts (${ncheckouts})`;
    }
  }

  // does this patron have too many overdue checkouts?
  let overdue = 0;
  for (const checkout_uuid of Object.keys(patron.checkouts)) {
    const checkout = yield* rx.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return 'too many overdue checkouts';
  }

  // is book on hold by someone else?
  if (!ourHold) {
    if (book.status && 'hold' in book.status) {
      return 'book is on hold by someone else';
    }
    if (!book.restricted) {
      const books: Book[] = [];
      for (const book_uuid of Object.keys(edition.books)) {
        const book = yield* rx.get.book(book_uuid);
        // ignore books which have book-level holds or are checked out
        // also ignore restricted books, which must be held specifically
        if (!book.status && !book.restricted) books.push(book);
      }
      if (Object.keys(edition.holds).length >= books.length) {
        return 'all remaining books are already on hold';
      }
    }
  }

  // success!

  return [
    // make this checkout known in the public Book shard
    { stream: "book",
      event: {
        type: 'checkout-opened',
        id: cmd.id,
        book: cmd.book,
        timestamp: cmd.timestamp,
      },
    },
    // tell this patron they own the checkout
    { stream: `patron.${cmd.patron}`,
      event: {
        type: 'patron-checkout',
        id: cmd.id,
        patron: cmd.patron,
      },
    },
  ];
}

function mustBeAdmin(auth: Authorize) {
  if ("admin" not in auth.traits) {
    throw Reject("unauthorized");
  }
  auth.set(true);
}

function editionMustExist(txn) {
  if (txn.get.edition(e.isbn) === undefined) {
    throw Reject("no such edition");
  }
}

const precommit: Precommit = {
  addEdition(txn, auth, cmd) {
    mustBeAdmin(auth);
    return { stream: 'book', event: cmd };
  },
  updateEditionTitle(txn, auth, cmd) {
    mustBeAdmin(auth);
    editionMustExit(txn, cmd.edition);
    return { stream: 'book', event: cmd };
  },
  addBook(txn, auth, cmd) {
    mustBeAdmin(auth);
    editionMustExit(txn, cmd.edition);
    return { stream: 'book', event: cmd };
  },
  updateBookRestricted(txn, auth, cmd) {
    mustBeAdmin(auth);
    bookMustExit(txn, cmd.book);
    return { stream: 'book', event: cmd };
  },
  removeBook(txn, auth, cmd) {
    mustBeAdmin(auth);
    bookMustExit(txn, cmd.book);
    return { stream: 'book', event: cmd };
  },
  tryCheckout(txn, auth, cmd) {
    mustBeAdmin(auth);
    patronMustExist(txn, cmd.patron);
    bookMustExit(txn, cmd.book);
    return precommitTryCheckout(txn, auth.principal, cmd);
  },
  // XXX finishme
}

// precommit is NOT called if:
//   - the commandId is not unique
//   - the command is not structurally valid
//
// after postcommit, events are rejected if:
//   - a NewUUID field is not unique
//
// precommit needs injected:
//   - user identity
function* precommit(
  rx: BookRX & PatronRX & AdminRX,
  cmd: UserCommands | AdminCommands,
  user: UserIdentity,
): Reducer<string | Committable | Committable[] > {
  switch (cmd.data.type) {
    // admin-only commands that can land directly as events
    case 'add-edition':
      if (!user.admin) return 'unauthorized';
      return { stream: "book", event: cmd };

    case 'update-edition-title':
    case 'add-book':
      if (!user.admin) return 'unauthorized';
      if (!(yield* rx.get.edition(e.isbn))) return 'no such edition';
      return { stream: "book", event: cmd };

    case 'update-book-restricted':
    case 'remove-book':
      if (!user.admin) return 'unauthorized';
      if (!(yield* rx.get.book(e.id))) return 'no such book';
      return { stream: "book", event: cmd };

    case 'end-checkout':
      if (!user.admin) return 'unauthorized';
      if (!(yield* rx.get.checkout(e.checkout))) return 'no such checkout';
      return { stream: "book", event: cmd };

    case 'add-patron':
    case 'assign-patron':
      if (!user.admin) return 'unauthorized';
      return { stream: `patron.${cmd.id}`, event: cmd };

    // admin-only commands which are not 1:1
    case 'try-checkout':
      if (!user.admin) return 'unauthorized';
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      if (!(yield* rx.get.book(e.book))) return 'no such book';
      return precommitTryCheckout(rx, cmd);

    // user or admin commands; user commands must be for their own patron id
    case 'rename-patron':
      if (!user.admin && cmd.id !== user.id) return 'unauthorized';
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      return { stream: `patron.${cmd.id}`, event: cmd };

    case 'cancel-hold':
      // for non-admins, they can only cancel one of their own holds
      if (!user.admin || !(yield* rx.get.patron(user.id).holds).some((hold) => hold === cmd.hold)) {
        return 'unauthorized';
      }
      if (!(yield* rx.get.hold(e.id))) return 'no such hold';
      return { stream: "book", event: { type: 'hold-closed', id: cmd.id, reason: 'canceled' } };

    case 'try-hold':
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      if ('book' in e.target) {
        if (!(yield* rx.get.book(e.target.book))) return 'no such book';
      } else {
        if (!(yield* rx.get.edition(e.target.edition))) return 'no such edition';
      }

      // XXX



    case 'rename-patron':
      if (!(yield* rx.get.patron(e.id))) return 'no such patron';
      return '';

    case 'assign-patron':
      if (!(yield* rx.get.patron(e.id))) return 'no such patron';
      return '';

    case 'try-hold':
      // note: we do not worry about non-researcher patrons creating open holds at this point.
      // Those could be caused by a race condition if a researcher places a hold while also being
      // demoted.  Race conditions are handled by the decider, not by us.
      newUuids.push(e.id);
      return '';

    case 'cancel-hold':
      if (!(yield* rx.get.hold(e.id))) return 'no such hold';
      return '';

    default: {
      const _typecheck: never = e;
      return _typecheck;
    }
  }
}

////////////////
// Book Shard //
////////////////

function* reduceAddEdition(rx: BookRX, e: AddEdition): Reducer<void> {
  // add this edition
  yield* rx.set.edition(e.isbn, {
    isbn: e.isbn,
    title: e.title,
    books: {},
    holds: {},
  });
}

function* reduceUpdateEditionTitle(rx: BookRX, e: UpdateEditionTitle): Reducer<void> {
  yield* rx.update.edition(e.isbn, (edition) => (edition.title = e.title));
}

function* reduceAddBook(rx: BookRX, e: AddBook): Reducer<void> {
  // create new book
  yield* rx.set.book(e.id, {
    id: e.id,
    isbn: e.isbn,
    restricted: e.restricted,
    timestamp: e.timestamp,
  });
  // add book to edition
  yield* rx.update.edition(e.isbn, (edition) => (edition.books[e.id] = true));
}

type RebalanceRX = BookRX & NoSet<StatusRX | VStatusRX> & PatronRX;

// End the most-recently-added edition-level holds until holds <= available unrestricted books.
// Returns IDs of ended holds.  Caller must emit end-vhold decider events for each.
function* rebalanceEditionHolds(rx: RebalanceRX, edition: Edition): Reducer<string[]> {
  const editionHoldIds = Object.keys(edition.holds);
  if (editionHoldIds.length === 0) return [];
  let available = 0;
  for (const bookId of Object.keys(edition.books)) {
    const b = yield* rx.get.book(bookId);
    if (!b.status && !b.restricted) available++;
  }
  if (editionHoldIds.length <= available) return [];
  // sort holds by timestamp descending so we end the most recent first
  const holds = [];
  for (const holdId of editionHoldIds) {
    holds.push(yield* rx.get.hold(holdId));
  }
  holds.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const invalidHolds: string[] = [];
  while (holds.length > available) {
    const hold = holds.shift()!;
    delete edition.holds[hold.id];
    yield* rx.del.hold(hold.id);
    if (hold.patron) {
      yield* rx.update.patron(hold.patron, (p) => delete p.holds[hold.id]);
    }
    // TODO: should also update active_holds, but it's only in StatusRX, not VStatusRX
    invalidHolds.push(hold.id);
  }
  return invalidHolds;
}

// returns nowInvalidHolds (edition-level holds that exceed available unrestricted books)
function* reduceUpdateBookRestricted(rx: RebalanceRX, e: UpdateBookRestricted): Reducer<string[]> {
  const book = yield* rx.get.book(e.id);
  // be idempotent
  if (book.restricted === e.restricted) return [];
  book.restricted = e.restricted;
  yield* rx.set.book(e.id, book);
  if (!e.restricted || book.status) return [];
  // marking an available book restricted shrinks the unrestricted pool
  const edition = yield* rx.get.edition(book.isbn);
  const invalidHolds = yield* rebalanceEditionHolds(rx, edition);
  yield* rx.set.edition(book.isbn, edition);
  return invalidHolds;
}

// returns nowInvalidHolds
function* reduceRemoveBook(rx: RebalanceRX, e: RemoveBook): Reducer<string[]> {
  const book = yield* rx.get.book(e.id);
  yield* rx.del.book(e.id);
  const edition = yield* rx.get.edition(book.isbn);
  delete edition.books[e.id];
  const invalidHolds: string[] = [];
  // if book had a book-level hold, end it
  if (book.status && 'hold' in book.status) {
    const hold = yield* rx.get.hold(book.status.hold);
    yield* rx.del.hold(hold.id);
    if (hold.patron) {
      yield* rx.update.patron(hold.patron, (p) => delete p.holds[hold.id]);
    }
    invalidHolds.push(hold.id);
  }
  // if book was unrestricted and available, the pool shrank; rebalance edition-level holds
  if (!book.restricted && !book.status) {
    invalidHolds.push(...(yield* rebalanceEditionHolds(rx, edition)));
  }
  yield* rx.set.edition(book.isbn, edition);
  return invalidHolds;
}

function* reduceAddPatron(rx: PatronRX, e: AddPatron): Reducer<void> {
  yield* rx.set.patron(e.id, {
    id: e.id,
    name: e.name,
    researcher: e.researcher,
    checkouts: {},
    holds: {},
  });
  yield* rx.update.patrons((patrons) => (patrons[e.id] = true));
}

function* reduceRenamePatron(rx: PatronRX, e: RenamePatron): Reducer<void> {
  yield* rx.update.patron(e.id, (patron) => (patron.name = e.name));
}

// returns nowInvalidHolds
function* reduceAssignPatron(
  rx: PatronRX & BookRX & NoSet<StatusRX | VStatusRX>,
  e: AssignPatron,
): Reducer<string[]> {
  const patron = yield* rx.get.patron(e.id);
  patron.researcher = e.researcher;
  // check for now-invalid holds
  const invalidHolds: string[] = [];
  if (!patron.researcher) {
    for (const hold_uuid of Object.keys(patron.holds)) {
      const hold = yield* rx.get.hold(hold_uuid);
      if ('edition' in hold.target) continue;
      const book = yield* rx.get.book(hold.target.book);
      if (!book.restricted) continue;
      // hold is now invalid!
      invalidHolds.push(hold_uuid);
      // update book as not held
      yield* rx.update.book(hold.target.book, (book) => delete book.status);
      // remove hold from patron (saved at the end)
      delete patron.holds[hold_uuid];
      // delete this hold
      yield* rx.del.hold(hold_uuid);
    }
  }
  yield* rx.set.patron(e.id, patron);
  return invalidHolds;
}

type FullStatusRX = StatusRX & PatronRX & BookRX;

// returns rejection reason, or an empty string
function* reduceTryHold(rx: FullStatusRX, e: TryHold): Reducer<string> {
  // patron checks
  const patron = yield* rx.get.patron(e.patron);
  if (!patron.researcher && e.open) {
    // non-researcher not allowed to issue open hold;
    return 'non-researcher not allowed to issue open hold';
  }
  const nholds = Object.keys(patron.holds).length;
  const ncheckouts = Object.keys(patron.checkouts).length;
  if (!patron.researcher && nholds + ncheckouts >= 5) {
    return `too many holds (${nholds}) + checkouts (${ncheckouts})`;
  }
  let overdue = 0;
  for (const checkout_uuid of Object.keys(patron.checkouts)) {
    const checkout = yield* rx.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return 'too many overdue checkouts';
  }

  let isbn: string;
  let targetsRestrictedBook = false;
  if ('book' in e.target) {
    // hold is targeting a specific book
    const book = yield* rx.get.book(e.target.book);
    targetsRestrictedBook = book.restricted;
    if (!patron.researcher && book.restricted) {
      return 'non-researcher not allowed to issue hold for restricted book';
    }
    if (book.status) {
      if ('hold' in book.status) {
        return 'book is already on hold';
      }
      if ('checkout' in book.status) {
        return 'book is already checked out';
      }
    }
    isbn = book.isbn;
  } else {
    // hold is targeting an edition
    isbn = e.target.edition;
  }

  if (!targetsRestrictedBook) {
    // check for edition-level holds
    const edition = yield* rx.get.edition(isbn);
    const books: Book[] = [];
    for (const book_uuid of Object.keys(edition.books)) {
      const book = yield* rx.get.book(book_uuid);
      // ignore books which have book-level holds or are checked out
      // also ignore restricted books, which must be held specifically
      if (!book.status && !book.restricted) books.push(book);
    }
    if (Object.keys(edition.holds).length >= books.length) {
      return 'all remaining books are already on hold';
    }
  }

  // hold was successful!

  // create the new hold object
  const hold: Hold = {
    id: e.id,
    patron: e.patron,
    target: e.target,
    timestamp: e.timestamp,
  };
  if (!e.open) {
    hold.expires = new Date(e.timestamp.getTime() + 1000 * 60 * 60 * 24 * 5);
  }
  yield* rx.set.hold(e.id, hold);

  if ('book' in e.target) {
    // add the hold to this book
    yield* rx.update.book(e.target.book, (book) => (book.status = { hold: hold.id }));
  } else {
    // add the hold to this edition
    yield* rx.update.edition(e.target.edition, (edition) => (edition.holds[hold.id] = true));
  }

  // update patron.holds
  yield* rx.update.patron(e.patron, (patron) => (patron.holds[e.id] = true));
  // update active_holds
  yield* rx.update.active_holds((holds) => (holds[e.id] = true));

  return '';
}

function* reduceEndHold(rx: FullStatusRX, e: CancelHold | ExpireHold): Reducer<void> {
  // look up the hold
  const hold = yield* rx.get.hold(e.id);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* rx.del.hold(e.id);
  // update hold target (book or edition)
  if ('book' in hold.target) {
    yield* rx.update.book(hold.target.book, (book) => delete book.status);
  } else {
    yield* rx.update.edition(hold.target.edition, (edition) => delete edition.holds[e.id]);
  }
  // update patron
  yield* rx.update.patron(hold.patron, (patron) => delete patron.holds[hold.id]);
  // update active holds
  yield* rx.update.active_holds((active_holds) => delete active_holds[e.id]);
}

// returns rejection reason, or an empty string
function* reduceTryCheckout(rx: FullStatusRX, e: TryCheckout): Reducer<string> {
  /* the domain description does not mention if hold limits and overdue restrictions
     apply to checkouts, but let us assume that they do */

  const patron = yield* rx.get.patron(e.patron);
  const book = yield* rx.get.book(e.book);
  const edition = yield* rx.get.edition(book.isbn);

  // sanity check
  if (book.status && 'checkout' in book.status) {
    return 'book is already checked out';
  }

  // restricted books cannot be checked out
  if (!patron.researcher && book.restricted) {
    return 'book is restricted';
  }

  // does this patron have a hold on this book?
  let ourHold: string = '';
  if (book.status?.hold) {
    if (book.status.hold in patron.holds) {
      ourHold = book.status.hold;
    }
  } else {
    for (const hold of Object.keys(edition.holds)) {
      if (hold in patron.holds) {
        ourHold = hold;
        break;
      }
    }
  }

  // would this patron exceed their limit of holds + checkouts?
  if (!patron.researcher && !ourHold) {
    const nholds = Object.keys(patron.holds).length;
    const ncheckouts = Object.keys(patron.checkouts).length;
    if (nholds + ncheckouts >= 5) {
      // too many holds; ignore
      return `too many holds (${nholds}) + checkouts (${ncheckouts})`;
    }
  }

  // does this patron have too many overdue checkouts?
  let overdue = 0;
  for (const checkout_uuid of Object.keys(patron.checkouts)) {
    const checkout = yield* rx.get.checkout(checkout_uuid);
    if (checkout.overdue) overdue++;
  }
  if (overdue >= 2) {
    return 'too many overdue checkouts';
  }

  // is book on hold by someone else?
  if (!ourHold) {
    if (book.status && 'hold' in book.status) {
      return 'book is on hold by someone else';
    }
    if (!book.restricted) {
      const books: Book[] = [];
      for (const book_uuid of Object.keys(edition.books)) {
        const book = yield* rx.get.book(book_uuid);
        // ignore books which have book-level holds or are checked out
        // also ignore restricted books, which must be held specifically
        if (!book.status && !book.restricted) books.push(book);
      }
      if (Object.keys(edition.holds).length >= books.length) {
        return 'all remaining books are already on hold';
      }
    }
  }

  // success!

  // record a new checkout object
  const checkout = {
    id: e.id,
    book: e.book,
    patron: e.patron,
    expires: new Date(e.timestamp.getTime() + 1000 * 60 * 60 * 24 * 60),
    overdue: false,
  };
  yield* rx.set.checkout(e.id, checkout);

  // update edition if there was an edition-level hold
  if (ourHold && ourHold in edition.holds) {
    delete edition.holds[ourHold];
    yield* rx.set.edition(book.isbn, edition);
  }

  // update book
  book.status = { checkout: e.id };
  yield* rx.set.book(e.book, book);

  // update patron
  if (ourHold) delete patron.holds[ourHold];
  patron.checkouts[checkout.id] = true;
  yield* rx.set.patron(e.patron, patron);

  // update active_checkouts
  yield* rx.update.active_holds((holds) => delete holds[e.id]);

  return '';
}

function* reduceEndCheckout(rx: FullStatusRX, e: EndCheckout): Reducer<void> {
  const checkout = yield* rx.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* rx.del.checkout(e.checkout);
  // update book
  yield* rx.update.book(checkout.book, (book) => delete book.status);
  // update patron
  yield* rx.update.patron(checkout.patron, (patron) => delete patron.checkouts[e.checkout]);
  // update active checkouts
  yield* rx.update.active_checkouts((active_checkouts) => delete active_checkouts[e.checkout]);
}

// reusable for either status or vstatus stores
function* reduceOverdueCheckout(
  rx: NoSet<StatusRX | VStatusRX>,
  e: OverdueCheckout,
): Reducer<void> {
  yield* rx.update.checkout(e.checkout, (checkout) => (checkout.overdue = true));
}

type FullVStatusRX = VStatusRX & BookRX & PatronRX;

function* reduceNewVHold(rx: FullVStatusRX, e: NewVHold, sent: any[]): Reducer<void> {
  // create the vhold
  const hold: VHold = {
    id: e.id,
    target: e.target,
    timestamp: e.timestamp,
  };
  if (e.patron) {
    hold.patron = e.patron;
    // patron-id is guaranteed to be our patron-id, so this is our hold
    yield* rx.update.patron(e.patron, (patron) => (patron.holds[e.id] = true));
    sent.push({ type: 'try-hold', id: e.id });
  }
  // handle special forecasted flag, to indicate unresolved requests
  if (e.forecasted) hold.forecasted = true;
  yield* rx.set.hold(e.id, hold);
  // update hold target (book or edition)
  if ('book' in hold.target) {
    yield* rx.update.book(hold.target.book, (book) => (book.status = { hold: e.id }));
  } else {
    yield* rx.update.edition(hold.target.edition, (edition) => (edition.holds[e.id] = true));
  }
}

function* reduceVHoldRejected(rx: UserRX, e: VHoldRejected, sent: any[]): Reducer<void> {
  yield* rx.update.messages((msgs) => msgs.push(e.reason));
  // the presence of a vhold-rejected means our try-hold has round-tripped
  sent.push({ type: 'try-hold', id: e.id });
}

function* reduceEndVHold(rx: FullVStatusRX, e: EndVHold | CancelHold | ExpireHold): Reducer<void> {
  // look up the hold
  const hold = yield* rx.get.hold(e.id);
  // be idempotent
  if (!hold) return;
  // delete the hold
  yield* rx.del.hold(e.id);
  // update hold target (book or edition)
  if ('book' in hold.target) {
    yield* rx.update.book(hold.target.book, (book) => delete book.status);
  } else {
    yield* rx.update.edition(hold.target.edition, (edition) => delete edition.holds[e.id]);
  }
  // update patron
  if (hold.patron) {
    yield* rx.update.patron(hold.patron, (patron) => delete patron.holds[hold.id]);
  }
}

function* reduceNewVCheckout(rx: FullVStatusRX, e: NewVCheckout): Reducer<void> {
  const checkout: VCheckout = {
    id: e.id,
    book: e.book,
    expires: e.expires,
    overdue: false,
  };
  yield* rx.set.checkout(e.id, checkout);
  if (e.patron) {
    checkout.patron = e.patron;
    // also update our patron object
    yield* rx.update.patron(e.patron, (patron) => (patron.checkouts[e.id] = true));
  }
}

function* reduceVEndCheckout(rx: FullVStatusRX, e: EndCheckout): Reducer<void> {
  const checkout = yield* rx.get.checkout(e.checkout);
  /* no need for idempotency; only the front desk can end a checkout and that system should
     guarantee exactly-once behavior */
  yield* rx.del.checkout(e.checkout);
  // update book
  yield* rx.update.book(checkout.book, (book) => delete book.status);
  // update patron
  if (checkout.patron) {
    yield* rx.update.patron(checkout.patron, (patron) => delete patron.checkouts[checkout.id]);
  }
}

/* ----- compositions of individual reducers ----- */

// The decider and the front desk admin both have access to all events, so we can share the same
// reducer logic for both components.
function* privilegedReducer(rx: AdminRX, events: LibraryEvents[]): Reducer<DeciderEvents[]> {
  const deciderEvents: DeciderEvents[] = [];

  // several event-level reducers return invalid hold uuids, so we'll write a helper
  const asEndVHolds = function* (g: Reducer<string[]>) {
    const invalidHolds = yield* g;
    for (const hold_uuid of invalidHolds) {
      deciderEvents.push({ type: 'end-vhold', id: hold_uuid, timestamp: new Date() });
    }
  };

  for (const e of events) {
    switch (e.type) {
      case 'add-edition':
        yield* reduceAddEdition(rx, e);
        break;
      case 'update-edition-title':
        yield* reduceUpdateEditionTitle(rx, e);
        break;
      case 'add-book':
        yield* reduceAddBook(rx, e);
        break;
      case 'update-book-restricted':
        yield* asEndVHolds(reduceUpdateBookRestricted(rx, e));
        break;
      case 'remove-book':
        yield* asEndVHolds(reduceRemoveBook(rx, e));
        break;

      case 'add-patron':
        yield* reduceAddPatron(rx, e);
        break;
      case 'rename-patron':
        yield* reduceRenamePatron(rx, e);
        break;
      case 'assign-patron':
        yield* asEndVHolds(reduceAssignPatron(rx, e));
        break;

      case 'cancel-hold': // fallthru
      case 'expire-hold':
        yield* reduceEndHold(rx, e);
        break;
      case 'end-checkout':
        yield* reduceEndCheckout(rx, e);
        break;
      case 'overdue-checkout':
        yield* reduceOverdueCheckout(rx, e);
        break;
      case 'try-hold':
        {
          const rejected = yield* reduceTryHold(rx, e);
          if (rejected) {
            deciderEvents.push({
              type: 'vhold-rejected',
              id: e.id,
              reason: rejected,
              patron: e.patron,
            });
          } else {
            // TODO: needs expiration too, I think.
            deciderEvents.push({ ...e, type: 'new-vhold' });
          }
        }
        break;
      case 'try-checkout':
        {
          const rejected = yield* reduceTryCheckout(rx, e);
          if (rejected) {
            // note: there is no VCheckoutRejected event needed in the system
          } else {
            // steal .expires from reach checkout
            const checkout = yield* rx.get.checkout(e.id);
            deciderEvents.push({ ...e, type: 'new-vcheckout', expires: checkout.expires });
          }
        }
        break;

      // ignored events
      case 'new-vhold':
      case 'vhold-rejected':
      case 'end-vhold':
      case 'new-vcheckout':
        break;

      default: {
        const _typecheck: never = e;
        return _typecheck;
      }
    }
  }

  return deciderEvents;
}

export function* deciderReducer(rx: DeciderRX, events: LibraryEvents[]): Reducer<void> {
  // save the deciderEvents we just created
  const deciderEvents = yield* privilegedReducer(rx, events);
  yield* rx.set.decider_events(deciderEvents);
}

// administrator composition of reducers; for ui (priviledged)
export function* adminReducer(rx: AdminRX, events: LibraryEvents[]): Reducer<void> {
  // like deciderReducer, we can use the privilegedReducer, only we then discard the decider events
  yield* privilegedReducer(rx, events);
}

// patron composition of reducers; for ui (unprivileged)
export function* userReducer(rx: UserRX, events: LibraryEvents[]): Reducer<any[]> {
  const sent: any[] = [];
  for (const e of events) {
    // extend read model
    switch (e.type) {
      case 'add-edition':
        yield* reduceAddEdition(rx, e);
        break;
      case 'update-edition-title':
        yield* reduceUpdateEditionTitle(rx, e);
        break;
      case 'add-book':
        yield* reduceAddBook(rx, e);
        break;
      case 'update-book-restricted':
        yield* reduceUpdateBookRestricted(rx, e);
        break;
      case 'remove-book':
        yield* reduceRemoveBook(rx, e);
        break;

      case 'add-patron':
        yield* reduceAddPatron(rx, e);
        break;
      case 'rename-patron':
        yield* reduceRenamePatron(rx, e);
        break;
      case 'assign-patron':
        yield* reduceAssignPatron(rx, e);
        break;

      case 'new-vhold':
        yield* reduceNewVHold(rx, e, sent);
        break;
      case 'vhold-rejected':
        yield* reduceVHoldRejected(rx, e, sent);
        break;
      case 'cancel-hold': // fallthru
      case 'expire-hold': // fallthru
      case 'end-vhold':
        yield* reduceEndVHold(rx, e);
        break;
      case 'new-vcheckout':
        yield* reduceNewVCheckout(rx, e);
        break;
      case 'end-checkout':
        yield* reduceVEndCheckout(rx, e);
        break;
      case 'overdue-checkout':
        yield* reduceOverdueCheckout(rx, e);
        break;

      // events we aren't allowed to receive
      case 'try-hold':
      case 'try-checkout':
        break;

      default: {
        const _typecheck: never = e;
        return _typecheck;
      }
    }
  }
  return sent;
}

export function userForecaster(cmd: UserCommands): LibraryEvents[] {
  switch (cmd.type) {
    // commands which are virtually guaranteed to land don't need any kind of visualization
    case 'rename-patron':
    case 'cancel-hold':
      return [cmd];

    // while commands which are racy need an indicator so the UI can show they're unresolved.
    case 'try-hold':
      return [
        {
          type: 'new-vhold',
          id: cmd.id,
          target: cmd.target,
          open: cmd.open,
          timestamp: cmd.timestamp,
          patron: cmd.patron,
          // here's our special indicator
          forecasted: true,
        },
      ];

    default: {
      const _typecheck: never = cmd;
      return _typecheck;
    }
  }
}

/* ---------- relay logic below ----------

   The relay logic is a little special because it doesn't do anything "intelligent" with the read
   model.  All it needs the read model for is to validate incoming requests, and that is limited to:

     - rejecting broken references, such as changing the title of an edition that doesn't exist
     - rejecting unauthorized operations, like one patron canceling a hold owned by another patron

   In particular, the relay does not reject anything that may be invalid merely due to a race
   condition.  Instead, the decider, which operates after global order has been established, will
   ignore those events in a safe, deterministic way.
*/

function* relayReduceOne(rx: RelayRX, e: LibraryEvents): Reducer<void> {
  switch (e.type) {
    // otheriwse, the read model in the relay is mostly concerned with the existence of objects...
    case 'add-edition':
      yield* rx.set.edition(e.isbn, true);
      break;
    case 'add-book':
      yield* rx.set.book(e.id, true);
      break;
    case 'add-patron':
      yield* rx.set.patron(e.id, true);
      break;
    case 'try-checkout':
      yield* rx.set.checkout(e.id, true);
      break;

    // ...but for holds, we'll need to know which user it belongs to, so we can validate if a
    // cancel-hold is authorized or not
    case 'try-hold':
      yield* rx.set.hold(e.id, { patron: e.patron });
      break;

    // mutations don't matter to us
    case 'update-edition-title':
    case 'update-book-restricted':
    case 'remove-book':
    case 'rename-patron':
    case 'assign-patron':
    case 'cancel-hold':
    case 'expire-hold':
    case 'end-checkout':
    case 'overdue-checkout':
      break;

    // vstatus doesn't matter to us; we do read them from the $all stream but not for the purpose of
    // building state
    case 'new-vhold':
    case 'vhold-rejected':
    case 'end-vhold':
    case 'new-vcheckout':
      break;

    default: {
      const _typecheck: never = e;
      return _typecheck;
    }
  }
}

export function* relayReducer(rx: RelayRX, events: LibraryEvents[]): Reducer<void> {
  for (const e of events) {
    yield* relayReduceOne(rx, e);
  }
}

/* -- validation logic for incoming commands to relay -- */

// Validate incoming commands from a patron.  Returns an error, or an empty string.
function* validatePatronOne(
  rx: RelayRX,
  patron: string,
  e: UserCommands,
  newUuids: string[],
): Reducer<string> {
  switch (e.type) {
    case 'rename-patron':
      if (e.id !== patron) return 'unauthorized rename of other patron';
      // I suppose the relay should not allow a phony login for this to ever occur, but this is
      // a demo without real authentication so we'll leave this line here.
      if (!(yield* rx.get.patron(e.id))) return 'no such patron';
      return '';

    case 'try-hold':
      if (e.patron !== patron) return 'unauthorized hold for of other patron';
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      if ('book' in e.target) {
        if (!(yield* rx.get.book(e.target.book))) return 'no such book';
      } else {
        if (!(yield* rx.get.edition(e.target.edition))) return 'no such edition';
      }
      // note: we do not worry about non-researcher patrons creating open holds at this point.
      // Those could be caused by a race condition if a researcher places a hold while also being
      // demoted.  Race conditions are handled by the decider, not by us.
      newUuids.push(e.id);
      return '';

    case 'cancel-hold': {
      // an admin can cancel a hold for anyone, a patron can only cancel a hold for themself
      const hold = yield* rx.get.hold(e.id);
      if (!hold) return 'no such hold';
      if (hold.patron !== patron) return 'unauthorized cancel-hold for other patron';
      return '';
    }

    default: {
      const _typecheck: never = e;
      return _typecheck;
    }
  }
}

// Validate incoming commands from an admin.  Returns an error, or an empty string.
function* validateAdminOne(rx: RelayRX, e: AdminCommands, newUuids: string[]): Reducer<string> {
  switch (e.type) {
    case 'add-edition':
      newUuids.push(e.isbn);
      return '';

    case 'update-edition-title':
      if (!(yield* rx.get.edition(e.isbn))) return 'no such edition';
      return '';

    case 'add-book':
      if (!(yield* rx.get.edition(e.isbn))) return 'no such edition';
      newUuids.push(e.id);
      return '';

    case 'update-book-restricted':
    case 'remove-book':
      if (!(yield* rx.get.book(e.id))) return 'no such book';
      return '';

    case 'add-patron':
      newUuids.push(e.id);
      return '';

    case 'rename-patron':
      if (!(yield* rx.get.patron(e.id))) return 'no such patron';
      return '';

    case 'assign-patron':
      if (!(yield* rx.get.patron(e.id))) return 'no such patron';
      return '';

    case 'try-hold':
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      if ('book' in e.target) {
        if (!(yield* rx.get.book(e.target.book))) return 'no such book';
      } else {
        if (!(yield* rx.get.edition(e.target.edition))) return 'no such edition';
      }
      // note: we do not worry about non-researcher patrons creating open holds at this point.
      // Those could be caused by a race condition if a researcher places a hold while also being
      // demoted.  Race conditions are handled by the decider, not by us.
      newUuids.push(e.id);
      return '';

    case 'cancel-hold':
      if (!(yield* rx.get.hold(e.id))) return 'no such hold';
      return '';

    case 'try-checkout':
      if (!(yield* rx.get.patron(e.patron))) return 'no such patron';
      if (!(yield* rx.get.book(e.book))) return 'no such book';
      newUuids.push(e.id);
      return '';

    case 'end-checkout':
      if (!(yield* rx.get.checkout(e.checkout))) return 'no such checkout';
      return '';

    default: {
      const _typecheck: never = e;
      return _typecheck;
    }
  }
}

// events shall be raw json (still needs decoding)
// returns [newUuids[], error]
export function* validateAdminCommands(
  rx: RelayRX,
  events: unknown[],
): Reducer<[string[], string]> {
  const newUuids: string[] = [];
  for (const e of events) {
    // check for errors
    const d = decodeAdminCommands(e);
    const err = yield* validateAdminOne(rx, d, newUuids);
    if (err) return [newUuids, err];
    // update our read model between each validation
    yield* relayReduceOne(rx, d);
  }
  return [newUuids, ''];
}

// events shall be raw json (still needs decoding)
// returns [newUuids[], error]
export function* validateUserCommands(
  rx: RelayRX,
  events: unknown[],
  patron: string,
): Reducer<[string[], string]> {
  const newUuids: string[] = [];
  for (const e of events) {
    const d = decodeUserCommands(e);
    const err = yield* validatePatronOne(rx, patron, d, newUuids);
    if (err) return [newUuids, err];
    yield* relayReduceOne(rx, d);
  }
  return [newUuids, ''];
}
