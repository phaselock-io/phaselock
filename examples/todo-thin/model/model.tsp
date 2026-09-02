// TypeSpec model for the todo demo: a collaborative to-do list.

import "@phaselock/typespec";

using PhaseLock;

/////////////////
// Store Layer //
/////////////////

alias Uuid = string;

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

interface TodoStore extends Store<{
  "all_lists": Uuid[]; // array of list ids
  "list.{list_id}": List;
  "item.{item_id}": Item;
}> {}

//////////////////
// Events Layer //
//////////////////

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

union TodoEvents {
  NewList,
  RenameList,
  ArchiveList,
  NewItem,
  EditItem,
  MarkItem,
  ArchiveItem,
}

interface TodoEngine extends Engine<TodoEvents, TodoEvents, TodoStore> {}

/////////////////
// Query Layer //
/////////////////

model ItemViewData {
  id: string;
  text: string;
  done: boolean;
}

model ListViewData {
  id: string;
  name: string;
  items: ItemViewData[];
}

interface TodoQueries extends Queries {
  allLists(): ListViewData[];
}
