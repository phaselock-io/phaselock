// TypeSpec model for the todo demo: a collaborative to-do list.

import "@phaselock/typespec-core";

using PhaseLock;

alias Uuid = string;

////////////////
// Todo Slice //
////////////////

// Every list and item, in one stream that every client syncs.

interface TodoSlice
  extends Slice<
    "todo",
    TodoEvents,
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

// each event is also the command that emits it, so this union is the engine's commands too
union TodoEvents {
  NewList,
  RenameList,
  ArchiveList,
  NewItem,
  EditItem,
  MarkItem,
  ArchiveItem,
}

@command(NewList)
model NewList {
  type: "new-list";
  id: Uuid;
  name: string;
}

@command(RenameList)
model RenameList {
  type: "rename-list";
  id: Uuid;
  name: string;
}

@command(ArchiveList)
model ArchiveList {
  type: "archive-list";
  id: Uuid;
}

@command(NewItem)
model NewItem {
  type: "new-item";
  id: Uuid;
  list: Uuid;
  text: string;
}

@command(EditItem)
model EditItem {
  type: "edit-item";
  id: Uuid;
  text: string;
}

@command(MarkItem)
model MarkItem {
  type: "mark-item";
  id: Uuid;
  done: boolean;
}

@command(ArchiveItem)
model ArchiveItem {
  type: "archive-item";
  id: Uuid;
}

/////////////////////////
// Engine and Database //
/////////////////////////

// everyone syncs every list and may send every command
interface TodoEngine extends Engine<[TodoSlice], TodoEvents> {}

// the database holds nothing of its own; the demo has no accounts, so anyone may send anything
interface TodoDB extends Database<[TodoEngine]> {}
