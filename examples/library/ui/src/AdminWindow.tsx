import { EditOutlined, LoadingOutlined, PlusOutlined, ReadOutlined } from '@ant-design/icons';
import {
  type AdminBookInfo,
  type AdminEngine,
  type AdminEngineQueryTxn,
  adminQueries,
} from '@library/model/ui';
import {
  Button,
  Card,
  ConfigProvider,
  Divider,
  Flex,
  Input,
  List,
  Modal,
  Spin,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';

import type { Client, Unroomed } from './engines';
import { neutral, PALETTE, STATE_COLORS, tinted } from './theme';
import { useLocalQuery } from './useLocalQuery';
import { generateUuid } from './util';

const { Text } = Typography;

/* ---- types ---- */

type PendingAction =
  | { type: 'book'; bookId: string; restricted: boolean }
  | { type: 'held'; bookId: string; restricted: boolean; holdId: string; patronId: string }
  | null;

/* ---- inline edit ---- */

function InlineEdit({
  value,
  onConfirm,
}: {
  value: string;
  onConfirm: (newValue: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function startEditing() {
    setDraft(value);
    setEditing(true);
  }

  function confirm() {
    if (draft && draft !== value) {
      onConfirm(draft);
    }
    setEditing(false);
  }

  if (editing) {
    return (
      <Flex gap="small" align="center">
        <Input
          size="small"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={confirm}
          autoFocus
        />
        <Button size="small" type="primary" onClick={confirm}>
          OK
        </Button>
        <Button size="small" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </Flex>
    );
  }

  return (
    <Flex gap="small" align="center">
      <Text strong style={{ color: 'inherit' }}>
        {value}
      </Text>
      <EditOutlined onClick={startEditing} style={{ cursor: 'pointer' }} />
    </Flex>
  );
}

// the commands the Engine queues and sends, which are all those the window sends
type Command = Parameters<AdminEngine['sendCommand']>[0];

// the state of the Engine's connection, which a query reads like any other state
function connectionQuery(qx: AdminEngineQueryTxn) {
  return qx.status.connection().state;
}

/* ---- main component ---- */

export default function AdminWindow({ client }: { client: Client<AdminEngine> }) {
  const eng = client.engine;
  const [enabled, setEnabled] = useState(client.transport.online);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [addingEdition, setAddingEdition] = useState(false);
  const [newEditionTitle, setNewEditionTitle] = useState('');

  // --- queries ---

  const patrons = useLocalQuery(eng, adminQueries.allPatrons);
  // each patron's color, by id, for the books they hold or have out
  const colors = new Map(patrons?.map((p) => [p.id, p.color]));
  const editions = useLocalQuery(eng, adminQueries.allEditions);
  const connState = useLocalQuery(eng, connectionQuery) ?? 'connecting';

  // --- handlers ---

  // every command names the window's room
  function send(command: Unroomed<Command>) {
    eng.sendCommand({ ...command, room: client.room });
  }

  // the switch takes the window's way to the database offline, and back online at once
  function setOnline(on: boolean) {
    client.transport.online = on;
    if (on) eng.reconnectNow();
    setEnabled(on);
  }

  function handleBookClick(book: AdminBookInfo) {
    switch (book.state) {
      case 'open':
      case 'restricted':
        setPendingAction({ type: 'book', bookId: book.id, restricted: book.restricted });
        break;
      case 'held':
        setPendingAction({
          type: 'held',
          bookId: book.id,
          restricted: book.restricted,
          holdId: book.holdId!,
          patronId: book.patronId!,
        });
        break;
      case 'out':
        send({
          type: 'end-checkout',
          checkout: book.checkoutId!,
          patron: book.patronId!,
          timestamp: new Date(),
        });
        break;
    }
  }

  function handleCheckout(patronId: string) {
    if (pendingAction?.type !== 'book') return;
    send({
      type: 'try-checkout',
      id: generateUuid(),
      patron: patronId,
      book: pendingAction.bookId,
      timestamp: new Date(),
    });
    setPendingAction(null);
  }

  function handleToggleRestricted() {
    if (!pendingAction) return;
    send({
      type: 'update-book-restricted',
      id: pendingAction.bookId,
      restricted: !pendingAction.restricted,
      timestamp: new Date(),
    });
    setPendingAction(null);
  }

  function handleCancelHold() {
    if (pendingAction?.type !== 'held') return;
    send({ type: 'cancel-hold', id: pendingAction.holdId, patron: pendingAction.patronId });
    setPendingAction(null);
  }

  function handlePromoteHold() {
    if (pendingAction?.type !== 'held') return;
    send({
      type: 'try-checkout',
      id: generateUuid(),
      patron: pendingAction.patronId,
      book: pendingAction.bookId,
      timestamp: new Date(),
    });
    setPendingAction(null);
  }

  function addEdition(title: string) {
    send({ type: 'add-edition', isbn: generateUuid(), title, timestamp: new Date() });
  }

  // --- render ---

  const stateColor = STATE_COLORS[connState];

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          <Text strong>Admin</Text>
          <span style={{ flex: 1 }} />
          <Tag style={tinted(stateColor)}>{connState}</Tag>
          <Switch
            size="small"
            checked={enabled}
            onChange={setOnline}
            checkedChildren="on"
            unCheckedChildren="off"
          />
        </Flex>
      }
      style={{ width: '32em' }}>
      {/* patrons */}
      <Text strong>Patrons</Text>
      {patrons ? (
        <List
          size="small"
          dataSource={patrons}
          renderItem={(patron) => (
            <List.Item>
              <Flex gap="small" align="center" style={{ width: '100%' }}>
                <span
                  style={{
                    // the patron's color, with the name in the dark text the green buttons use
                    backgroundColor: patron.color,
                    color: PALETTE.onAccent,
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}>
                  <ConfigProvider theme={neutral}>
                    <InlineEdit
                      value={patron.name}
                      onConfirm={(name) =>
                        send({ type: 'rename-patron', id: patron.id, name, timestamp: new Date() })
                      }
                    />
                  </ConfigProvider>
                </span>
                <span style={{ flex: 1 }} />
                <Switch
                  size="small"
                  checked={patron.researcher}
                  onChange={(checked) =>
                    send({
                      type: 'assign-patron',
                      id: patron.id,
                      researcher: checked,
                      timestamp: new Date(),
                    })
                  }
                  checkedChildren="R"
                  unCheckedChildren="R"
                />
              </Flex>
            </List.Item>
          )}
        />
      ) : (
        <Spin />
      )}

      {/* editions & books */}
      <Flex align="center" gap="small" style={{ marginTop: 16 }}>
        <Text strong>Editions</Text>
        <PlusOutlined
          style={{ cursor: 'pointer' }}
          onClick={() => {
            setNewEditionTitle('');
            setAddingEdition(true);
          }}
        />
      </Flex>
      {editions ? (
        <List
          size="small"
          dataSource={editions}
          renderItem={(edition) => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <InlineEdit
                  value={edition.title}
                  onConfirm={(title) =>
                    send({
                      type: 'update-edition-title',
                      isbn: edition.isbn,
                      title,
                      timestamp: new Date(),
                    })
                  }
                />
                <Flex gap="small" style={{ marginTop: 4 }} wrap>
                  {edition.books.map((book) => {
                    const color = book.patronId ? colors.get(book.patronId) : undefined;
                    return (
                      <Button
                        key={book.id}
                        size="small"
                        icon={book.pending ? <LoadingOutlined /> : <ReadOutlined />}
                        onClick={() => handleBookClick(book)}
                        style={color ? { borderColor: color, borderWidth: 2 } : undefined}>
                        {book.state}
                      </Button>
                    );
                  })}
                  <Button
                    size="small"
                    type="text"
                    icon={<PlusOutlined />}
                    onClick={() =>
                      send({
                        type: 'add-book',
                        id: generateUuid(),
                        isbn: edition.isbn,
                        restricted: false,
                        timestamp: new Date(),
                      })
                    }
                  />
                </Flex>
              </div>
            </List.Item>
          )}
        />
      ) : (
        <Spin />
      )}

      {/* modal: available book actions */}
      <Modal
        title="Book actions"
        open={pendingAction?.type === 'book'}
        onCancel={() => setPendingAction(null)}
        footer={null}>
        <Text strong>Check out to:</Text>
        <Flex gap="small" wrap style={{ marginTop: 8 }}>
          {patrons?.map((patron) => {
            const restricted = pendingAction?.type === 'book' && pendingAction.restricted;
            const disabled = restricted && !patron.researcher;
            return (
              <Button
                key={patron.id}
                disabled={disabled}
                onClick={() => handleCheckout(patron.id)}
                style={disabled ? undefined : { borderColor: patron.color, borderWidth: 2 }}>
                {patron.name}
              </Button>
            );
          })}
        </Flex>
        <Divider />
        <Button onClick={handleToggleRestricted}>
          {pendingAction?.type === 'book' && pendingAction.restricted
            ? 'Mark Unrestricted'
            : 'Mark Restricted'}
        </Button>
      </Modal>

      {/* modal: held book actions */}
      <Modal
        title="Held book"
        open={pendingAction?.type === 'held'}
        onCancel={() => setPendingAction(null)}
        footer={null}>
        <Flex gap="small">
          <Button onClick={handleCancelHold}>Cancel Hold</Button>
          <Button type="primary" onClick={handlePromoteHold}>
            Check Out
          </Button>
        </Flex>
        <Divider />
        <Button onClick={handleToggleRestricted}>
          {pendingAction?.type === 'held' && pendingAction.restricted
            ? 'Mark Unrestricted'
            : 'Mark Restricted'}
        </Button>
      </Modal>

      {/* modal: add edition */}
      <Modal
        title="New edition"
        open={addingEdition}
        onCancel={() => setAddingEdition(false)}
        onOk={() => {
          if (newEditionTitle.trim()) addEdition(newEditionTitle.trim());
          setAddingEdition(false);
        }}>
        <Input
          placeholder="Title"
          value={newEditionTitle}
          onChange={(e) => setNewEditionTitle(e.target.value)}
          onPressEnter={() => {
            if (newEditionTitle.trim()) addEdition(newEditionTitle.trim());
            setAddingEdition(false);
          }}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
