import type { TodoEngine, TodoEngineQueryTxn, TodoEvents } from '@todo-basic/model/ui';
import { Card, Flex, Spin, Tag, Typography } from 'antd';

import ListView, { InlineAdd, ListData } from './ListView';
import { STATE_COLORS, tinted } from './theme';
import { useLocalQuery } from './useLocalQuery';
import { generateUuid } from './util';

const { Text } = Typography;

// every list that is not archived, with its items that are not archived, in the order made
function listsQuery(qx: TodoEngineQueryTxn): ListData[] {
  const out: ListData[] = [];
  for (const id of qx.get.all_lists() ?? []) {
    const list = qx.get.list(id);
    if (list === undefined || list.archived) continue;
    const items = [];
    for (const itemId of list.items) {
      const item = qx.get.item(itemId);
      if (item === undefined || item.archived) continue;
      items.push({ id: item.id, text: item.text, done: item.done });
    }
    out.push({ id: list.id, name: list.name, items });
  }
  return out;
}

// the state of the Engine's connection, which a query reads like any other state
function connectionQuery(qx: TodoEngineQueryTxn) {
  return qx.status.connection().state;
}

export default function Window({ name, eng }: { name: string; eng: TodoEngine }) {
  const lists = useLocalQuery(eng, listsQuery);
  const connState = useLocalQuery(eng, connectionQuery) ?? 'connecting';
  const stateColor = STATE_COLORS[connState];

  function send(command: TodoEvents) {
    eng.sendCommand(command);
  }

  function addList(listName: string) {
    send({ type: 'new-list', id: generateUuid(), name: listName });
  }

  function renameList(id: string, listName: string) {
    send({ type: 'rename-list', id, name: listName });
  }

  function archiveList(id: string) {
    send({ type: 'archive-list', id });
  }

  function addItem(listId: string, itemText: string) {
    send({ type: 'new-item', id: generateUuid(), list: listId, text: itemText });
  }

  function toggleItem(id: string, done: boolean) {
    send({ type: 'mark-item', id, done });
  }

  function editItem(id: string, text: string) {
    send({ type: 'edit-item', id, text });
  }

  function archiveItem(id: string) {
    send({ type: 'archive-item', id });
  }

  return (
    <Card
      className="window"
      title={
        <Flex align="center" gap="small">
          <Text strong className="grow">
            {name}
          </Text>
          <Tag style={tinted(stateColor)}>{connState}</Tag>
        </Flex>
      }>
      {lists === undefined ? (
        <Spin />
      ) : (
        <>
          {lists.map((list) => (
            <ListView
              key={list.id}
              list={list}
              onRenameList={(name) => renameList(list.id, name)}
              onArchiveList={() => archiveList(list.id)}
              onAddItem={(t) => addItem(list.id, t)}
              onToggleItem={toggleItem}
              onEditItem={editItem}
              onArchiveItem={archiveItem}
            />
          ))}
          <InlineAdd label="add list" placeholder="list name" onSubmit={addList} />
        </>
      )}
    </Card>
  );
}
