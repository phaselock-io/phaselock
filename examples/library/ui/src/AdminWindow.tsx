import { LoadingOutlined, PlusOutlined, ReadOutlined } from '@ant-design/icons';
import {
  type AdminBookInfo,
  type AdminEditionInfo,
  type AdminEngine,
  type AdminEngineQueryTxn,
  adminQueries,
  type Notice,
  type Patron,
} from '@library/model/ui';
import { Alert, Button, Card, Divider, Flex, Input, Modal, Spin, Switch, Typography } from 'antd';
import { useState } from 'react';

import type { Client, Unroomed } from './engines';
import { Connection, PatronAvatar, Rename, Section } from './parts';
import { useLocalQuery } from './useLocalQuery';
import { generateUuid } from './util';

const { Text } = Typography;

// the mutations the Engine queues and sends, which are all those the window sends
type Mutation = Parameters<AdminEngine['sendMutation']>[0];

// the state of the Engine's connection, which a query reads like any other state
function connectionQuery(qx: AdminEngineQueryTxn) {
  return qx.status.connection().state;
}

// the librarians' notices, each of a checkout that failed after it was queued
function noticesQuery(qx: AdminEngineQueryTxn): Notice[] {
  return [...qx.scan.admin_notice()].map(([, notice]) => notice);
}

// what each state of a copy is called; a restricted copy that is free is available, and its
// restriction is said apart from its state
const COPY_STATES = {
  open: 'available',
  restricted: 'available',
  held: 'on hold',
  out: 'checked out',
};

// a copy of an edition, as the modal that acts on it holds it
type Selected = { book: AdminBookInfo; title: string };

/** One copy of an edition: its state, a note when it is restricted, and the avatar of the patron
    who holds it or has it out.  Clicking it opens what can be done with it. */
function CopyTile({
  book,
  patron,
  onClick,
}: {
  book: AdminBookInfo;
  patron: Patron | undefined;
  onClick: () => void;
}) {
  const icon = book.pending ? <LoadingOutlined /> : <ReadOutlined />;
  return (
    <Button size="small" icon={icon} onClick={onClick} className="copy">
      {COPY_STATES[book.state]}
      {book.restricted && <span className="restricted">· restricted</span>}
      {patron && <PatronAvatar name={patron.name} color={patron.color} size={16} />}
    </Button>
  );
}

/** Everything that can be done with one copy, by its state: checking it out to a patron, checking
    a held copy out to its holder or releasing the hold, checking it back in, and restricting it. */
function CopyActions({
  selected,
  patrons,
  onClose,
  send,
}: {
  selected: Selected | null;
  patrons: Patron[];
  onClose: () => void;
  send: (mutation: Unroomed<Mutation>) => void;
}) {
  const book = selected?.book;
  const holder = patrons.find((p) => p.id === book?.patronId);

  // each action closes the modal once it is sent
  function act(mutation: Unroomed<Mutation>) {
    send(mutation);
    onClose();
  }

  function checkOut(patron: string) {
    act({
      type: 'try-checkout',
      id: generateUuid(),
      patron,
      book: book!.id,
      timestamp: new Date(),
    });
  }

  return (
    <Modal
      open={selected !== null}
      onCancel={onClose}
      footer={null}
      title={
        selected &&
        [selected.title, COPY_STATES[selected.book.state], selected.book.restricted && 'restricted']
          .filter(Boolean)
          .join(' · ')
      }>
      {book && (
        <Flex vertical gap="middle">
          {/* an available copy goes to whichever patron may have it */}
          {(book.state === 'open' || book.state === 'restricted') && (
            <Flex vertical gap="small">
              <Text type="secondary">Check out to</Text>
              <Flex gap="small" wrap>
                {patrons.map((p) => (
                  <Button
                    key={p.id}
                    disabled={book.restricted && !p.researcher}
                    title={book.restricted && !p.researcher ? 'not a researcher' : undefined}
                    onClick={() => checkOut(p.id)}>
                    <PatronAvatar name={p.name} color={p.color} size={18} />
                    {p.name}
                  </Button>
                ))}
              </Flex>
            </Flex>
          )}

          {/* a held copy goes to its holder, or its hold is released */}
          {book.state === 'held' && holder && (
            <Flex vertical gap="small">
              <Flex align="center" gap="small">
                <Text type="secondary">On hold for</Text>
                <PatronAvatar name={holder.name} color={holder.color} size={18} />
                <Text>{holder.name}</Text>
              </Flex>
              <Flex gap="small">
                <Button type="primary" onClick={() => checkOut(holder.id)}>
                  Check out to {holder.name}
                </Button>
                <Button
                  onClick={() =>
                    act({ type: 'library-cancel-hold', id: book.holdId!, patron: holder.id })
                  }>
                  Release hold
                </Button>
              </Flex>
            </Flex>
          )}

          {/* a copy that is out comes back */}
          {book.state === 'out' && holder && (
            <Flex vertical gap="small">
              <Flex align="center" gap="small">
                <Text type="secondary">Checked out by</Text>
                <PatronAvatar name={holder.name} color={holder.color} size={18} />
                <Text>{holder.name}</Text>
              </Flex>
              <div>
                <Button
                  type="primary"
                  onClick={() =>
                    act({
                      type: 'end-checkout',
                      checkout: book.checkoutId!,
                      patron: holder.id,
                      timestamp: new Date(),
                    })
                  }>
                  Check in
                </Button>
              </div>
            </Flex>
          )}

          {/* any copy may be restricted to researchers, or released to everyone */}
          <Divider style={{ margin: 0 }} />
          <div>
            <Button
              onClick={() =>
                act({
                  type: 'update-book-restricted',
                  id: book.id,
                  restricted: !book.restricted,
                  timestamp: new Date(),
                })
              }>
              {book.restricted ? 'Open to everyone' : 'Restrict to researchers'}
            </Button>
          </div>
        </Flex>
      )}
    </Modal>
  );
}

