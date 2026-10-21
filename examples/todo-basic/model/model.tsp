// TypeSpec model for the todo demo: a collaborative to-do list.

import "@phaselock/typespec-core";

using PhaseLock;

alias Uuid = string;

////////////////
// Todo Slice //
////////////////

// Every list and item, in one slice that every client syncs.

interface TodoSlice
  extends Slice<
    "todo",
    {
      // every list's id, in the order the lists were made
      "all_lists": Uuid[];
      "list:{list_id}": List;
      "item:{item_id}": Item;
    }
  > {}

model List {
  id: Uuid;
  name: string;
  items: Uuid[]; // array of item ids
  archived: boolean;
}

model Item {
  id: Uuid;
  text: string;
  done: boolean;
  archived: boolean;
}

// every mutation a client may send
union TodoMutations {
  NewList,
  RenameList,
  ArchiveList,
  NewItem,
  EditItem,
  MarkItem,
  ArchiveItem,
}

model NewList {
  type: "new-list";
  id: Uuid;
  name: string;
}

model RenameList {
  type: "rename-list";
  id: Uuid;
  name: string;
}

model ArchiveList {
  type: "archive-list";
  id: Uuid;
}

model NewItem {
  type: "new-item";
  id: Uuid;
  list: Uuid;
  text: string;
}

model EditItem {
  type: "edit-item";
  id: Uuid;
  text: string;
}

model MarkItem {
  type: "mark-item";
  id: Uuid;
  done: boolean;
}

model ArchiveItem {
  type: "archive-item";
  id: Uuid;
}

/////////////////////////
// Engine and Database //
/////////////////////////

// everyone syncs every list and may send every mutation
interface TodoEngine extends Engine<[TodoSlice], TodoMutations> {}

// the database holds nothing of its own; the demo has no accounts, so anyone may send anything
interface TodoDB extends Database<[TodoEngine]> {}
