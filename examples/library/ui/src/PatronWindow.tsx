import { LoadingOutlined } from '@ant-design/icons';
import {
  type Notice,
  type UserBookInfo,
  type UserEngine,
  type UserEngineQueryTxn,
  type UserPatronInfo,
  userQueries,
} from '@library/model/ui';
import { Alert, Button, Card, Flex, Spin, Tag, Typography } from 'antd';
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

/** what the patron's hold on a title, or the title's unrestricted copies, come to, in a few words */
function availability(book: UserBookInfo): string {
  const hold = book.hold;
  if (hold?.pending) return 'Placing a hold…';
  if (hold) return hold.expires ? `On hold for you until ${day(hold.expires)}` : 'On hold for you';
  if (book.availableNormal > 0) return `${book.availableNormal} available`;
  return 'every copy is taken';
}

/** One title of the catalog: its availability and its actions, a hold or the hold's cancel.  A
    researcher may also hold a free restricted copy, with a second button beneath the first. */
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
  const hold = book.hold;
  const restricted = book.availableRestricted[0];
  return (
    <Flex align="center" gap="small" className="row">
      <Flex vertical className="grow">
        <Text>{book.title}</Text>
        <Text type="secondary" className="small">
          {availability(book)}
        </Text>
      </Flex>

      {/* a hold, pending or decided, may be canceled */}
      {hold ? (
        <Button
          size="small"
          icon={hold.pending ? <LoadingOutlined /> : undefined}
          onClick={() => onCancelHold(hold.id)}>
          Cancel hold
        </Button>
      ) : (
        <Flex vertical gap={4} className="actions">
          <Button
            size="small"
            disabled={book.availableNormal < 1}
            onClick={() => onHold({ edition: book.isbn })}>
            Hold
          </Button>
          {researcher && restricted !== undefined && (
            <Button size="small" onClick={() => onHold({ book: restricted })}>
              Hold restricted
            </Button>
          )}
        </Flex>
      )}
    </Flex>
  );
}

/** the books the patron has out, each with when it is due */
function Checkouts({ patron }: { patron: UserPatronInfo }) {
  return (
    <Section title="Checked out">
      {patron.checkouts.map((c) => (
        <Flex key={c.id} align="center" gap="small" className="row">
          <Text className="grow">{c.title}</Text>
          {c.overdue ? (
            <Tag style={tinted(PALETTE.alarm)}>overdue</Tag>
          ) : (
            <Text type="secondary" className="small">
              due {day(c.expires)}
            </Text>
          )}
        </Flex>
      ))}
    </Section>
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

      {patron !== undefined && patron.checkouts.length > 0 && <Checkouts patron={patron} />}

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
