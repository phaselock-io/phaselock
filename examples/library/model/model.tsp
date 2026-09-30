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

import "@phaselock/typespec-core";

using PhaseLock;

alias Uuid = string;
alias Isbn = string;

model Setx is Record<true>;

////////////////
// Book Slice //
////////////////

interface BookSlice extends Slice<"book", BookEvents, BookStore> {}

alias BookStore {
  "edition.{edition_isbn}": Edition;
  "editions": Setx;
  "book.{book_uuid}": Book;
  "hold.{hold_uuid}": Hold;
  "checkout.{checkout_uuid}": Checkout;
  "active_holds": Setx;
  "active_checkouts": Setx;
};

model Edition {
  isbn: Isbn;
  title: string;
  books: Setx;
  // edition-level holds
  holds: Setx;
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
  expires?: utcDateTime;
  active?: true;
}

model Checkout {
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  overdue: boolean; // server determination based on expires
  active?: true;
}

union BookEvents {
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
  TryHold,
  CancelHold,
  ExpireHold,
  TryCheckout,
  EndCheckout,
  OverdueCheckout,
}

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

@command(RemoveBook)
model RemoveBook {
  type: "remove-book";
  id: Uuid;
  timestamp: utcDateTime;
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

// Hold commands + events //

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
}

@command(HoldClosed)
model ExpireHold {
  type: "expire-hold";
  id: Uuid;
}

@command(HoldClosed)
model CancelHold {
  type: "cancel-hold";
  id: Uuid;
}

model HoldClosed {
  type: "hold-closed";
  id: Uuid;
  reason: string;
}

// Checkout commands + events //

@command(CheckoutOpened | CheckoutFailed)
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
  timestamp: utcDateTime;
}

model CheckoutFailed {
  type: "checkout-failed";
  id: Uuid;
  reason: string;
}

@command(EndCheckout)
model EndCheckout {
  type: "end-checkout";
  checkout: Uuid;
  timestamp: utcDateTime;
}

// system-generated
@command(OverdueCheckout)
model OverdueCheckout {
  type: "overdue-checkout";
  checkout: Uuid;
  timestamp: utcDateTime;
}

//////////////////
// Patron Slice //
//////////////////

interface PatronSlice extends Slice<"patron.{patron_uuid}", PatronEvents, PatronStore> {}

alias PatronStore = {
  "patron": Patron;
}

model Patron {
  id: Uuid;
  name: string;
  researcher: boolean;
  checkouts: Setx;
  holds: Setx;
}

union PatronEvents {
  AddPatron,
  RenamePatron,
  AssignPatron,
  PatronHoldOpened,
  HoldFailed,
}

model PatronHoldOpened {
  type: "patron-hold-opened";
  id: Uuid;
};

model HoldFailed {
  type: "hold-failed";
  id: Uuid;
  reason: string;
}

@command(AddPatron)
model AddPatron {
  type: "add-patron";
  id: Uuid;
  name: string;
  researcher: boolean;
  timestamp: utcDateTime;
}

@command(RenamePatron)
model RenamePatron {
  type: "rename-patron";
  id: Uuid;
  name: string;
  timestamp: utcDateTime;
}

@command(AssignPatron)
model AssignPatron {
  type: "assign-patron";
  id: Uuid;
  researcher: boolean;
  timestamp: utcDateTime;
}

/////////////////
// Admin Slice //
/////////////////

interface AdminSlice extends Slice<"admin", AdminEvents, AdminStore> {}

alias AdminStore = {
  // just a list of unacked messages
  "admin_messages": [Uuid, string],
}

union AdminEvents {
  CheckoutFailed;
  MessageAck;
}

model CheckoutFailed {
  id: Uuid,
  checkout: Uuid,
  string: reason,
}

@command(MessageAck)
model MessageAck {
  id: Uuid,
}

////////////////////////
// Engine definitions //
////////////////////////

// A patron has very limited write capabilities.  Each of these events may be written but only to
// their own patron_uuid.
union UserCommands {
  RenamePatron,
  TryHold,
  CancelHold,
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
  AddPatron,
  AssignPatron,
  TryCheckout,
  EndCheckout,
}

interface AdminEngine extends Engine<[BookSlice, PatronSlice, AdminSlice], AdminCommands> {}

/////////////////
// Login Slice //
/////////////////

interface LoginSlice extends Slice<"login", LoginEvents, LoginStore> {}

alias LoginStore {
  "login.{email}": Login,
}

model Login {
  patron: Uuid;
  password: PasswordHash;
}

@online
@command([LoginCreated, PatronCreated])
model CreateLogin {
  patron: Uuid;
  username: User;
  password: NewPassword;
}

model LoginCreated {
  patron: Uuid;
  login: string;
  display: string;
  password: PasswordHash;
}

model PatronCreated {
  patron: Uuid;
  display: string;
}

@online
@command(PasswordChanged)
model ChangePassword {
  patron: Uuid;
  // CommandAuth could be the existing password, or the TOTP token, or something,
  // but Go has to match it against what lookup() returns or it will be rejected.
  check: CommandAuth;
  new: NewPassword;
}

model PasswordChanged {
  patron: Uuid;
  password: PasswordHash;
}

@online
@command([LoginDeleted, PatronDeleted])
model DeleteLogin {
  patron: Uuid;
  check: CommandAuth;
}

model LoginDeleted {
  patron: Uuid;
}

model PatronDeleted {
  patron: Uuid;
}

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
  SystemCommands
> {}

union SystemCommands = OverdueCheckout;

/////////////////
// Query Layer //
/////////////////

model AdminPatronInfo {
  id: Uuid;
  name: string;
  researcher: boolean;
};

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
  allPatrons(): AdminPatronInfo[];
  allEditions(): AdminEditionInfo[];
}

model UserBookInfo {
  isbn: string;
  title: string;
  availableNormal: int32;
  availableRestricted: string[];
  hold: VHold | null;
}

model UserPatronInfo {
  name: string;
  researcher: boolean;
};

interface UserQueries extends Queries {
  allBooks(): UserBookInfo[];
  myPatron(): UserPatronInfo;
}
