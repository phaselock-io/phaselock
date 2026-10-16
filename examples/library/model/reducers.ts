// Every slice's reducers: how each event changes the keys of its stream.

import type {
  AdminSliceReducers,
  BookSliceReducers,
  HoldOpened,
  LoginSliceReducers,
  PatronHoldOpened,
  PatronSliceReducers,
} from './model.gen';

// a value the event implies exists; a reducer throws when the state is not what its event implies
function present<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no such ${what}`);
  return value;
}

// the mark of a hold or checkout that is only a forecast, which only the overlay ever holds
function mark(pending: boolean) {
  return pending ? { pending } : {};
}

// a hold as its patron keeps it, which drops what only the catalog keeps
function patronHold(e: HoldOpened | PatronHoldOpened, pending: boolean) {
  const expires = e.expires === undefined ? {} : { expires: e.expires };
  return { id: e.id, target: e.target, ...expires, ...mark(pending) };
}

export const bookReducers: BookSliceReducers = {
  addEdition: (txn, e) => {
    txn.set.edition(e.isbn, { isbn: e.isbn, title: e.title });
  },
  updateEditionTitle: (txn, e) => {
    txn.update.edition(e.isbn, (edition) => (edition.title = e.title));
  },
  addBook: (txn, e) => {
    txn.set.book(e.id, {
      id: e.id,
      isbn: e.isbn,
      restricted: e.restricted,
      timestamp: e.timestamp,
    });
    txn.set.edition_book(e.isbn, e.id, true);
  },
  updateBookRestricted: (txn, e) => {
    txn.update.book(e.id, (book) => (book.restricted = e.restricted));
  },
  removeBook: (txn, e) => {
    const book = present(txn.get.book(e.id), 'book');
    txn.del.book(e.id);
    txn.del.edition_book(book.isbn, e.id);
  },
  holdOpened: (txn, e, pending) => {
    txn.set.hold(e.id, { ...patronHold(e, pending), timestamp: e.timestamp });

    // a book-level hold marks its book; an edition-level hold claims any free copy
    if ('book' in e.target) {
      txn.update.book(e.target.book, (book) => (book.status = { hold: e.id }));
    } else {
      txn.set.edition_hold(e.target.edition, e.id, true);
    }
  },
  holdClosed: (txn, e) => {
    const hold = present(txn.get.hold(e.id), 'hold');
    txn.del.hold(e.id);

    // is it a book-level hold?
    if ('book' in hold.target) {
      // a checkout that fulfills the hold has already replaced it on the book
      txn.update.book(hold.target.book, (book) => {
        if (book.status !== undefined && 'hold' in book.status) delete book.status;
      });
    } else {
      txn.del.edition_hold(hold.target.edition, e.id);
    }
  },
  checkoutOpened: (txn, e, pending) => {
    const checkout = { id: e.id, book: e.book, expires: e.expires, overdue: false };
    txn.set.checkout(e.id, { ...checkout, ...mark(pending) });
    txn.update.book(e.book, (book) => (book.status = { checkout: e.id }));
  },
  checkoutEnded: (txn, e) => {
    const checkout = present(txn.get.checkout(e.id), 'checkout');
    txn.del.checkout(e.id);
    txn.update.book(checkout.book, (book) => delete book.status);
  },
  checkoutOverdue: (txn, e) => {
    txn.update.checkout(e.id, (checkout) => (checkout.overdue = true));
  },
};

export const patronReducers: PatronSliceReducers = {
  patronCreated: (txn, e) => {
    txn.set.patron({ id: e.id, name: e.name, color: e.color, researcher: false });
  },
  renamePatron: (txn, e) => {
    txn.update.patron((patron) => (patron.name = e.name));
  },
  assignPatron: (txn, e) => {
    txn.update.patron((patron) => (patron.researcher = e.researcher));
  },
  patronHoldOpened: (txn, e, pending) => {
    txn.set.patron_hold(e.id, patronHold(e, pending));
  },
  patronHoldClosed: (txn, e) => {
    txn.del.patron_hold(e.id);
    if (e.notify) txn.set.patron_notice(e.id, { id: e.id, reason: e.reason });
  },
  holdFailed: (txn, e) => {
    txn.set.patron_notice(e.id, { id: e.id, reason: e.reason });
  },
  patronCheckoutOpened: (txn, e, pending) => {
    const checkout = { id: e.id, book: e.book, expires: e.expires, overdue: false };
    txn.set.patron_checkout(e.id, { ...checkout, ...mark(pending) });
  },
  patronCheckoutEnded: (txn, e) => {
    txn.del.patron_checkout(e.id);
  },
  patronCheckoutOverdue: (txn, e) => {
    txn.update.patron_checkout(e.id, (checkout) => (checkout.overdue = true));
  },
  patronPasswordChanged: (txn, e) => {
    txn.update.patron((patron) => (patron.passwordChanged = e.timestamp));
  },
  patronDismissNotice: (txn, e) => {
    txn.del.patron_notice(e.id);
  },
};

export const adminReducers: AdminSliceReducers = {
  checkoutFailed: (txn, e) => {
    txn.set.admin_notice(e.id, { id: e.id, reason: e.reason });
  },
  dismissNotice: (txn, e) => {
    txn.del.admin_notice(e.id);
  },
  holdOwner: (txn, e) => {
    txn.set.hold_owner(e.hold, e.patron);
  },
  holdClosed: (txn, e) => {
    txn.del.hold_owner(e.id);
  },
  checkoutOwner: (txn, e) => {
    txn.set.checkout_owner(e.checkout, e.patron);
  },
  checkoutEnded: (txn, e) => {
    txn.del.checkout_owner(e.id);
  },
};

export const loginReducers: LoginSliceReducers = {
  loginCreated: (txn, e) => {
    txn.set.login(e.login, { user: e.user, password: e.password, librarian: e.librarian });
    txn.set.user_login(e.user, e.login);
  },
  passwordChanged: (txn, e) => {
    txn.update.login(e.login, (login) => (login.password = e.password));
  },
  loginDeleted: (txn, e) => {
    txn.del.login(e.login);
    txn.del.user_login(e.user);
  },
};
