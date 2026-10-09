// The model the server tests run against: a small library domain with a singleton book stream,
// per-patron streams, per-branch shelves that the scan tests walk, and per-account streams
// holding credentials, which maySee never grants to a client.  A librarian's account is flagged
// admin.

import "@phaselock/typespec-core";

using PhaseLock;

alias Id = string;

// books //

interface BookSlice extends Slice<"book", BookEvents, { "book:{id}": Book }> {}

model Book {
  id: Id;
  title: string;
  hold?: boolean;
  added?: utcDateTime;
}

union BookEvents {
  AddBook,
  HoldOpened,
}

// declares its discriminator last, which every writer still writes first
@command(AddBook)
model AddBook {
  id: Id;
  title: string;
  added?: utcDateTime;
  type: "add-book";
}

model HoldOpened {
  type: "hold-opened";
  book: Id;
}

// patrons //

interface PatronSlice
  extends Slice<
    "patron:{patron}",
    PatronEvents,
    {
      "patron": Patron;
      "holds": Record<boolean>;
      "messages": string[];
    }
  > {}

model Patron {
  id: Id;
  name: string;
}

union PatronEvents {
  AddPatron,
  RenamePatron,
  PatronHold,
  HoldFailed,
}

@command(AddPatron)
model AddPatron {
  type: "add-patron";
  id: Id;
  name: string;
}

@command(RenamePatron)
model RenamePatron {
  type: "rename-patron";
  id: Id;
  name: string;
}

model PatronHold {
  type: "patron-hold";
  book: Id;
}

model HoldFailed {
  type: "hold-failed";
  book: Id;
  reason: string;
}

@command(Death)
model RemovePatron {
  type: "remove-patron";
  id: Id;
}

// the catalogue and the patron learn of the hold, or the patron alone learns why it failed
@command([HoldOpened, PatronHold] | HoldFailed)
model TryHold {
  type: "try-hold";
  id: Id;
  book: Id;
  patron: Id;
}

// shelves //

// a branch's copies of books, the patrons it lends to, and its copies as its reducer's scan saw
// them
interface ShelfSlice
  extends Slice<
    "shelf:{branch}",
    ShelfEvents,
    {
      "copy:{book}": Copy;
      "lend:{patron}": Id;
      "shelved": string[];
    }
  > {}

model Copy {
  book: Id;
  title: string;
}

union ShelfEvents {
  Shelved,
  Lend,
}

// the shelf learns the book's title from the catalogue
@command(Shelved)
model Shelve {
  type: "shelve";
  branch: Id;
  book: Id;
}

model Shelved {
  type: "shelved";
  book: Id;
  title: string;
}

@command(Lend)
model Lend {
  type: "lend";
  branch: Id;
  patron: Id;
}

@command(Death)
model CloseShelf {
  type: "close-shelf";
  branch: Id;
}

// accounts //

interface AccountSlice extends Slice<"account:{user}", AccountEvents, { "account": Account }> {}

model Account {
  user: Id;
  hash: PasswordHash;
  admin: boolean;
  generation: int32;
  views: string[];
}

union AccountEvents {
  AccountCreated,
  PasswordSet,
  SessionsRevoked,
  ViewGranted,
  ViewRevoked,
}

model AccountCreated {
  type: "account-created";
  user: Id;
  hash: PasswordHash;
  admin: boolean;
}

model PasswordSet {
  type: "password-set";
  hash: PasswordHash;
}

model SessionsRevoked {
  type: "sessions-revoked";
}

model ViewGranted {
  type: "view-granted";
  prefix: string;
}

model ViewRevoked {
  type: "view-revoked";
  prefix: string;
}

@online
@command(AccountCreated)
model CreateAccount {
  type: "create-account";
  user: Id;
  password: NewPassword;
  admin?: boolean;
}

@online
@command(PasswordSet)
model SetPassword {
  type: "set-password";
  user: Id;
  password: NewPassword;
}

@command(SessionsRevoked)
model RevokeSessions {
  type: "revoke-sessions";
  user: Id;
}

@command(ViewGranted)
model GrantView {
  type: "grant-view";
  user: Id;
  prefix: string;
}

@command(ViewRevoked)
model RevokeView {
  type: "revoke-view";
  user: Id;
  prefix: string;
}

// a command carrying a prepared field the database recognizes but cannot verify yet
@online
@command(SessionsRevoked)
model AuthenticatedCommand {
  type: "authenticated-command";
  user: Id;
  check: CommandAuth;
}

// a command whose handler makes plugin requests, each emitting a hold failure for one of its
// reasons; `reject` rejects the command after its requests
@command(HoldFailed)
model Notify {
  type: "notify";
  patron: Id;
  reasons: string[];
  reject?: boolean;
}

// the audiences //

union TestCommands {
  AddBook,
  AddPatron,
  RenamePatron,
  RemovePatron,
  TryHold,
  Shelve,
  Lend,
  CloseShelf,
  RevokeSessions,
  GrantView,
  RevokeView,
}

interface TestEngine extends Engine<[BookSlice, PatronSlice, ShelfSlice], TestCommands> {}

union DbCommands {
  CreateAccount,
  SetPassword,
  AuthenticatedCommand,
  Notify,
}

interface TestDB extends Database<[TestEngine], [AccountSlice], DbCommands> {}
