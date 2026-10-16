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

// The public catalog: editions, the books of each edition, and the state of every hold and
// checkout, with no patron named anywhere, since every user syncs this slice.  Collections are
// key ranges that readers scan, such as `edition_book:{isbn},` for the books of one edition.

interface BookSlice extends Slice<"book:{room}", BookEvents, BookStore> {}

alias BookStore = {
  "edition:{isbn}": Edition;
  "book:{book}": Book;
  // index: every book of an edition
  "edition_book:{isbn},{book}": true;
  // one key per open hold; closing a hold deletes its key
  "hold:{hold}": Hold;
  // index: every open edition-level hold of an edition
  "edition_hold:{isbn},{hold}": true;
  // one key per open checkout; ending a checkout deletes its key
  "checkout:{checkout}": Checkout;
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
  // true while the hold is only a forecast, which the database has not decided yet
  pending?: boolean;
}

model Checkout {
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  overdue: boolean;
  // true while the checkout is only a forecast, which the database has not decided yet
  pending?: boolean;
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
  ...InRoom;
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

@command(UpdateEditionTitle)
model UpdateEditionTitle {
  type: "update-edition-title";
  ...InRoom;
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

// Book commands + events //

@command(AddBook)
model AddBook {
  type: "add-book";
  ...InRoom;
  id: Uuid;
  isbn: Isbn;
  restricted: boolean;
  timestamp: utcDateTime;
}

// Restricting a book closes a book-level hold on it by a patron who is not a researcher, and when
// edition-level holds need the copy, the newest of them until the rest fit.
@command((UpdateBookRestricted | HoldClosed | PatronHoldClosed)[])
model UpdateBookRestricted {
  type: "update-book-restricted";
  ...InRoom;
  id: Uuid;
  restricted: boolean;
  timestamp: utcDateTime;
}

// Rejected while the book is checked out.  A book-level hold on it closes, and when edition-level
// holds need the copy, the newest of them until the rest fit.
@command((RemoveBook | HoldClosed | PatronHoldClosed)[])
model RemoveBook {
  type: "remove-book";
  ...InRoom;
  id: Uuid;
  timestamp: utcDateTime;
}

// Hold commands + events //

// the catalog learns of the hold, the patron learns it is theirs, and the librarians learn whose
// it is, or the patron alone learns why it failed
@command([HoldOpened, PatronHoldOpened, HoldOwner] | HoldFailed)
model TryHold {
  type: "try-hold";
  ...InRoom;
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

// the hold closes in the catalog, in the librarians' record of whose it was, and for its patron
@command([HoldClosed, HoldClosed, PatronHoldClosed])
model CancelHold {
  type: "cancel-hold";
  ...InRoom;
  id: Uuid;
  patron: Uuid;
}

// closes a hold, whether cancelled, fulfilled by a checkout, closed with its patron's account, or
// expired by the daily sheet
model HoldClosed {
  type: "hold-closed";
  id: Uuid;
  reason: string;
}

// Checkout commands + events //

// a checkout that fulfills the patron's own hold also closes it; a failure is a notice to the
// librarians, since a checkout queued offline at the desk can fail after they have moved on
@command((
  | CheckoutOpened
  | PatronCheckoutOpened
  | CheckoutOwner
  | HoldClosed
  | PatronHoldClosed
  | CheckoutFailed
)[])
model TryCheckout {
  type: "try-checkout";
  ...InRoom;
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

// the checkout ends in the catalog, in the librarians' record of whose it was, and for its patron
@command([CheckoutEnded, CheckoutEnded, PatronCheckoutEnded])
model EndCheckout {
  type: "end-checkout";
  ...InRoom;
  checkout: Uuid;
  patron: Uuid;
  timestamp: utcDateTime;
}

model CheckoutEnded {
  type: "checkout-ended";
  id: Uuid;
  timestamp: utcDateTime;
}

// the daily sheet marks a checkout overdue once its expiry has passed
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

interface PatronSlice extends Slice<"patron:{room},{patron}", PatronEvents, PatronStore> {}

alias PatronStore = {
  "patron": Patron;
  "patron_hold:{hold}": PatronHold;
  "patron_checkout:{checkout}": Checkout;
  "patron_notice:{notice}": Notice;
};

model Patron {
  id: Uuid;
  name: string;
  // the color the UI shows the patron in, as #rrggbb
  color: string;
  researcher: boolean;
  // when the patron last changed their password, so a client learns from sync that it landed
  passwordChanged?: utcDateTime;
}

model PatronHold {
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  expires?: utcDateTime;
  // true while the hold is only a forecast, which the database has not decided yet
  pending?: boolean;
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
  PatronPasswordChanged,
  PatronDismissNotice,
}

model PatronCreated {
  type: "patron-created";
  id: Uuid;
  name: string;
  color: string;
}

@command(RenamePatron)
model RenamePatron {
  type: "rename-patron";
  ...InRoom;
  id: Uuid;
  name: string;
  timestamp: utcDateTime;
}

// grants or revokes researcher status; revoking it closes the patron's holds on restricted books
@command((AssignPatron | HoldClosed | PatronHoldClosed)[])
model AssignPatron {
  type: "assign-patron";
  ...InRoom;
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

// with notify, folded into a notice the patron dismisses, for a hold that closed without the
// patron closing it themselves
model PatronHoldClosed {
  type: "patron-hold-closed";
  id: Uuid;
  reason: string;
  notify: boolean;
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

// the patron's own record of a password change, which precommit stamps
model PatronPasswordChanged {
  type: "patron-password-changed";
  timestamp: utcDateTime;
}

// a patron dismisses one of their own notices, or a librarian dismisses it for them
@command(PatronDismissNotice)
model PatronDismissNotice {
  type: "patron-dismiss-notice";
  ...InRoom;
  id: Uuid;
  patron: Uuid;
}

/////////////////
// Admin Slice //
/////////////////

// The librarians' shared inbox, notices about work that failed after it was queued, and the owner
// of every open hold and checkout, which the catalog leaves out.  A hold or checkout that opens
// names its owner here, and its HoldClosed or CheckoutEnded comes here too, as it does to the
// catalog.

interface AdminSlice extends Slice<"admin:{room}", AdminEvents, AdminStore> {}

alias AdminStore = {
  // one key per undismissed notice
  "admin_notice:{notice}": Notice;
  // the patron of each open hold
  "hold_owner:{hold}": Uuid;
  // the patron of each open checkout
  "checkout_owner:{checkout}": Uuid;
};

union AdminEvents {
  CheckoutFailed,
  DismissNotice,
  HoldOwner,
  HoldClosed,
  CheckoutOwner,
  CheckoutEnded,
}

model HoldOwner {
  type: "hold-owner";
  hold: Uuid;
  patron: Uuid;
}

model CheckoutOwner {
  type: "checkout-owner";
  checkout: Uuid;
  patron: Uuid;
}

model CheckoutFailed {
  type: "checkout-failed";
  id: Uuid;
  patron: Uuid;
  book: Uuid;
  reason: string;
}

// a librarian dismisses one of the shared notices
@command(DismissNotice)
model DismissNotice {
  type: "dismiss-notice";
  ...InRoom;
  id: Uuid;
}

/////////////////
// Login Slice //
/////////////////

// Credentials, which the database keeps for itself and never syncs: a hash in a browser cache
// can be cracked offline.  `lookup` reads a login by name to sign someone in, and by user to
// check a token and a command's proof.  A login's user is the patron it belongs to, except for
// the one `admin` login every librarian shares, which is flagged as a librarian's.  A login
// name fills a key parameter, so precommit rejects one holding a separator of the key templates.
// The slice's history keeps every login name and superseded hash, which only a retention
// policy trims.

interface LoginSlice extends Slice<"login:{room}", LoginEvents, LoginStore> {}

alias LoginStore = {
  // login names are unique and never change
  "login:{login}": Login;
  // index: the login name of each user
  "user_login:{user}": string;
};

model Login {
  user: Uuid;
  password: PasswordHash;
  librarian: boolean;
}

union LoginEvents {
  LoginCreated,
  PasswordChanged,
  LoginDeleted,
}

// Sent anonymously before signing in, outside any Engine, since no token exists until the
// account does.  Precommit mints the new patron's id, so no id is ever reused; signing in
// answers it.
@online
@command([LoginCreated, PatronCreated])
model CreateAccount {
  type: "create-account";
  ...InRoom;
  login: string;
  name: string;
  // as #rrggbb; without one, precommit picks the next of the demo's colors
  color?: string;
  password: NewPassword;
}

model LoginCreated {
  type: "login-created";
  login: string;
  user: Uuid;
  password: PasswordHash;
  librarian: boolean;
}

// changes the sender's own password
@online
@command([PasswordChanged, PatronPasswordChanged])
model ChangePassword {
  type: "change-password";
  ...InRoom;
  // proves a credential the account has registered, which the database verifies before
  // precommit sees the command
  check: CommandAuth;
  new: NewPassword;
}

model PasswordChanged {
  type: "password-changed";
  login: string;
  password: PasswordHash;
}

// deletes the sender's own account; rejected while they have open checkouts, their open holds
// close with the account, and their patron stream ends with its history erased
@online
@command([LoginDeleted, Erasure, HoldClosed[]])
model DeleteAccount {
  type: "delete-account";
  ...InRoom;
  check: CommandAuth;
}

model LoginDeleted {
  type: "login-deleted";
  login: string;
  user: Uuid;
}

///////////
// Rooms //
///////////

/* Room stuff, for hosting the demo with many rooms in one database.  Every
   visitor gets a room of their own, a private copy of the library seeded with
   the demo's data, and shares it by sharing its link.  Every family takes the
   room as its first parameter, every command names its room, and a user id
   is `<room>.<id>`, so a signed-in user's room is in their token.  A room
   lives for an hour from its creation, when a cron hook erases its streams;
   the next CreateRoom for its id seeds it afresh. */

alias RoomId = Uuid;

// the room a command acts in, which must be the sender's own
model InRoom {
  room: RoomId;
}

// The room's own record, which every Engine in the room syncs, so the UI can say when the room
// resets.

interface RoomSlice extends Slice<"room:{room}", RoomCreated, RoomStore> {}

alias RoomStore = {
  "room_created": utcDateTime;
};

// Every room, by when it was created, which the database keeps for itself to know which rooms
// to reap.

interface RoomRegistrySlice extends Slice<"rooms", RoomRegistryEvents, RoomRegistryStore> {}

alias RoomRegistryStore = {
  "room:{room}": utcDateTime;
};

union RoomRegistryEvents {
  RoomCreated,
  RoomDeleted,
}

// Sent anonymously by the UI for the room in its URL.  For a room that exists it writes
// nothing; otherwise it seeds the room with the demo's catalog, patrons, and logins.
@online
@command((
  | RoomCreated
  | AddEdition
  | AddBook
  | PatronCreated
  | AssignPatron
  | LoginCreated
)[])
model CreateRoom {
  type: "create-room";
  room: RoomId;
}

// recorded in the registry and in the room's own record
model RoomCreated {
  type: "room-created";
  room: RoomId;
  created: utcDateTime;
}

// recorded in the registry when the room is reaped
model RoomDeleted {
  type: "room-deleted";
  room: RoomId;
}

////////////////////////
// Engine definitions //
////////////////////////

// A patron has very limited write capabilities.  Each of these commands may be sent only for
// their own patron.
union UserCommands {
  RenamePatron,
  TryHold,
  CancelHold,
  PatronDismissNotice,
  ChangePassword,
  DeleteAccount,
}

interface UserEngine extends Engine<[BookSlice, PatronSlice, RoomSlice], UserCommands> {}

// An admin (the librarian at the front desk) has every command but the database's own,
// CreateAccount and CreateRoom.
union AdminCommands {
  // admin can send UserCommands for whatever patron they want
  UserCommands,
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
  AssignPatron,
  TryCheckout,
  EndCheckout,
  DismissNotice,
}

interface AdminEngine
  extends Engine<[BookSlice, PatronSlice, AdminSlice, RoomSlice], AdminCommands> {}

//////////////////
// The Database //
//////////////////

/* The DB holds all slices and its precommit function handles all commands,
   and it may declare additional slices and commands that no Engine handles.
   Additional slices are maintained for internal use (precommit, maySee, and
   lookup), but are not synced to any client.  Its commands of its own are
   sent before signing in, when there is no Engine to send them.  The daily
   sheet and the reaping of rooms are cron hooks of the bundle, which write
   their events as a command's handler does. */
interface LibraryDB
  extends Database<
      [UserEngine, AdminEngine],
      [LoginSlice, RoomRegistrySlice],
      CreateAccount | CreateRoom
    > {}

/////////////////
// Query Layer //
/////////////////

model AdminBookInfo {
  id: string;
  restricted: boolean;
  state: "open" | "restricted" | "held" | "out";
  // true while the book's hold or checkout is only a forecast
  pending?: boolean;
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
  color: string;
  researcher: boolean;
  holds: PatronHold[];
  checkouts: UserCheckoutInfo[];
}

interface UserQueries extends Queries {
  allBooks(): UserBookInfo[];
  myPatron(): UserPatronInfo;
}
