import { DownOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  type Notice,
  type UserBookInfo,
  type UserEngine,
  type UserEngineQueryTxn,
  userQueries,
} from '@library/model/ui';
import { Alert, Button, Card, Dropdown, Flex, Space, Spin, Tag, Typography } from 'antd';
import { useState } from 'react';

import type { Client, Unroomed } from './engines';
import { Connection, PatronAvatar, Rename, Section } from './parts';
import { PALETTE, tinted } from './theme';
import { useLocalQuery } from './useLocalQuery';
import { generateUuid } from './util';

const { Text } = Typography;

// the patron's notices, each of a hold that closed or failed without them
function noticesQuery(qx: UserEngineQueryTxn): Notice[] {
  return [...qx.scan.patron_notice()].map(([, notice]) => notice);
}

// the mutations the Engine queues and sends, which are all those the window sends
type Mutation = Parameters<UserEngine['sendMutation']>[0];

// the state of the Engine's connection, which a query reads like any other state
function connectionQuery(qx: UserEngineQueryTxn) {
  return qx.status.connection().state;
}

// a date as a reader says it, such as "Oct 21"
function day(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** what the patron's checkout or hold of a title, or the copies they may hold, come to, in a few
    words */
function availability(book: UserBookInfo, researcher: boolean): string {
  const hold = book.hold;
  if (book.checkout) return 'checked out';
  if (hold?.pending) return 'Placing a hold…';
  if (hold) return hold.expires ? `On hold until ${day(hold.expires)}` : 'On hold';

  // the free copies, the restricted ones only for a researcher, who alone may hold them
  const free: string[] = [];
  if (book.availableNormal > 0) free.push(`${book.availableNormal} available`);
  const restricted = researcher ? book.availableRestricted.length : 0;
  if (restricted > 0) free.push(`${restricted} restricted`);
  return free.length > 0 ? free.join(' · ') : 'every copy is taken';
}

/** One title of the catalog: what of it the patron may hold or has, and one control, which keeps
    the row one height whatever it shows.  A book the patron has out shows when it is due, a hold
    shows its cancel, and otherwise the Hold button offers what is free. */
function BookRow({
  book,
  researcher,
  onHold,
  onCancelHold,
}: {
  book: UserBookInfo;
  researcher: boolean;
  onHold: (target: { book: string } | { edition: string }) => void;
  onCancelHold: (hold: string) => void;
}) {
  const { hold, checkout } = book;
  return (
    <Flex align="center" gap="small" className="row">
      {/* each line keeps to one line, so the row keeps one height */}
      <Flex vertical className="grow">
        <Text ellipsis>{book.title}</Text>
        <Text type="secondary" className="small" ellipsis>
          {availability(book, researcher)}
        </Text>
      </Flex>

      {/* a checkout shows when it is due, in red once it is overdue */}
      {checkout && (
        <Text className="small" style={{ color: checkout.overdue ? PALETTE.alarm : PALETTE.muted }}>
          due {day(checkout.expires)}
        </Text>
      )}

      {/* a hold, pending or decided, may be canceled */}
      {!checkout && hold && (
        <Button
          size="small"
          icon={hold.pending ? <LoadingOutlined /> : undefined}
          onClick={() => onCancelHold(hold.id)}>
          Cancel hold
        </Button>
      )}

      {!checkout && !hold && (
        <HoldButton
          isbn={book.isbn}
          ordinary={book.availableNormal > 0}
          restricted={researcher ? book.availableRestricted[0] : undefined}
          onHold={onHold}
        />
      )}
    </Flex>
  );
}

/** The Hold button: it holds an ordinary copy if one is free, or else the free restricted copy
    offered, and it is disabled when neither is.  When both are free, an arrow joined to its right
    edge offers the choice. */
function HoldButton({
  isbn,
  ordinary,
  restricted,
  onHold,
}: {
  isbn: string;
  ordinary: boolean;
  restricted: string | undefined;
  onHold: (target: { book: string } | { edition: string }) => void;
}) {
  const holdOrdinary = () => onHold({ edition: isbn });
  const holdRestricted = restricted === undefined ? undefined : () => onHold({ book: restricted });
  const hold = ordinary ? holdOrdinary : holdRestricted;
  const button = (
    <Button size="small" disabled={!hold} onClick={hold}>
      Hold
    </Button>
  );
  if (!ordinary || !holdRestricted) return button;

  // both kinds of copy are free, so the arrow offers the choice
  const items = [
    { key: 'ordinary', label: 'Hold an ordinary copy', onClick: holdOrdinary },
    { key: 'restricted', label: 'Hold a restricted copy', onClick: holdRestricted },
  ];
  return (
    <Space.Compact>
      {button}
      <Dropdown menu={{ items }} trigger={['click']} placement="bottomRight">
        <Button size="small" icon={<DownOutlined />} aria-label="Choose a copy to hold" />
      </Dropdown>
    </Space.Compact>
  );
}

export default function PatronWindow({
  patronId,
  client,
}: {
  patronId: string;
  client: Client<UserEngine>;
}) {
  const eng = client.engine;
  const [online, setOnlineState] = useState(client.transport.online);
  const patron = useLocalQuery(eng, userQueries.myPatron);
  const books = useLocalQuery(eng, userQueries.allBooks);
  const notices = useLocalQuery(eng, noticesQuery) ?? [];
  const connState = useLocalQuery(eng, connectionQuery) ?? 'connecting';

  // every mutation names the window's room
  function send(mutation: Unroomed<Mutation>) {
    eng.sendMutation({ ...mutation, room: client.room });
  }

  // the switch takes the window's way to the database offline, and back online at once
  function setOnline(on: boolean) {
    client.transport.online = on;
    if (on) eng.reconnectNow();
    setOnlineState(on);
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
      className="window"
      title={
        <Flex align="center" gap="small">
          {patron ? (
            <>
              <PatronAvatar name={patron.name} color={patron.color} size={24} />
              <Text strong>{patron.name}</Text>
              <Rename
                value={patron.name}
                label="Rename yourself"
                onRename={(name) =>
                  send({ type: 'rename-patron', id: patronId, name, timestamp: new Date() })
                }
              />
              {patron.researcher && <Tag style={tinted(PALETTE.accent)}>researcher</Tag>}
            </>
          ) : (
            <Spin size="small" />
          )}
          <span className="grow" />
          <Connection state={connState} online={online} onOnline={setOnline} />
        </Flex>
      }>
      {/* holds that closed or failed without the patron, each dismissed on its own */}
      {notices.length > 0 && (
        <Flex vertical gap="small" className="notices">
          {notices.map((notice) => (
            <Alert
              key={notice.id}
              type="warning"
              showIcon
              closable={{
                onClose: () =>
                  send({ type: 'patron-dismiss-notice', id: notice.id, patron: patronId }),
              }}
              title={notice.reason}
            />
          ))}
        </Flex>
      )}

      <Section title="Catalog">
        {books ? (
          books.map((book) => (
            <BookRow
              key={book.isbn}
              book={book}
              researcher={patron?.researcher ?? false}
              onHold={hold}
              onCancelHold={(id) => send({ type: 'cancel-hold', id, patron: patronId })}
            />
          ))
        ) : (
          <Spin />
        )}
      </Section>
    </Card>
  );
}
