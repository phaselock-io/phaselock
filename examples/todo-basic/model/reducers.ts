import type { TodoSliceReducers } from './model.gen';

/** TodoSlice's reducers, which fold each event into the todo stream's keys.  Precommit checks that
    every list and item an event names exists, so each update here finds its key. */
export const todoReducers: TodoSliceReducers = {
  newList: (txn, e) => {
    txn.set.all_lists([...(txn.get.all_lists() ?? []), e.id]);
    txn.set.list(e.id, { id: e.id, name: e.name, items: [], archived: false });
  },
  renameList: (txn, e) =>
    txn.update.list(e.id, (list) => {
      list.name = e.name;
    }),
  archiveList: (txn, e) =>
    txn.update.list(e.id, (list) => {
      list.archived = true;
    }),
  newItem: (txn, e) => {
    txn.set.item(e.id, { id: e.id, text: e.text, done: false, archived: false });
    txn.update.list(e.list, (list) => {
      list.items.push(e.id);
    });
  },
  editItem: (txn, e) =>
    txn.update.item(e.id, (item) => {
      item.text = e.text;
    }),
  markItem: (txn, e) =>
    txn.update.item(e.id, (item) => {
      item.done = e.done;
    }),
  archiveItem: (txn, e) =>
    txn.update.item(e.id, (item) => {
      item.archived = true;
    }),
};
