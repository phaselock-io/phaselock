import { EditOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  type Notice,
  type UserBookInfo,
  type UserEngine,
  type UserEngineQueryTxn,
  userQueries,
} from '@library/model/ui';
import {
  Alert,
  Button,
  Card,
  ConfigProvider,
  Flex,
  Input,
  List,
  Space,
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

function PatronName({ name, onRename }: { name: string; onRename: (newName: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);

  function startEditing() {
    setDraft(name);
    setEditing(true);
  }

  function confirm() {
    if (draft && draft !== name) {
      onRename(draft);
    }
    setEditing(false);
  }

  function cancel() {
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
        <Button size="small" onClick={cancel}>
          Cancel
        </Button>
      </Flex>
    );
  }

  return (
    <Flex gap="small" align="center">
      <Text strong style={{ color: 'inherit' }}>
        {name}
      </Text>
      <EditOutlined onClick={startEditing} style={{ cursor: 'pointer' }} />
    </Flex>
  );
}

function BookItem({
  book,
  researcher,
  onHold,
  onHoldRestricted,
  onCancelHold,
}: {
  book: UserBookInfo;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (isbn: string) => void;
  onCancelHold: (holdId: string) => void;
}) {
  const heldNormal = book.hold && 'edition' in book.hold.target;
  // this assumes book-targeting holds are only used for restricted books, but whatever
  const heldRestricted = book.hold && 'book' in book.hold.target;
  return (
    <List.Item>
      <div style={{ width: '100%' }}>
        <div>{book.title}</div>
        <Flex gap="small" style={{ marginTop: 4 }}>
          {/* hold or cancel-hold */}
          {heldNormal ? (
            <Button
              size="small"
              icon={book.hold!.pending ? <LoadingOutlined /> : undefined}
              onClick={() => onCancelHold(book.hold!.id)}
              type="primary">
              Cancel Hold
            </Button>
          ) : (
            <Button
              size="small"
              disabled={heldRestricted || book.availableNormal < 1}
              onClick={() => onHold(book.isbn)}
              color={'default'}
              variant={'outlined'}>
              Hold
            </Button>
          )}
          {/* hold-restricted or cancel-hold-restricted */}
          {heldRestricted ? (
            <Button
              size="small"
              icon={book.hold!.pending ? <LoadingOutlined /> : undefined}
              onClick={() => onCancelHold(book.hold!.id)}
              type="primary">
              Cancel Hold
            </Button>
          ) : (
            <Button
              size="small"
              disabled={heldNormal || !researcher || book.availableRestricted.length === 0}
              onClick={() => onHoldRestricted(book.availableRestricted[0])}
              color={'default'}
              variant={'outlined'}>
              Hold Restricted
            </Button>
          )}
        </Flex>
      </div>
    </List.Item>
  );
}

function Books({
  eng,
  researcher,
  onHold,
  onHoldRestricted,
  onCancelHold,
}: {
  eng: UserEngine;
  researcher: boolean;
  onHold: (isbn: string) => void;
  onHoldRestricted: (bookId: string) => void;
  onCancelHold: (holdId: string) => void;
}) {
  const books = useLocalQuery(eng, userQueries.allBooks);
  if (!books) return <Spin />;

  return (
    <List
      dataSource={books}
      renderItem={(book) => (
        <BookItem
          book={book}
          researcher={researcher}
          onHold={onHold}
          onHoldRestricted={onHoldRestricted}
          onCancelHold={onCancelHold}
        />
      )}
    />
  );
}

// the patron's notices, each of a hold that failed
function noticesQuery(qx: UserEngineQueryTxn): Notice[] {
  return [...qx.scan.patron_notice()].map(([, notice]) => notice);
}

// the commands the Engine queues and sends, which are all those the window sends
type Command = Parameters<UserEngine['sendCommand']>[0];

// the state of the Engine's connection, which a query reads like any other state
function connectionQuery(qx: UserEngineQueryTxn) {
  return qx.status.connection().state;
}

export default function PatronWindow({
  patronId,
  client,
}: {
  patronId: string;
  client: Client<UserEngine>;
}) {
  const eng = client.engine;
  const [enabled, setEnabled] = useState(client.transport.online);
  const patron = useLocalQuery(eng, userQueries.myPatron);
  const notices = useLocalQuery(eng, noticesQuery) ?? [];
  const connState = useLocalQuery(eng, connectionQuery) ?? 'connecting';
  const stateColor = STATE_COLORS[connState];

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

  function hold(target: { book: string } | { edition: string }) {
    send({
      type: 'try-hold',
      id: generateUuid(),
      patron: patronId,
      target,
      open: false,
      timestamp: new Date(),
    });
  }

  return (
    <Card
      title={
        <Flex align="center" gap="small">
          {patron ? (
            <span
              style={{
                // the patron's color, with the name in the dark text the green buttons use
                backgroundColor: patron.color,
                color: PALETTE.onAccent,
                padding: '2px 8px',
                borderRadius: 4,
              }}>
              <ConfigProvider theme={neutral}>
                <PatronName
                  name={patron.name}
                  onRename={(newName) =>
                    send({
                      type: 'rename-patron',
                      id: patronId,
                      name: newName,
                      timestamp: new Date(),
                    })
                  }
                />
              </ConfigProvider>
            </span>
          ) : (
            <Spin size="small" />
          )}
          {patron?.researcher && <Tag style={tinted(PALETTE.accent)}>researcher</Tag>}
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
      <Books
        eng={eng}
        researcher={patron?.researcher ?? false}
        onHold={(isbn) => hold({ edition: isbn })}
        onHoldRestricted={(bookId) => hold({ book: bookId })}
        onCancelHold={(holdId) => send({ type: 'cancel-hold', id: holdId, patron: patronId })}
      />
      {notices.length > 0 && (
        <div style={{ marginTop: '0.5em' }}>
          <Space direction="vertical" style={{ width: '100%' }} size="small">
            {notices.map((notice) => (
              <Alert key={notice.id} type="warning" showIcon message={notice.reason} />
            ))}
            <Button
              size="small"
              onClick={() => {
                for (const notice of notices) {
                  send({ type: 'patron-dismiss-notice', id: notice.id, patron: patronId });
                }
              }}>
              Dismiss
            </Button>
          </Space>
        </div>
      )}
    </Card>
  );
}
