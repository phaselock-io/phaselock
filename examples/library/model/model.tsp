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

interface BookSlice extends Slice<"book:{room}", BookStore> {}

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
  // true while the hold is only a prediction, which the database has not decided yet
  pending?: boolean;
}

model Checkout {
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  overdue: boolean;
  // true while the checkout is only a prediction, which the database has not decided yet
  pending?: boolean;
}

// Edition mutations //

model AddEdition {
  type: "add-edition";
  ...InRoom;
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

model UpdateEditionTitle {
  type: "update-edition-title";
  ...InRoom;
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

// Book mutations //

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
model UpdateBookRestricted {
  type: "update-book-restricted";
  ...InRoom;
  id: Uuid;
  restricted: boolean;
  timestamp: utcDateTime;
}

// Rejected while the book is checked out.  A book-level hold on it closes, and when edition-level
// holds need the copy, the newest of them until the rest fit.
model RemoveBook {
  type: "remove-book";
  ...InRoom;
  id: Uuid;
  timestamp: utcDateTime;
}

// Hold mutations //

// the catalog learns of the hold, the patron learns it is theirs, and the librarians learn whose
// it is, or the patron alone learns why it failed
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

// a patron cancels their own hold: it closes in the catalog, in the librarians' record of whose
// it was, and for its patron
model CancelHold {
  type: "cancel-hold";
  ...InRoom;
  id: Uuid;
  patron: Uuid;
}

// a librarian cancels a patron's hold: it closes as a patron's cancel does, and the patron gets a
// notice saying the library canceled it
model LibraryCancelHold {
  type: "library-cancel-hold";
  ...InRoom;
  id: Uuid;
  patron: Uuid;
}

// Checkout mutations //

// a checkout that fulfills the patron's own hold also closes it; a failure is a notice to the
// librarians, since a checkout queued offline at the desk can fail after they have moved on
model TryCheckout {
  type: "try-checkout";
  ...InRoom;
  id: Uuid;
  patron: Uuid;
  book: Uuid;
  timestamp: utcDateTime;
}

// the checkout ends in the catalog, in the librarians' record of whose it was, and for its patron
model EndCheckout {
  type: "end-checkout";
  ...InRoom;
  checkout: Uuid;
  patron: Uuid;
  timestamp: utcDateTime;
}

//////////////////
// Patron Slice //
//////////////////

// One patron's own record: their profile, and the holds, checkouts, and notices that are theirs.
// The catalog names no patron, so each hold and checkout that is a patron's is kept here too,
// where the patron and the librarians see it.

interface PatronSlice extends Slice<"patron:{room},{patron}", PatronStore> {}

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
  // true while the hold is only a prediction, which the database has not decided yet
  pending?: boolean;
}

// a notice the patron or the librarians dismiss
model Notice {
  id: Uuid;
  reason: string;
}

model RenamePatron {
  type: "rename-patron";
  ...InRoom;
  id: Uuid;
  name: string;
  timestamp: utcDateTime;
}

// grants or revokes researcher status; revoking it closes the patron's holds on restricted books
model AssignPatron {
  type: "assign-patron";
  ...InRoom;
  id: Uuid;
  researcher: boolean;
  timestamp: utcDateTime;
}

// a patron dismisses one of their own notices, or a librarian dismisses it for them
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
// records its owner here, and closing it deletes the record, as it deletes the catalog's key.

interface AdminSlice extends Slice<"admin:{room}", AdminStore> {}

alias AdminStore = {
  // one key per undismissed notice
  "admin_notice:{notice}": Notice;
  // the patron of each open hold
  "hold_owner:{hold}": Uuid;
  // the patron of each open checkout
  "checkout_owner:{checkout}": Uuid;
};

// a librarian dismisses one of the shared notices
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
// check a token and a mutation's proof.  A login's user is the patron it belongs to, except for
// the one `admin` login every librarian shares, which is flagged as a librarian's.  A login
// name fills a key parameter, so the decider rejects one holding a separator of the key
// templates.  The slice's history keeps every login name and superseded hash, which only a
// retention policy trims.

interface LoginSlice extends Slice<"login:{room}", LoginStore> {}

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

// Sent anonymously before signing in, outside any Engine, since no token exists until the
// account does.  The decider mints the new patron's id, so no id is ever reused; signing in
// answers it.
@online
model CreateAccount {
  type: "create-account";
  ...InRoom;
  login: string;
  name: string;
  // as #rrggbb; without one, the decider picks the next of the demo's colors
  color?: string;
  password: NewPassword;
}

// changes the sender's own password
@online
model ChangePassword {
  type: "change-password";
  ...InRoom;
  // proves a credential the account has registered, which the database verifies before
  // the decider sees the mutation
  check: MutationAuth;
  new: NewPassword;
}

// deletes the sender's own account; rejected while they have open checkouts, their open holds
// close with the account, and their patron slice is deleted with its history erased
@online
model DeleteAccount {
  type: "delete-account";
  ...InRoom;
  check: MutationAuth;
}

///////////
// Rooms //
///////////

/* Room stuff, for hosting the demo with many rooms in one database.  Every
   visitor gets a room of their own, a private copy of the library seeded with
   the demo's data, and shares it by sharing its link.  Every family takes the
   room as its first parameter, every mutation names its room, and a user id
   is `<room>.<id>`, so a signed-in user's room is in their token.  A room
   lives for an hour from its creation, when a cron hook erases its slices;
   the next CreateRoom for its id seeds it afresh. */

alias RoomId = Uuid;

// the room a mutation acts in, which must be the sender's own
model InRoom {
  room: RoomId;
}

// The room's own record, which every Engine in the room syncs, so the UI can say when the room
// resets.

interface RoomSlice extends Slice<"room:{room}", RoomStore> {}

alias RoomStore = {
  "room_created": utcDateTime;
};

// Every room, by when it was created, which the database keeps for itself to know which rooms
// to reap.

interface RoomRegistrySlice extends Slice<"rooms", RoomRegistryStore> {}

alias RoomRegistryStore = {
  "room:{room}": utcDateTime;
};

// Sent anonymously by the UI for the room in its URL.  For a room that exists it writes
// nothing; otherwise it seeds the room with the demo's catalog, patrons, and logins.
@online
model CreateRoom {
  type: "create-room";
  room: RoomId;
}

////////////////////////
// Engine definitions //
////////////////////////

// A patron has very limited write capabilities.  Each of these mutations may be sent only for
// their own patron.
union UserMutations {
  RenamePatron,
  TryHold,
  CancelHold,
  PatronDismissNotice,
  ChangePassword,
  DeleteAccount,
}

interface UserEngine extends Engine<[BookSlice, PatronSlice, RoomSlice], UserMutations> {}

// An admin (the librarian at the front desk) has the patron's mutations a librarian sends on any
// patron's behalf, and the librarians' own.
union AdminMutations {
  RenamePatron,
  TryHold,
  PatronDismissNotice,
  LibraryCancelHold,
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
  extends Engine<[BookSlice, PatronSlice, AdminSlice, RoomSlice], AdminMutations> {}

//////////////////
// The Database //
//////////////////

/* The DB holds all slices and its deciders decide all mutations, and it may
   declare additional slices and mutations that no Engine handles.  Additional
   slices are maintained for internal use (the deciders, the grantor, and
   lookup), but are not synced to any client.  Its mutations of its own are
   sent before signing in, when there is no Engine to send them.  The daily
   sheet and the reaping of rooms are cron hooks of the bundle, which write
   through the database's transaction as a decider does. */
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
  // true while the book's hold or checkout is only a prediction
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
