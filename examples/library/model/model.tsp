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

import "@phaselock/typespec";

using PhaseLock;

/////////////////
// Store Layer //
/////////////////

alias Uuid = string;
alias Isbn = string;

model Setx is Record<true>;

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

// servers and clients keep the same data
interface BookStore extends Store<{
  "edition.{edition_isbn}": Edition;
  "editions": Setx;
  "book.{book_uuid}": Book;
}> {}

model Patron {
  id: Uuid;
  name: string;
  researcher: boolean;
  checkouts: Setx;
  holds: Setx;
}

// servers and clients keep data in the same shape, but unprivileged clients
// will only have their own info here
interface PatronStore extends Store<{
  "patron.{patron_uuid}": Patron;
  "patrons": Setx;
}> {}

model Hold {
  id: Uuid;
  patron: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  timestamp: utcDateTime;
  expires?: utcDateTime;
}

model Checkout {
  id: Uuid;
  book: Uuid;
  patron: Uuid;
  expires: utcDateTime;
  overdue: boolean; // server determination based on expires
}

interface StatusStore extends Store<{
  "hold.{hold_uuid}": Hold;
  "checkout.{checkout_uuid}": Checkout;
  "active_holds": Setx;
  "active_checkouts": Setx;
}> {}

// "virtualized" hold, or maybe "view of hold", but just not the whole thing
// this is what the server's virtualization layer emits to clients.  All clients
// will see all holds but won't know who they belong to.  Also, clients will not
// have enough information to evaluate if a TryHold event is valid.
model VHold {
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  timestamp: utcDateTime;
  expires?: utcDateTime;
  // contains your id or nothing
  patron?: Uuid;
  // this is only ever set to true by the userForecaster
  forecasted?: true;
}

model VCheckout {
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  overdue: boolean; // server determination based on expires
  // contains your id or nothing
  patron?: Uuid;
}

interface VStatusStore extends Store<{
  "hold.{hold_uuid}": VHold;
  "checkout.{checkout_uuid}": VCheckout;
}> {}

// Now construct the composed Stores.  Different system components have
// different compositions of store.

// The decider needs all state data, plus an output to store generated events:
// - all book data,
// - all patron data,
// - all status data,
// - a single key for new decider events
interface DeciderStore extends Store<{
  "decider_events": DeciderEvents[];
}, [BookStore, PatronStore, StatusStore]> {}

// The (unprivileged) user client will need:
// - all book data
// - a shard of the patron data, which is really just themselves
//    - this can conveniently be typed the same as the full patron data
// - all virtualized status data
// - a place to store UI messages that originate in the reducers
interface UserStore extends Store<{
  "messages": string[];
}, [BookStore, PatronStore, VStatusStore]> {}

// The admin client will need all state, but it relies on State, not VState
interface AdminStore extends Store<{}, [BookStore, PatronStore, StatusStore]> {}

/////////////////
// Event Layer //
/////////////////

// list of streams:
// - books: all edition and book-related info
// - patron.{patron_uuid}: all patron info, per-patron
// - status: privileged stream of all checkpoints and holds
// - vstatus: status decisions; relay will scrub and filter before forwarding to users
//
// extra streams:
// - deciderState: where the decider stores its checkpoint data

