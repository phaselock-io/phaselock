// The library demo's data model.
//
// from: https://github.com/ddd-by-examples/library
//
// A public library allows patrons to place books on hold at its various library
// branches.  Available books can be placed on hold only by one patron at any given
// point in time.  Books are either circulating or restricted, and can have
// retrieval or usage fees.  A restricted book can only be held by a researcher
// patron.  A regular patron is limited to five holds at any given moment, while a
// researcher patron is allowed an unlimited number of holds.  An open-ended book
// hold is active until the patron checks out the book, at which time it is
// completed.  A closed-ended book hold that is not completed within a fixed number
// of days after it was requested will expire.  This check is done at the beginning
// of a day by taking a look at daily sheet with expiring holds.  Only a researcher
// patron can request an open-ended hold duration.  Any patron with more than two
// overdue checkouts at a library branch will get a rejection if trying a hold at
// that same library branch.  A book can be checked out for up to 60 days.  Check
// for overdue checkouts is done by taking a look at daily sheet with overdue
// checkouts.  Patron interacts with his/her current holds, checkouts, etc. by
// taking a look at patron profile.  Patron profile looks like a daily sheet, but
// the information there is limited to one patron and is not necessarily daily.
// Currently a patron can see current holds (not canceled nor expired) and current
// checkouts (including overdue).  Also, he/she is able to hold a book and cancel a
// hold.
//
// How actually a patron knows which books are there to lend?  Library has its
// catalogue of books where books are added together with their specific
// instances.  A specific book instance of a book can be added only if there is
// book with matching ISBN already in the catalogue.  Book must have non-empty
// title and price.  At the time of adding an instance we decide whether it will be
// Circulating or Restricted.  This enables us to have book with same ISBN as
// circulated and restricted at the same time (for instance, there is a book
// signed by the author that we want to keep as Restricted)
//
// The demo deliberately simplifies the domain: there is one library branch, so the
// overdue-checkout rule counts every overdue checkout, and there are no fees.

import "@phaselock/typespec-core";

using PhaseLock;

alias Uuid = string;
alias Isbn = string;

////////////////
// Book Slice //
////////////////

// The public catalogue: editions, the books of each edition, and the state of every hold and
// checkout, with no patron named anywhere, since every user syncs this slice.  Collections are
// key ranges that readers scan, such as `edition_book.{isbn}.` for the books of one edition.

interface BookSlice extends Slice<"book", BookEvents, BookStore> {}

alias BookStore = {
  "edition.{isbn}": Edition;
  "book.{book}": Book;
  // index: every book of an edition
  "edition_book.{isbn}.{book}": true;
  // one key per open hold; closing a hold deletes its key
  "hold.{hold}": Hold;
  // index: every open edition-level hold of an edition
  "edition_hold.{isbn}.{hold}": true;
  // one key per open checkout; ending a checkout deletes its key
  "checkout.{checkout}": Checkout;
};

model Edition {
  isbn: Isbn;
  title: string;
}

model Book {
  id: Uuid;
  isbn: Isbn;
  restricted: boolean;
  timestamp: utcDateTime;
  // book-level holds and checkouts
  status?: { hold: Uuid } | { checkout: Uuid };
}

model Hold {
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  timestamp: utcDateTime;
  // absent for an open-ended hold
  expires?: utcDateTime;
}

model Checkout {
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  overdue: boolean;
}

union BookEvents {
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
  HoldOpened,
  HoldClosed,
  CheckoutOpened,
  CheckoutEnded,
  CheckoutOverdue,
}

// Edition commands + events //

