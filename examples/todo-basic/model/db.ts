// The database's bundle: the deciders, which check every mutation and write the keys it changes.
// The demo has no accounts, so anyone may send anything and see everything.

import { defineTodoDB, Reject, type TodoDBDeciders, type TodoDBTxn } from './model.gen';

function requireList(txn: TodoDBTxn, id: string): void {
  if (txn.get.list(id) === undefined) throw new Reject('no such list');
}

function requireItem(txn: TodoDBTxn, id: string): void {
  if (txn.get.item(id) === undefined) throw new Reject('no such item');
}

// every mutation writes the lists and items it changes, once what it names is known to exist
const deciders: TodoDBDeciders = {
  newList: (auth, txn, m) => {
    auth.authorizeAnyone();
    if (txn.get.list(m.id) !== undefined) throw new Reject('list exists');
    txn.set.all_lists([...(txn.get.all_lists() ?? []), m.id]);
    txn.set.list(m.id, { id: m.id, name: m.name, items: [], archived: false });
  },
  renameList: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireList(txn, m.id);
    txn.update.list(m.id, (list) => {
      list.name = m.name;
    });
  },
  archiveList: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireList(txn, m.id);
    txn.update.list(m.id, (list) => {
      list.archived = true;
    });
  },
  newItem: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireList(txn, m.list);
    if (txn.get.item(m.id) !== undefined) throw new Reject('item exists');
    txn.set.item(m.id, { id: m.id, text: m.text, done: false, archived: false });
    txn.update.list(m.list, (list) => {
      list.items.push(m.id);
    });
  },
  editItem: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireItem(txn, m.id);
    txn.update.item(m.id, (item) => {
      item.text = m.text;
    });
  },
  markItem: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireItem(txn, m.id);
    txn.update.item(m.id, (item) => {
      item.done = m.done;
    });
  },
  archiveItem: (auth, txn, m) => {
    auth.authorizeAnyone();
    requireItem(txn, m.id);
    txn.update.item(m.id, (item) => {
      item.archived = true;
    });
  },
};

defineTodoDB({
  deciders,
  // everyone is allowed to see the todo slice
  grant: () => ['todo!'],
  // this example doesn't have a login system at all
  lookup: () => null,
});
