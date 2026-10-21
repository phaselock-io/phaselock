// The model the server tests run against: a small library domain with a singleton book slice,
// per-patron slices, per-branch shelves that the scan tests walk, and per-account slices holding
// credentials, which the grantor never grants to a client.  A librarian's account is flagged
// admin.

import "@phaselock/typespec-core";

using PhaseLock;

alias Id = string;

// books //

interface BookSlice extends Slice<"book", { "book:{id}": Book }> {}

model Book {
  id: Id;
  title: string;
  hold?: boolean;
  added?: utcDateTime;
}

// declares its discriminator last, which every writer still writes first
model AddBook {
  id: Id;
  title: string;
  added?: utcDateTime;
  type: "add-book";
}

// patrons //

interface PatronSlice
  extends Slice<
    "patron:{patron}",
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

model AddPatron {
  type: "add-patron";
  id: Id;
  name: string;
}

model RenamePatron {
  type: "rename-patron";
  id: Id;
  name: string;
}

// deletes the patron's slice
model RemovePatron {
  type: "remove-patron";
  id: Id;
}

// deletes the patron's slice and erases its history
model ForgetPatron {
  type: "forget-patron";
  id: Id;
}

// deletes the patron's slice and writes it afresh in the same mutation
model ResetPatron {
  type: "reset-patron";
  id: Id;
  name: string;
}

// the catalogue and the patron learn of the hold, or the patron alone learns why it failed
model TryHold {
  type: "try-hold";
  id: Id;
  book: Id;
  patron: Id;
}

// shelves //

// a branch's copies of books, the patrons it lends to, and its copies as the decider's own scan
// saw them
interface ShelfSlice
  extends Slice<
    "shelf:{branch}",
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

// the shelf learns the book's title from the catalogue
model Shelve {
  type: "shelve";
  branch: Id;
  book: Id;
}

model Lend {
  type: "lend";
  branch: Id;
  patron: Id;
}

model CloseShelf {
  type: "close-shelf";
  branch: Id;
}

// accounts //

interface AccountSlice extends Slice<"account:{user}", { "account": Account }> {}

model Account {
  user: Id;
  hash: PasswordHash;
  admin: boolean;
  generation: int32;
  views: string[];
}

@online
model CreateAccount {
  type: "create-account";
  user: Id;
  password: NewPassword;
  admin?: boolean;
}

@online
model SetPassword {
  type: "set-password";
  user: Id;
  password: NewPassword;
}

// changes the sender's own password, proving the one it has
@online
model ChangePassword {
  type: "change-password";
  user: Id;
  check: MutationAuth;
  password: NewPassword;
}

model RevokeSessions {
  type: "revoke-sessions";
  user: Id;
}

model GrantView {
  type: "grant-view";
  user: Id;
  prefix: string;
}

model RevokeView {
  type: "revoke-view";
  user: Id;
  prefix: string;
}

// a mutation proving its sender's credentials, which revokes the sender's sessions
@online
model AuthenticatedMutation {
  type: "authenticated-mutation";
  user: Id;
  check: MutationAuth;
}

// a mutation whose decider makes plugin requests, each adding one of its reasons to the patron's
// messages; `reject` rejects the mutation after its requests
model Notify {
  type: "notify";
  patron: Id;
  reasons: string[];
  reject?: boolean;
}

// the audiences //

union TestMutations {
  AddBook,
  AddPatron,
  RenamePatron,
  RemovePatron,
  ForgetPatron,
  ResetPatron,
  TryHold,
  Shelve,
  Lend,
  CloseShelf,
  RevokeSessions,
  GrantView,
  RevokeView,
}

interface TestEngine extends Engine<[BookSlice, PatronSlice, ShelfSlice], TestMutations> {}

union DbMutations {
  CreateAccount,
  SetPassword,
  ChangePassword,
  AuthenticatedMutation,
  Notify,
}

interface TestDB extends Database<[TestEngine], [AccountSlice], DbMutations> {}
