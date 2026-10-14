// The database's bundle: the todo slice's reducers, and precommit, which decides every command.
// The demo has no accounts, so anyone may send anything and see everything.

import { defineTodoDB, Reject, type TodoDBPrecommit, type TodoDBTxn } from './model.gen';
import { todoReducers } from './reducers';

function requireList(txn: TodoDBTxn, id: string): void {
  if (txn.get.list(id) === undefined) throw new Reject('no such list');
}

function requireItem(txn: TodoDBTxn, id: string): void {
  if (txn.get.item(id) === undefined) throw new Reject('no such item');
}

// every command is its own event, once what it names is known to exist
const precommit: TodoDBPrecommit = {
  newList: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    if (txn.get.list(cmd.id) !== undefined) throw new Reject('list exists');
    return { stream: 'todo', event: cmd };
  },
  renameList: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireList(txn, cmd.id);
    return { stream: 'todo', event: cmd };
  },
  archiveList: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireList(txn, cmd.id);
    return { stream: 'todo', event: cmd };
  },
  newItem: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireList(txn, cmd.list);
    if (txn.get.item(cmd.id) !== undefined) throw new Reject('item exists');
    return { stream: 'todo', event: cmd };
  },
  editItem: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireItem(txn, cmd.id);
    return { stream: 'todo', event: cmd };
  },
  markItem: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireItem(txn, cmd.id);
    return { stream: 'todo', event: cmd };
  },
  archiveItem: (auth, txn, cmd) => {
    auth.authorizeAnyone();
    requireItem(txn, cmd.id);
    return { stream: 'todo', event: cmd };
  },
};

defineTodoDB({
  reducers: { todo: todoReducers },
  precommit,
  // everyone is allowed to see the todo stream
  maySee: () => ['todo!'],
  // this example doesn't have a login system at all
  lookup: () => null,
});