// editions: globally visible
// stream: "books"
model AddEdition {
  type: "add-edition";
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

// stream: "books"
model UpdateEditionTitle {
  type: "update-edition-title";
  isbn: Isbn;
  title: string;
  timestamp: utcDateTime;
}

// books: globally visible

// stream: "books"
model AddBook {
  type: "add-book";
  id: Uuid;
  isbn: Isbn;
  restricted: boolean;
  timestamp: utcDateTime;
}

// stream: "books"
model UpdateBookRestricted {
  type: "update-book-restricted";
  id: Uuid;
  restricted: boolean;
  timestamp: utcDateTime;
}

// stream: "books"
model RemoveBook {
  type: "remove-book";
  id: Uuid;
  timestamp: utcDateTime;
}

union BookEvents {
  AddEdition,
  UpdateEditionTitle,
  AddBook,
  UpdateBookRestricted,
  RemoveBook,
}

// patrons: same data in frontend and backend, but client can only view self

// stream: "patron.{patron_uuid}"
model AddPatron {
  type: "add-patron";
  id: Uuid;
  name: string;
  researcher: boolean;
  timestamp: utcDateTime;
}

// stream: "patron.{patron_uuid}"
model RenamePatron {
  type: "rename-patron";
  id: Uuid;
  name: string;
  timestamp: utcDateTime;
}

// stream: "patron.{patron_uuid}"
model AssignPatron {
  type: "assign-patron";
  id: Uuid;
  researcher: boolean;
  timestamp: utcDateTime;
}

union PatronEvents {
  AddPatron,
  RenamePatron,
  AssignPatron,
}

// holds: fully visible to hold owners; partially visible globally

// stream: "status"
model TryHold {
  type: "try-hold";
  id: Uuid;
  patron: Uuid;
  // can hold a specific book or just any generic one
  target: { book: Uuid } | { edition: Isbn };
  open: boolean;
  timestamp: utcDateTime;
}

// stream: "status"
model CancelHold {
  type: "cancel-hold";
  id: Uuid;
}

// system-generated event
// stream: "status"
model ExpireHold {
  type: "expire-hold";
  id: Uuid;
  timestamp: utcDateTime;
}

// checkouts: fully visible to hold owners; partially visible globally

// only valid if it appears valid when reading the log
// automatically cancels the relevant hold
// stream: "status"
model TryCheckout {
  type: "try-checkout";
  id: Uuid;
  patron: Uuid;
  book: Uuid;
  timestamp: utcDateTime;
}

// stream: "status"
model EndCheckout {
  type: "end-checkout";
  checkout: Uuid;
  timestamp: utcDateTime;
}

// system-generated event
// stream: "status"
model OverdueCheckout {
  type: "overdue-checkout";
  checkout: Uuid;
  timestamp: utcDateTime;
}

union StatusEvents {
  TryHold,
  CancelHold,
  ExpireHold,
  TryCheckout,
  EndCheckout,
  OverdueCheckout,
}

// virtualized status (or "view of" status): sanitized data for clients to view.
//
// In the backend, hold decisions are determined by the order in which TryHolds
// arrive, relative to other holds, checkouts, and even assign-patron events.
// But since clients can't know about each other, a virtualization layer is
// necessary to tell clients about the hold decisions without exposing all the
// data required to make those decisions.

// stream: "vstatus"
model NewVHold {
  type: "new-vhold";
  id: Uuid;
  target: { book: Uuid } | { edition: Isbn };
  open: boolean;
  expires?: utcDateTime;
  timestamp: utcDateTime;
  // DB stores patron, but the server strips it before streaming it to clients.
  patron?: Uuid;
  // this is only ever set to true by the userForecaster
  forecasted?: true;
}

// Similarly, since clients cannot have enough information to make hold decisions
// on their own, they must be alerted to when their own holds were rejected.
// stream: "vstatus"
model VHoldRejected {
  type: "vhold-rejected";
  id: Uuid;
  reason: string;
  // A client will only see vhold-rejected for holds it has itself requested, so
  // from the client perspective, `patron` will always be its own patron id
  patron: Uuid;
}

// If a patron is demoted, their now-invalid holds get canceled by the system.  Other patrons won't
// see the demotion so we need to broadcast this.
model EndVHold {
  type: "end-vhold";
  id: Uuid;
  timestamp: utcDateTime;
}

// Similar to NewVHold, but for checkouts.
// stream: "vstatus"
model NewVCheckout {
  type: "new-vcheckout";
  id: Uuid;
  book: Uuid;
  expires: utcDateTime;
  // DB stores patron, but the server strips it before streaming it to clients.
  patron?: Uuid;
}

// Note: there is no VCheckoutRejected because only the front desk, which has
// admin privileges, can create checkouts in the first place.

union DeciderEvents {
  NewVHold,
  VHoldRejected,
  EndVHold,
  NewVCheckout,
}

// union of all state-related events
union LibraryEvents {
  BookEvents,
  PatronEvents,
  StatusEvents,
  DeciderEvents,
}

interface DeciderEngine extends Engine<LibraryEvents, LibraryEvents, DeciderStore> {}

//////////////////

// A patron has very limited write capabilities.  Each of these events may be written but only to
// their own patron_uuid.
union UserCommands {
  RenamePatron,
  TryHold,
  CancelHold,
}

interface UserEngine extends Engine<LibraryEvents, UserCommands, UserStore> {}

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

interface AdminEngine extends Engine<LibraryEvents, AdminCommands, AdminStore> {}

// ok, technically UserCommands is a subset of AdminCommands, but this expresses that the relay is
// going to relay commands from both types of clients.  (It flattens to the same interned type as
// AdminCommands, so the generated code uses that name — same as the Python DSL.)
alias RelayCommands = UserCommands | AdminCommands;

model RelayHold {
  patron: Uuid;
}

// The relay is mostly concerned with checking that all uuid references are valid, so it doesn't
// have a lot of overlap with the store layout of the decider or the ui
interface RelayStore extends Store<{
  "edition.{isbn}": true;
  "book.{book_uuid}": true;
  "patron.{hold_uuid}": true;
  "checkout.{checkout_uuid}": true;
  "hold.{hold_uuid}": RelayHold;
}> {}


interface RelayEngine extends Engine<LibraryEvents, RelayCommands, RelayStore> {}

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

// admin queries can run against the relay, or against a local AdminStore
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

// user queries can run on the relay, or against a local UserStore
interface UserQueries extends Queries {
  allBooks(): UserBookInfo[];
  myPatron(): UserPatronInfo;
}