/** one edition: its title, and a tile for each of its copies */
function EditionRow({
  edition,
  patrons,
  onSelect,
  send,
}: {
  edition: AdminEditionInfo;
  patrons: Map<string, Patron>;
  onSelect: (book: AdminBookInfo) => void;
  send: (mutation: Unroomed<Mutation>) => void;
}) {
  return (
    <div className="row">
      <Flex align="center" gap={4}>
        <Text strong>{edition.title}</Text>
        <Rename
          value={edition.title}
          label="Rename edition"
          onRename={(title) =>
            send({ type: 'update-edition-title', isbn: edition.isbn, title, timestamp: new Date() })
          }
        />
      </Flex>
      <Flex gap={6} wrap className="copies">
        {edition.books.map((book) => (
          <CopyTile
            key={book.id}
            book={book}
            patron={book.patronId === undefined ? undefined : patrons.get(book.patronId)}
            onClick={() => onSelect(book)}
          />
        ))}
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
          }>
          copy
        </Button>
      </Flex>
    </div>
  );
}

export default function AdminWindow({ client }: { client: Client<AdminEngine> }) {
  const eng = client.engine;
  const [online, setOnlineState] = useState(client.transport.online);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [addingEdition, setAddingEdition] = useState(false);
  const [newEditionTitle, setNewEditionTitle] = useState('');

  // --- queries ---

  const allPatrons = useLocalQuery(eng, adminQueries.allPatrons);
  const patrons = allPatrons && [...allPatrons].sort((a, b) => a.name.localeCompare(b.name));
  const byId = new Map(patrons?.map((p) => [p.id, p]));
  const editions = useLocalQuery(eng, adminQueries.allEditions);
  const notices = useLocalQuery(eng, noticesQuery) ?? [];
  const connState = useLocalQuery(eng, connectionQuery) ?? 'connecting';

  // --- handlers ---

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

  function addEdition() {
    const title = newEditionTitle.trim();
    if (title !== '') {
      send({ type: 'add-edition', isbn: generateUuid(), title, timestamp: new Date() });
    }
    setAddingEdition(false);
  }

  // --- render ---

  return (
    <Card
      className="window"
      title={
        <Flex align="center" gap="small">
          <Text strong>Front Desk</Text>
          <span className="grow" />
          <Connection state={connState} online={online} onOnline={setOnline} />
        </Flex>
      }>
      {/* checkouts that failed after the desk moved on */}
      {notices.length > 0 && (
        <Flex vertical gap="small" className="notices">
          {notices.map((notice) => (
            <Alert
              key={notice.id}
              type="warning"
              showIcon
              closable={{ onClose: () => send({ type: 'dismiss-notice', id: notice.id }) }}
              title={`Checkout failed: ${notice.reason}`}
            />
          ))}
        </Flex>
      )}

      <Section title="Patrons">
        {patrons ? (
          patrons.map((patron) => (
            <Flex key={patron.id} align="center" gap="small" className="row">
              <PatronAvatar name={patron.name} color={patron.color} />
              <Text>{patron.name}</Text>
              <Rename
                value={patron.name}
                label="Rename patron"
                onRename={(name) =>
                  send({ type: 'rename-patron', id: patron.id, name, timestamp: new Date() })
                }
              />
              <span className="grow" />
              <Text type="secondary">researcher</Text>
              <Switch
                size="small"
                checked={patron.researcher}
                onChange={(researcher) =>
                  send({ type: 'assign-patron', id: patron.id, researcher, timestamp: new Date() })
                }
              />
            </Flex>
          ))
        ) : (
          <Spin />
        )}
      </Section>

      <Section
        title="Catalog"
        action={
          <Button
            size="small"
            type="text"
            icon={<PlusOutlined />}
            onClick={() => {
              setNewEditionTitle('');
              setAddingEdition(true);
            }}>
            edition
          </Button>
        }>
        {editions ? (
          editions.map((edition) => (
            <EditionRow
              key={edition.isbn}
              edition={edition}
              patrons={byId}
              onSelect={(book) => setSelected({ book, title: edition.title })}
              send={send}
            />
          ))
        ) : (
          <Spin />
        )}
      </Section>

      <CopyActions
        selected={selected}
        patrons={patrons ?? []}
        onClose={() => setSelected(null)}
        send={send}
      />

      <Modal
        title="New edition"
        open={addingEdition}
        okText="Add"
        onCancel={() => setAddingEdition(false)}
        onOk={addEdition}>
        <Input
          placeholder="Title"
          value={newEditionTitle}
          onChange={(e) => setNewEditionTitle(e.target.value)}
          onPressEnter={addEdition}
          autoFocus
        />
      </Modal>
    </Card>
  );
}