@command(AddEdition)
model AddEdition {
  type: "add-edition";
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

@command(UpdateEditionTitle)
model UpdateEditionTitle {
  type: "update-edition-title";
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

// Book commands + events //

@command(AddBook)
model AddBook {
  type: "add-book";
  id: Uuid;
  isbn: Isbn;
  restricted: boolean;
  timestamp: utcDateTime;
}

@command(UpdateBookRestricted)
model UpdateBookRestricted {
  type: "update-book-restricted";
  id: Uuid;
  restricted: boolean;
  timestamp: utcDateTime;
}

// rejected while the book is held or checked out
@command(RemoveBook)
model RemoveBook {
  type: "remove-book";
  id: Uuid;
  timestamp: utcDateTime;
}

// Hold commands + events //

// the catalogue learns of the hold and the patron learns it is theirs, or the patron alone
// learns why it failed
@command([HoldOpened, PatronHoldOpened] | HoldFailed)
model TryHold {
  type: "try-hold";
  id: Uuid;
  patron: Uuid;
  // can hold a specific book or just any generic one
  target: { book: Uuid } | { edition: Isbn };
  open: boolean;
  timestamp: utcDateTime;
}

model HoldOpened {
  type: "hold-opened";
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  timestamp: utcDateTime;
  expires?: utcDateTime;
}

@command([HoldClosed, PatronHoldClosed])
model CancelHold {
  type: "cancel-hold";
  id: Uuid;
  patron: Uuid;
}

// sent by the Tick, once it exists
@command([HoldClosed, PatronHoldClosed])
model ExpireHold {
  type: "expire-hold";
  id: Uuid;
  patron: Uuid;
}

model HoldClosed {
  type: "hold-closed";
  id: Uuid;
  reason: string;
}

// Checkout commands + events //

// a checkout that fulfills the patron's own hold also closes it; a failure is a notice to the
// librarians, since a checkout queued offline at the desk can fail after they have moved on
@command(
  | [CheckoutOpened, PatronCheckoutOpened]
  | [CheckoutOpened, PatronCheckoutOpened, HoldClosed, PatronHoldClosed]
  | CheckoutFailed
)
model TryCheckout {
  type: "try-checkout";
  id: Uuid;
  patron: Uuid;
  book: Uuid;
  timestamp: utcDateTime;
}

model CheckoutOpened {
  type: "checkout-opened";
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  timestamp: utcDateTime;
}

@command([CheckoutEnded, PatronCheckoutEnded])
model EndCheckout {
  type: "end-checkout";
  checkout: Uuid;
  patron: Uuid;
  timestamp: utcDateTime;
}

model CheckoutEnded {
  type: "checkout-ended";
  id: Uuid;
  timestamp: utcDateTime;
}

// sent by the Tick, once it exists
@command([CheckoutOverdue, PatronCheckoutOverdue])
model OverdueCheckout {
  type: "overdue-checkout";
  checkout: Uuid;
  patron: Uuid;
  timestamp: utcDateTime;
}

model CheckoutOverdue {
  type: "checkout-overdue";
  id: Uuid;
}

//////////////////
// Patron Slice //
//////////////////

// One patron's own record: their profile, and the holds, checkouts, and notices that are theirs.
// Every hold and checkout change that touches a patron reaches them as an event of their own,
// since a reducer here cannot read the book slice.

interface PatronSlice extends Slice<"patron.{patron}", PatronEvents, PatronStore> {}

alias PatronStore = {
  "patron": Patron;
  "patron_hold.{hold}": PatronHold;
  "patron_checkout.{checkout}": Checkout;
  "patron_notice.{notice}": Notice;
};

model Patron {
  id: Uuid;
  name: string;
  researcher: boolean;
}

model PatronHold {
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  expires?: utcDateTime;
}

// a notice the patron or the librarians dismiss
model Notice {
  id: Uuid;
  reason: string;
}

union PatronEvents {
  PatronCreated,
  RenamePatron,
  AssignPatron,
  PatronHoldOpened,
  PatronHoldClosed,
  HoldFailed,
  PatronCheckoutOpened,
  PatronCheckoutEnded,
  PatronCheckoutOverdue,
  DismissNotice,
}

model PatronCreated {
  type: "patron-created";
  id: Uuid;
  name: string;
}

@command(RenamePatron)
model RenamePatron {
  type: "rename-patron";
  id: Uuid;
  name: string;
  timestamp: utcDateTime;
}

// grants or revokes researcher status
@command(AssignPatron)
model AssignPatron {
  type: "assign-patron";
  id: Uuid;
  researcher: boolean;
  timestamp: utcDateTime;
}

model PatronHoldOpened {
  type: "patron-hold-opened";
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  expires?: utcDateTime;
}

model PatronHoldClosed {
  type: "patron-hold-closed";
  id: Uuid;
  reason: string;
}

// folded into a notice the patron dismisses
model HoldFailed {
  type: "hold-failed";
  id: Uuid;
  reason: string;
}

model PatronCheckoutOpened {
  type: "patron-checkout-opened";
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
}

model PatronCheckoutEnded {
  type: "patron-checkout-ended";
  id: Uuid;
}

model PatronCheckoutOverdue {
  type: "patron-checkout-overdue";
  id: Uuid;
}

// the sender's own notice: an admin dismisses from the librarians' shared inbox, anyone else from
// their own patron stream
@command(DismissNotice)
model DismissNotice {
  type: "dismiss-notice";
  id: Uuid;
}

/////////////////
// Admin Slice //
/////////////////

// The librarians' shared inbox: notices about work that failed after it was queued.

interface AdminSlice extends Slice<"admin", AdminEvents, AdminStore> {}

alias AdminStore = {
  // one key per undismissed notice
  "admin_notice.{notice}": Notice;
};

union AdminEvents {
  CheckoutFailed,
  DismissNotice,
}

model CheckoutFailed {
  type: "checkout-failed";
  id: Uuid;
  patron: Uuid;
  book: Uuid;
  reason: string;
}

/////////////////
// Login Slice //
/////////////////

// Credentials, which the database keeps for itself and never syncs: a hash in a browser cache
// can be cracked offline.  `lookup` reads a login by name to sign someone in.  A login's user
// is the patron it belongs to, except for the one `admin` login every librarian shares, which
// the bundle's bootstrap seeds.

interface LoginSlice extends Slice<"login", LoginEvents, LoginStore> {}

alias LoginStore = {
  // login names are globally unique and never change
  "login.{login}": Login;
  // index: the login name of each user
  "user_login.{user}": string;
};

model Login {
  user: Uuid;
  password: PasswordHash;
}

union LoginEvents {
  LoginCreated,
  PasswordChanged,
  LoginDeleted,
}

// sent with a plain fetch() before signing in, since no Engine exists until someone has
@online
@command([LoginCreated, PatronCreated])
model CreateAccount {
  type: "create-account";
  patron: Uuid;
  login: string;
  name: string;
  password: NewPassword;
}

model LoginCreated {
  type: "login-created";
  login: string;
  user: Uuid;
  password: PasswordHash;
}

// changes the sender's own password
@online
@command(PasswordChanged)
model ChangePassword {
  type: "change-password";
  // CommandAuth could be the existing password, or the TOTP token, or something,
  // but Go has to match it against what lookup() returns or it will be rejected.
  check: CommandAuth;
  new: NewPassword;
}

model PasswordChanged {
  type: "password-changed";
  login: string;
  password: PasswordHash;
}

// deletes the sender's own account; rejected while they have open checkouts, their open holds
// close with the account, and their patron stream ends
@online
@command([LoginDeleted, Death, HoldClosed[]])
model DeleteAccount {
  type: "delete-account";
  check: CommandAuth;
}

model LoginDeleted {
  type: "login-deleted";
  login: string;
  user: Uuid;
}

////////////////////////
// Engine definitions //
////////////////////////

// A patron has very limited write capabilities.  Each of these commands may be sent only for
// their own patron_uuid.
union UserCommands {
  RenamePatron,
  TryHold,
  CancelHold,
  DismissNotice,
  ChangePassword,
  DeleteAccount,
}

interface UserEngine extends Engine<[BookSlice, PatronSlice], UserCommands> {}

// An admin (the librarian at the front desk) has most of the write capabilities in the system,
// except they cannot create decider-specific events.
union AdminCommands {
  // admin can create UserCommands with whatever patron_uuid they want
  UserCommands,
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
  AssignPatron,
  TryCheckout,
  EndCheckout,
}

interface AdminEngine extends Engine<[BookSlice, PatronSlice, AdminSlice], AdminCommands> {}

//////////////////
// The Database //
//////////////////

/* The DB holds all slices and its precommit function handles all commands,
   and it may declare additional slices and commands that no Engine handles.
   Additional slices are maintained for internal use (precommit, maySee, and
   lookup), but are not synced to any client. */
interface LibraryDB extends Database<
  [UserEngine, AdminEngine],
  [LoginSlice],
  DatabaseCommands
> {}

union DatabaseCommands {
  // the daily sweep, sent by the Tick once it exists
  ExpireHold,
  OverdueCheckout,
  // sent before signing in, when there is no Engine to send them
  CreateAccount,
}

/////////////////
// Query Layer //
/////////////////

model AdminBookInfo {
  id: string;
  restricted: boolean;
  state: "open" | "rstr" | "held" | "out";
  patronId?: string;
  holdId?: string;
  checkoutId?: string;
}

model AdminEditionInfo {
  isbn: string;
  title: string;
  books: AdminBookInfo[];
}

interface AdminQueries extends Queries {
  allPatronIds(): Uuid[];
  allPatrons(): Patron[];
  allEditions(): AdminEditionInfo[];
}

model UserCheckoutInfo {
  id: Uuid;
  book: Uuid;
  title: string;
  expires: utcDateTime;
  overdue: boolean;
}

model UserBookInfo {
  isbn: string;
  title: string;
  availableNormal: int32;
  availableRestricted: string[];
  hold: PatronHold | null;
}

// the patron profile: their current holds, and their current checkouts including overdue ones
model UserPatronInfo {
  name: string;
  researcher: boolean;
  holds: PatronHold[];
  checkouts: UserCheckoutInfo[];
}

interface UserQueries extends Queries {
  allBooks(): UserBookInfo[];
  myPatron(): UserPatronInfo;
}
