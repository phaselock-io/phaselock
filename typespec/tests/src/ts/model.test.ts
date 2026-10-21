/**
 * What the TypeScript emitter generates from the slice vocabulary.  One model below exercises
 * every shape: a singleton slice, a slice with two parameters, database-only slices, an engine
 * with one mutation and one with several, and @online mutations carrying intake types.  Runtime
 * tests import the generated module; type tests compile snippets of user code against it,
 * asserting their errors with `// @ts-expect-error`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  type Bundle,
  InMemStore,
  JS,
  type Mutation,
  type ReadTxn,
  type RTxn,
  scanAll,
  type Schema,
  type Session,
  type StoreScan,
} from '../../../ts/assets/skeleton.ts';
import { bootstrap, FakeServer, registry, settle } from '../engine/harness.ts';

import { emit, outDir, typecheck } from './emit-harness.ts';

const SOURCE = `
  alias Id = string;

  // the catalog: a singleton slice
  interface CatalogSlice extends Slice<"catalog", {
    "item:{item}": Item;
    "count": int32;
  }> {}

  model Item { id: Id; title: string; added: utcDateTime; }

  // an inbox per org and user: a slice with two parameters
  interface InboxSlice extends Slice<"inbox:{org},{user}", {
    "profile": Profile;
    "note:{note}": string;
  }> {}

  model Profile { name: string; }

  // secrets: a database-only slice
  interface SecretSlice extends Slice<"secret:{user}", { "secret": PasswordHash }> {}

  // preferences: a database-only slice whose parameters share names with accessor arguments
  interface PrefSlice extends Slice<"pref:{options}", { "pref:{value}": string }> {}

  model AddItem { type: "add-item"; id: Id; title: string; added: utcDateTime; }
  model RemoveItem { type: "remove-item"; id: Id; }
  model SetProfile { type: "set-profile"; org: Id; user: Id; name: string; }
  model Note { type: "note"; org: Id; user: Id; note: Id; text: string; }
  @online
  model SignUp { type: "sign-up"; org: Id; user: Id; name: string; password: NewPassword; }
  @online
  model Leave { type: "leave"; org: Id; check: MutationAuth; }
  model Forget { type: "forget"; org: Id; user: Id; }
  model Sweep { type: "sweep"; id: Id; }

  interface ReaderEngine extends Engine<[CatalogSlice], AddItem> {}

  union WriterMutations { AddItem, RemoveItem, SetProfile, Note, Leave, Forget }

  interface WriterEngine extends Engine<[CatalogSlice, InboxSlice], WriterMutations> {}

  union DbMutations { Sweep, SignUp }

  interface AppDB extends Database<[ReaderEngine, WriterEngine], [SecretSlice, PrefSlice], DbMutations> {}
`;

/* Snippets of user code, each type-checked as its own file against the generated module.  A
   snippet passes when it compiles with no diagnostics, so each error it expects is marked with
   `// @ts-expect-error` on the line before, and an expected error that does not happen fails. */
const SNIPPETS: Record<string, string> = {
  contexts: `
    import type {
      AppDBReadTxn,
      AppDBTxn,
      Item,
      PasswordHash,
      Profile,
      ReaderEngineQueryTxn,
      ReaderEngineReadTxn,
      ReaderEngineTxn,
      WriterEngineReadTxn,
      WriterEngineTxn,
    } from './model.gen.ts';

    declare const reader: ReaderEngineTxn;
    declare const readerQuery: ReaderEngineQueryTxn;
    declare const writer: WriterEngineTxn;
    declare const db: AppDBTxn;
    declare const dbRead: AppDBReadTxn;
    declare function export_(s: string): void;

    export const item: Item | undefined = reader.get.item('i1');
    export const count: number | undefined = reader.get.count();
    // @ts-expect-error the reader engine syncs no inbox
    reader.get.profile('acme', 'u1');
    export const profile: Profile | undefined = writer.get.profile('acme', 'u1');
    export const note: string | undefined = writer.get.note('acme', 'u1', 'n1');
    export const secret: PasswordHash | undefined = db.get.secret('u1');

    // scans: a match by name on any of the varying parameters, each yielded by name
    for (const [{ org, user, note }, text] of writer.scan.note({ org: 'acme', note: { gte: 'a' } })) {
      export_(org + user + note + text);
    }
    for (const [{ org, user }, p] of db.scan.profile({}, { reverse: true })) {
      export_(org + user + p.name);
    }
    for (const { item } of reader.scan.item(undefined, { keys: true })) export_(item);
    // @ts-expect-error keys only yields the parameters alone
    for (const [{ item }] of reader.scan.item({}, { keys: true })) export_(item);
    // @ts-expect-error a misspelled parameter
    writer.scan.note({ orgg: 'acme' });
    // @ts-expect-error a match is a value, a range, or a prefix
    writer.scan.note({ org: 1 });
    // @ts-expect-error a template whose family and key have no parameters names one key
    void reader.scan.count;

    // writes: set, del, update, and deleteSlice, each taking the family's parameters first
    writer.set.profile('acme', 'u1', { name: 'Ann' });
    writer.set.note('acme', 'u1', 'n1', 'hi');
    writer.del.note('acme', 'u1', 'n1');
    export const renamed: string = writer.update.profile('acme', 'u1', (p) => (p.name = 'Bob'));
    writer.deleteSlice.inbox('acme', 'u1');
    writer.deleteSlice.inbox('acme', 'u1', { erase: true });
    db.deleteSlice.catalog();
    db.set.pref('dark', 'theme', 'on');
    db.deleteSlice.pref('dark', { erase: true });
    // @ts-expect-error erase is true or left out
    writer.deleteSlice.inbox('acme', 'u1', { erase: false });
    // @ts-expect-error a slice is named by every parameter of its family
    writer.deleteSlice.inbox('acme');
    // @ts-expect-error a value of the key's type
    writer.set.profile('acme', 'u1', { title: 'Ann' });
    // @ts-expect-error a value that is not updated in place has no update
    void writer.update.count;

    // the database's context passes wherever one of its engines' contexts is wanted, writes
    // included
    export const asWriter: WriterEngineTxn = db;
    export const asReader: ReaderEngineTxn = db;

    // every context passes as a read context, and the database's as each engine's
    export const readsWriter: WriterEngineReadTxn = writer;
    export const readsQuery: ReaderEngineReadTxn = readerQuery;
    export const readsDb: WriterEngineReadTxn = dbRead;
    export const readsDbTxn: AppDBReadTxn = db;

    // a read context writes nothing
    // @ts-expect-error a read context has no set
    void dbRead.set;

    // a query reads the engine's slices and the Engine's status, and writes nothing
    export const hasBase: boolean = readerQuery.status.connection().hasBase;
    export const queried: Item | undefined = readerQuery.get.item('i1');
    // @ts-expect-error a prediction reads no status
    void reader.status;
    // @ts-expect-error a query writes nothing
    export const asReaderFromQuery: ReaderEngineTxn = readerQuery;
  `,

  deciders: `
    import {
      type AppDBDeciders,
      type AppDBTxn,
      type Auth,
      type PasswordHash,
      Reject,
      type Sweep,
      type WriterEnginePredictors,
    } from './model.gen.ts';

    // a predictor shared with the decider, which authorizes and then calls it
    const predictors = {
      addItem: (txn, m) => {
        txn.set.item(m.id, { id: m.id, title: m.title, added: m.added });
      },
    } satisfies WriterEnginePredictors;

    // a helper typed by the generated names
    function sweep(auth: Auth, txn: AppDBTxn, m: Sweep): void {
      auth.authorize(auth.user === 'root', 'root only');
      if (txn.get.item(m.id) === undefined) throw new Reject('no such item');
      txn.del.item(m.id);
    }

    export const deciders: AppDBDeciders = {
      addItem: (auth, txn, m) => {
        auth.authorize(auth.user !== null);
        predictors.addItem(txn, m);
      },
      removeItem: (auth, txn, m) => {
        auth.authorizeAnyone();
        txn.del.item(m.id);
      },
      setProfile: (auth, txn, m) => {
        auth.authorize(auth.user === m.user);
        txn.set.profile(m.org, m.user, { name: m.name });
      },
      note: (auth, txn, m) => {
        auth.authorizeAnyone();
        txn.set.note(m.org, m.user, m.note, m.text);
      },
      signUp: (auth, txn, m) => {
        auth.authorizeAnyone();
        const hash: PasswordHash = m.password;
        txn.set.secret(m.user, hash);
        txn.set.profile(m.org, m.user, { name: m.name });
      },
      leave: (auth, txn, m) => {
        auth.authorize(m.check.kind === 'password' && auth.user !== null);
        txn.deleteSlice.inbox(m.org, auth.user!);
      },
      forget: (auth, txn, m) => {
        auth.authorizeAnyone();
        txn.deleteSlice.inbox(m.org, m.user, { erase: true });
      },
      sweep,
    };
  `,

  deciderErrors: `
    import type { AppDBDeciders } from './model.gen.ts';

    declare const ok: AppDBDeciders;
    const { sweep: _sweep, ...rest } = ok;

    // @ts-expect-error every mutation needs its decider
    export const missing: AppDBDeciders = rest;

    export const extra: AppDBDeciders = {
      ...ok,
      // @ts-expect-error a misspelled decider
      sweeep: ok.sweep,
    };

    export const wrong: Partial<AppDBDeciders> = {
      // @ts-expect-error a mutation's own fields
      removeItem: (_auth, _txn, m) => void m.title,
      // @ts-expect-error a decider sees the prepared mutation, not the client's password
      signUp: (_auth, txn, m: { user: string; password: number }) => txn.set.secret(m.user, ''),
    };
  `,

  predictors: `
    import type { ReaderEnginePredictors, WriterEnginePredictors } from './model.gen.ts';

    export const reader: ReaderEnginePredictors = {
      addItem: (txn, m) => {
        if (txn.get.item(m.id) !== undefined) throw new Error('already added');
        txn.set.item(m.id, { ...m });
      },
    };

    // a table may leave mutations out, which predict nothing, and a predictor may mark what it
    // writes as pending
    export const writer: WriterEnginePredictors = {
      note: (txn, m, pending) => {
        void txn.get.profile(m.org, m.user);
        txn.set.note(m.org, m.user, m.note, pending ? m.text + ' (sending)' : m.text);
      },
      forget: (txn, m) => txn.deleteSlice.inbox(m.org, m.user),
      // @ts-expect-error an @online mutation is never predicted
      leave: () => {},
    };
  `,

  intake: `
    import type {
      MutationAuthResult,
      Leave,
      LeaveForDecider,
      PasswordHash,
      SignUp,
      SignUpForDecider,
    } from './model.gen.ts';

    // the client sends the wire types
    export const signUp: SignUp = {
      type: 'sign-up',
      org: 'acme',
      user: 'u1',
      name: 'Ann',
      password: 'hunter2',
    };
    export const leave: Leave = {
      type: 'leave',
      org: 'acme',
      check: { kind: 'password', password: 'hunter2' },
    };

    // the decider sees the mutation as the database prepared it
    declare const received: SignUpForDecider;
    export const hash: PasswordHash = received.password;
    declare const left: LeaveForDecider;
    export const result: MutationAuthResult = left.check;
    // @ts-expect-error the prepared mutation carries the result, not the client's proof
    void left.check.password;

    // the results are plain aliases of their shapes
    export const text: string = hash;
    export const plain: PasswordHash = 'hunter2';
    export const auth: MutationAuthResult = { kind: 'password' };
  `,

  sending: `
    import type {
      AddItem,
      Item,
      Leave,
      MutationResult,
      Query,
      ReaderEngine,
      WriterEngine,
    } from './model.gen.ts';

    declare const writer: WriterEngine;
    declare const reader: ReaderEngine;
    declare const add: AddItem;
    declare const leave: Leave;

    writer.sendMutation(add);
    // @ts-expect-error an @online mutation never enters the outbox
    writer.sendMutation(leave);
    export const outcome: Promise<MutationResult> = writer.sendOnlineMutation(leave);
    // @ts-expect-error a mutation that is not @online goes through the outbox
    void writer.sendOnlineMutation(add);
    // @ts-expect-error the reader engine sends no @online mutation
    void reader.sendOnlineMutation(leave);

    export const q: Query<Item | undefined> = writer.newQuery((txn) => txn.get.item('i1'));
    export const loading: Query<boolean> = writer.newQuery(
      (txn) => !txn.status.connection().hasBase,
    );
  `,

  engines: `
    import {
      type ReaderEnginePredictors,
      type Session,
      type StoreFactory,
      type Transport,
      WriterEngine,
      type WriterEnginePredictors,
    } from './model.gen.ts';

    declare const transport: Transport;
    declare const session: Session;
    declare const store: StoreFactory;
    declare const predictors: WriterEnginePredictors;
    declare const readerPredictors: ReaderEnginePredictors;

    export const engine = new WriterEngine(transport, { session, predictors });
    export const anonymous = new WriterEngine(transport, { session: null, store });
    // a table of a narrower engine predicts the mutations both send
    export const narrow = new WriterEngine(transport, { session, predictors: readerPredictors });
    // @ts-expect-error the session is required, null for anonymous
    new WriterEngine(transport, { predictors });
    // @ts-expect-error a predictor for a mutation the engine does not send
    new WriterEngine(transport, { session, predictors: { sweep: () => {} } });
  `,

  posting: `
    import {
      type AddItem,
      type MutationResult,
      postAppMutation,
      type Session,
      type SignUp,
      type Transport,
    } from './model.gen.ts';

    declare const transport: Transport;
    declare const session: Session;
    declare const signUp: SignUp;
    declare const add: AddItem;

    export const anonymous: Promise<MutationResult> = postAppMutation(transport, signUp);
    export const signedIn: Promise<MutationResult> = postAppMutation(transport, add, { session });
    // @ts-expect-error only the database's mutations
    void postAppMutation(transport, { type: 'not-a-mutation' });
  `,

  database: `
    import { type AppDBGrantor, type AppDBSlots, defineAppDB } from './model.gen.ts';

    declare const slots: AppDBSlots;
    defineAppDB(slots);

    // bootstrap is optional
    const { bootstrap: _bootstrap, ...rest } = slots;
    defineAppDB(rest);

    // bootstrap writes through its transaction
    defineAppDB({
      ...slots,
      bootstrap: (txn, ctx) => {
        txn.set.count(0);
        txn.set.secret('root', ctx.hashPassword(ctx.env('PASSWORD')));
        // @ts-expect-error a value of the key's type
        txn.set.count('none');
      },
    });

    // grant and lookup only read
    export const grant: AppDBGrantor = (txn, principal) => {
      // @ts-expect-error a grantor writes nothing
      txn.set.count(1);
      return txn.get.secret(principal.user ?? '') === undefined ? [] : ['catalog'];
    };
    defineAppDB({
      ...slots,
      grant,
      lookup: (txn, ident) => {
        // @ts-expect-error lookup writes nothing
        txn.del.secret('u1');
        return ident.kind === 'password' ? { user: ident.identity } : null;
      },
    });
  `,

  plugins: `
    import {
      type AppDBDeciders,
      type DbMarker,
      type DbTypes,
      type PluginInstall,
      defineAppDB,
    } from './model.gen.ts';

    // a plugin with requests, as its package ships it: the request API, and an install whose
    // hooks take the database's types from the slot the install lands in
    type EmailPlugin = PluginInstall<{ send(requestId: string, to: string): void }>;
    declare const Email: {
      install<DB extends DbTypes>(hooks: {
        sent(txn: DB['txn'], requestId: string): void;
      }): EmailPlugin & DbMarker<DB>;
    };

    // a plugin without requests, as cron is
    type Tick = { name: string; slot: Date; now: Date };
    type CronPlugin = PluginInstall<{}>;
    declare const Cron: {
      install<DB extends DbTypes>(
        entries: Record<string, { spec: string; hook(txn: DB['txn'], tick: Tick): void }>,
      ): CronPlugin & DbMarker<DB>;
    };

    // the app's plugin set, named once for the deciders and the database
    type MyPlugins = { email: EmailPlugin; cron: CronPlugin };
    declare const deciders: AppDBDeciders<MyPlugins>;

    // a decider requests through the txn
    export const sweep: AppDBDeciders<MyPlugins>['sweep'] = (auth, txn, m) => {
      auth.authorizeAnyone();
      txn.email.send(m.id, 'a@b');
      const _cron: {} = txn.cron;
      // @ts-expect-error not a request of the email plugin
      txn.email.charge(m.id);
      txn.del.item(m.id);
    };

    // installs infer the database's types, so their hooks read and write the txn and request
    // through it
    defineAppDB<MyPlugins>({
      deciders,
      grant: (txn) => {
        // @ts-expect-error the grantor's txn requests nothing
        txn.email.send('r1', 'a@b');
        return [];
      },
      lookup: () => null,
      plugins: {
        email: Email.install({
          sent: (txn, requestId) => {
            txn.email.send(\`\${requestId}-again\`, 'a@b');
            txn.set.note('acme', 'u1', requestId, 'sent');
          },
        }),
        cron: Cron.install({
          digest: {
            spec: '0 8 * * *',
            hook: (txn, tick) => txn.del.item(txn.get.item('i1')?.id ?? String(tick.slot.getTime())),
          },
          bogus: {
            spec: '0 9 * * *',
            // @ts-expect-error no such key
            hook: (txn) => txn.set.bogus('x'),
          },
        }),
      },
    });

    // every plugin of the set is installed
    defineAppDB<MyPlugins>({
      deciders,
      grant: () => [],
      lookup: () => null,
      // @ts-expect-error the set names cron, which is not installed
      plugins: { email: Email.install({ sent: () => {} }) },
    });

    // a set that names plugins needs its plugins slot
    // @ts-expect-error no plugins slot
    defineAppDB<MyPlugins>({ deciders, grant: () => [], lookup: () => null });

    // and nothing outside the set is installed
    type MailOnly = { email: EmailPlugin };
    declare const mailOnly: AppDBDeciders<MailOnly>;
    defineAppDB<MailOnly>({
      deciders: mailOnly,
      grant: () => [],
      lookup: () => null,
      plugins: {
        email: Email.install({ sent: () => {} }),
        // @ts-expect-error cron is not in the set
        cron: Cron.install({}),
      },
    });

    // deciders written for another set than the database installs
    defineAppDB<MailOnly>({
      // @ts-expect-error its deciders expect cron on the txn
      deciders,
      grant: () => [],
      lookup: () => null,
      plugins: { email: Email.install({ sent: () => {} }) },
    });

    // no plugin is named after a context field
    type Shadowing = { deleteSlice: EmailPlugin };
    declare const shadowing: AppDBDeciders<Shadowing>;
    defineAppDB<Shadowing>({
      deciders: shadowing,
      grant: () => [],
      lookup: () => null,
      // @ts-expect-error deleteSlice is a context field
      plugins: { deleteSlice: Email.install({ sent: () => {} }) },
    });
  `,
};

let M: any;
let text: string;
let diagnostics: Record<string, string[]>;

beforeAll(async () => {
  const dir = outDir('model-test');
  const out = await emit(SOURCE, dir);
  text = out.text;
  M = await import(out.file);
  diagnostics = typecheck(dir, SNIPPETS);
}, 60_000);

/** assert a snippet compiles with no diagnostics beyond the errors it marks */
function compiles(name: string): void {
  expect(diagnostics[name]).toEqual([]);
}

/** a WriteTxn over a map, recording each call */
function fakeTxn(data: Map<string, unknown> = new Map()) {
  const calls: unknown[][] = [];
  const txn = {
    get(key: string, type: string): unknown {
      calls.push(['get', key, type]);
      return data.get(key);
    },
    scan(): StoreScan {
      throw new Error('a fake transaction does not scan');
    },
    set(key: string, type: string, value: unknown): void {
      calls.push(['set', key, type, value]);
      data.set(key, value);
    },
    del(key: string): void {
      calls.push(['del', key]);
      data.delete(key);
    },
    deleteSlice(slice: string, erase: boolean): void {
      calls.push(['deleteSlice', slice, erase]);
      for (const key of [...data.keys()]) if (key.startsWith(`${slice}!`)) data.delete(key);
    },
  };
  return { txn, calls, data };
}

/** a generated context, bound to txn */
function bound(created: { ctx: any; $ref: { txn: unknown } }, txn: unknown): any {
  created.$ref.txn = txn;
  return created.ctx;
}

const added = new Date('2024-01-02T03:04:05Z');

describe('contexts', () => {
  it('keeps one context, reading through the transaction its box was last assigned', () => {
    const one = fakeTxn(new Map([['catalog!count', 1]]));
    const two = fakeTxn(new Map([['catalog!count', 2]]));
    const { ctx, $ref } = M.createAppDBTxn();
    $ref.txn = one.txn;
    expect(ctx.get.count()).toBe(1);
    $ref.txn = two.txn;
    expect(ctx.get.count()).toBe(2);
  });

  it('throws when a context is used before it is bound', () => {
    expect(() => M.createAppDBTxn().ctx.get.count()).toThrow(
      'a context was used before it was bound to a transaction',
    );
  });

  it("generates an engine's predict context, which reads and writes its slices", () => {
    const { txn } = fakeTxn();
    const ctx = bound(M.createWriterEngineTxn(), txn);
    expect(Object.keys(ctx).sort()).toEqual(['del', 'deleteSlice', 'get', 'scan', 'set', 'update']);
    expect(Object.keys(ctx.get).sort()).toEqual(['count', 'item', 'note', 'profile']);
    expect(Object.keys(ctx.set).sort()).toEqual(['count', 'item', 'note', 'profile']);
    expect(Object.keys(ctx.update).sort()).toEqual(['item', 'profile']);
    expect(Object.keys(ctx.deleteSlice).sort()).toEqual(['catalog', 'inbox']);
    expect(Object.keys(bound(M.createReaderEngineTxn(), txn).get).sort()).toEqual([
      'count',
      'item',
    ]);
    compiles('contexts');
  });

  it("generates an engine's query context, which reads its slices and the Engine's status", () => {
    const { txn } = fakeTxn();
    const ctx = bound(M.createWriterEngineQueryTxn(), txn);
    expect(Object.keys(ctx).sort()).toEqual(['get', 'scan', 'status']);
  });

  it("generates a database's context over all of its slices", () => {
    const { txn } = fakeTxn();
    const ctx = bound(M.createAppDBTxn(), txn);
    expect(Object.keys(ctx.get).sort()).toEqual([
      'count',
      'item',
      'note',
      'pref',
      'profile',
      'secret',
    ]);
    expect(Object.keys(ctx.deleteSlice).sort()).toEqual(['catalog', 'inbox', 'pref', 'secret']);
  });

  it("gives accessors the family's parameters, then the local key's", () => {
    const { txn, calls } = fakeTxn();
    const ctx = bound(M.createAppDBTxn(), txn);
    ctx.get.item('i1');
    ctx.get.count();
    ctx.get.profile('acme', 'u1');
    ctx.get.note('acme', 'u1', 'n1');
    ctx.get.secret('u1');
    expect(calls).toEqual([
      ['get', 'catalog!item:i1', 'Item'],
      ['get', 'catalog!count', 'catalog/count'],
      ['get', 'inbox:acme,u1!profile', 'Profile'],
      ['get', 'inbox:acme,u1!note:n1', 'inbox/note'],
      ['get', 'secret:u1!secret', 'PasswordHash'],
    ]);
  });

  it('writes keys through set and del, and deletes slices through deleteSlice', () => {
    const { txn, calls } = fakeTxn();
    const ctx = bound(M.createWriterEngineTxn(), txn);
    ctx.set.item('i1', { id: 'i1', title: 'T', added });
    ctx.set.count(1);
    ctx.set.note('acme', 'u1', 'n1', 'hi');
    ctx.del.note('acme', 'u1', 'n1');
    ctx.deleteSlice.catalog();
    ctx.deleteSlice.inbox('acme', 'u1');
    ctx.deleteSlice.inbox('acme', 'u2', { erase: true });
    expect(calls).toEqual([
      ['set', 'catalog!item:i1', 'Item', { id: 'i1', title: 'T', added }],
      ['set', 'catalog!count', 'catalog/count', 1],
      ['set', 'inbox:acme,u1!note:n1', 'inbox/note', 'hi'],
      ['del', 'inbox:acme,u1!note:n1'],
      ['deleteSlice', 'catalog', false],
      ['deleteSlice', 'inbox:acme,u1', false],
      ['deleteSlice', 'inbox:acme,u2', true],
    ]);
  });

  it('updates a value in place and sets it, answering what fn returns; an absent key throws', () => {
    const { txn, data } = fakeTxn();
    const ctx = bound(M.createWriterEngineTxn(), txn);
    ctx.set.profile('acme', 'u1', { name: 'ann' });
    expect(ctx.update.profile('acme', 'u1', (p: any) => (p.name = p.name.toUpperCase()))).toBe(
      'ANN',
    );
    expect(data.get('inbox:acme,u1!profile')).toEqual({ name: 'ANN' });
    expect(() => ctx.update.profile('acme', 'u2', (p: any) => p)).toThrow(
      'update of absent key inbox:acme,u2!profile',
    );
  });

  it('renames an accessor argument that a template parameter already names', () => {
    const { txn, calls } = fakeTxn();
    const ctx = bound(M.createAppDBTxn(), txn);
    ctx.set.pref('dark', 'theme', 'on');
    ctx.deleteSlice.pref('dark', { erase: true });
    expect(calls).toEqual([
      ['set', 'pref:dark!pref:theme', 'pref/pref', 'on'],
      ['deleteSlice', 'pref:dark', true],
    ]);
    expect(text).toContain('pref: (options: string, value: string, $value: string) =>');
    expect(text).toContain('pref: (options: string, $options?: DeleteSliceOptions) =>');
  });

  it('checks each parameter against its place in its template', () => {
    const { txn, calls } = fakeTxn();
    const ctx = bound(M.createAppDBTxn(), txn);

    // a terminal family parameter may hold . and ~, and a terminal key parameter anything
    ctx.get.note('acme', 'u.1~x', 'a!b,c:d');
    ctx.get.note('acme', 'u1', '');
    expect(calls).toEqual([
      ['get', 'inbox:acme,u.1~x!note:a!b,c:d', 'inbox/note'],
      ['get', 'inbox:acme,u1!note:', 'inbox/note'],
    ]);

    // any other parameter is a non-empty run of A-Z a-z 0-9 _ -, and a terminal family one may
    // not be empty or hold what a URL must encode
    expect(() => ctx.get.profile('ac.me', 'u1')).toThrow(
      'profile: org "ac.me" is not a non-empty run of A-Z a-z 0-9 _ -',
    );
    expect(() => ctx.get.profile('', 'u1')).toThrow('profile: org ""');
    expect(() => ctx.get.profile('acme', 'u!1')).toThrow('profile: user "u!1"');
    expect(() => ctx.get.profile('ac,me', 'u1')).toThrow('profile: org "ac,me"');
    expect(() => ctx.get.profile('acme', 'u,1')).toThrow('profile: user "u,1"');
    expect(() => ctx.get.profile('acme', '')).toThrow('profile: user ""');
    expect(() => ctx.get.secret('u*')).toThrow('secret: user "u*"');
    expect(() => ctx.set.profile('acme', 'u!1', { name: 'x' })).toThrow('profile: user "u!1"');

    // a slice's name is checked as its keys' are
    expect(() => ctx.deleteSlice.inbox('ac,me', 'u1')).toThrow('inbox: org "ac,me"');
    expect(() => ctx.deleteSlice.inbox('acme', 'u!1')).toThrow('inbox: user "u!1"');
    expect(calls).toHaveLength(2);
  });

  it('builds keys that a walk of their family visits in the order of their parameters', () => {
    // inbox notes as (org, user, note), in order, each value the one before it followed by '-'
    const tuples = [
      ['acme', 'gen', '2026-10'],
      ['acme', 'gen', '2026-10-06'],
      ['acme', 'gen-2', '2026-10'],
      ['acme-2', 'gen', '2026-10'],
    ];
    const { txn, calls } = fakeTxn();
    const ctx = bound(M.createAppDBTxn(), txn);
    for (const [org, user, note] of tuples) ctx.get.note(org, user, note);
    const keys = calls.map(([, key]) => key as string);
    expect(keys[0]).toBe('inbox:acme,gen!note:2026-10');

    // store them in reverse, then walk the family
    const store = new InMemStore(registry);
    store.write((w) => {
      for (const key of [...keys].reverse()) w.set(key, '.json', JS, key);
    });
    const pattern = {
      slice: { family: 'inbox', params: [null, null] },
      name: 'note',
      local: [null],
    };
    const walked = store.read((r) => scanAll(r, { pattern, limit: 100, values: false }));
    expect(walked.map(([key]) => key)).toEqual(keys);
  });
});

describe('scan accessors', () => {
  /** a store holding these inbox notes, each the text of its own key */
  function notes(...keys: string[]): InMemStore {
    const store = new InMemStore(registry);
    store.write((w) => {
      for (const key of keys) w.set(key, 'inbox/note', JS, key);
    });
    return store;
  }

  /** a ReadTxn over a store transaction, as the Engine hands a query one */
  const readOf = (txn: RTxn): ReadTxn => ({
    get: (key, type) => txn.get(key, type, JS),
    scan: (req) =>
      txn.scan({ ...req, values: req.type === false ? false : { type: req.type, rep: JS } }),
  });

  const keys = [
    'inbox:acme,gen!note:2026-10',
    'inbox:acme,gen!note:2026-10-06',
    'inbox:acme,gen-2!note:a',
    'inbox:acme-2,gen!note:b',
    'inbox:acme,gen!profile',
  ];

  it('generates a scan accessor for each template with a parameter', () => {
    const { txn } = fakeTxn();
    expect(Object.keys(bound(M.createWriterEngineTxn(), txn).scan).sort()).toEqual([
      'item',
      'note',
      'profile',
    ]);
    expect(Object.keys(bound(M.createAppDBTxn(), txn).scan).sort()).toEqual([
      'item',
      'note',
      'pref',
      'profile',
      'secret',
    ]);
    compiles('contexts');
  });

  it('walks a match by parameter name, yielding every parameter by name with the value', () => {
    const store = notes(...keys);
    const got = store.read((r) => {
      const ctx = bound(M.createWriterEngineQueryTxn(), readOf(r));
      return {
        org: [...ctx.scan.note({ org: 'acme', note: { gte: '2026-10' } })],
        reversed: [...ctx.scan.note({ user: { prefix: 'gen' } }, { reverse: true })],
        keys: [...ctx.scan.note({ org: 'acme-2' }, { keys: true })],
      };
    });
    expect(got.org).toEqual([
      [{ org: 'acme', user: 'gen', note: '2026-10' }, 'inbox:acme,gen!note:2026-10'],
      [{ org: 'acme', user: 'gen', note: '2026-10-06' }, 'inbox:acme,gen!note:2026-10-06'],
      [{ org: 'acme', user: 'gen-2', note: 'a' }, 'inbox:acme,gen-2!note:a'],
    ]);
    expect(got.reversed.map(([p]: [{ note: string }]) => p.note)).toEqual([
      'b',
      'a',
      '2026-10-06',
      '2026-10',
    ]);
    expect(got.keys).toEqual([{ org: 'acme-2', user: 'gen', note: 'b' }]);
  });

  it('checks an exact value as get checks the parameter, and every value for lone surrogates', () => {
    const store = notes(...keys);
    store.read((r) => {
      const ctx = bound(M.createWriterEngineQueryTxn(), readOf(r));
      expect(() => [...ctx.scan.note({ org: 'ac,me' })]).toThrow(
        'note: org "ac,me" is not a non-empty run of A-Z a-z 0-9 _ -',
      );
      expect(() => [...ctx.scan.note({ user: 'u!1' })]).toThrow('note: user "u!1"');

      // a range or a prefix need not be a whole value, and a key's last parameter may hold anything
      expect([...ctx.scan.note({ org: { gte: 'acme,' }, note: 'a!b' })]).toEqual([]);
      // a surrogate pair is well-formed, and a surrogate alone or out of order is not
      const [hi, lo] = [String.fromCharCode(0xd83d), String.fromCharCode(0xde00)];
      expect([...ctx.scan.note({ note: { prefix: `a${hi}${lo}` } })]).toEqual([]);
      for (const bad of [lo, `a${lo}`, `${lo}${hi}`, `${hi}${hi}${lo}`, `${hi}${lo}${lo}`]) {
        expect(() => [...ctx.scan.note({ note: { gte: bad } })]).toThrow('holds a lone surrogate');
      }
      const lone = String.fromCharCode(0xd800);
      expect(() => [...ctx.scan.note({ note: { gte: lone } })]).toThrow(
        'note: note "\\ud800" holds a lone surrogate',
      );
    });
  });
});

/** deciders that authorize anyone and carry each mutation out */
function openDeciders() {
  const open =
    (carry: (txn: any, m: any) => void) =>
    (auth: any, txn: any, m: any): void => {
      auth.authorizeAnyone();
      carry(txn, m);
    };
  return {
    addItem: open((txn, m) => txn.set.item(m.id, { id: m.id, title: m.title, added: m.added })),
    removeItem: open((txn, m) => txn.del.item(m.id)),
    setProfile: open((txn, m) => txn.set.profile(m.org, m.user, { name: m.name })),
    note: open((txn, m) => txn.set.note(m.org, m.user, m.note, m.text)),
    signUp: open((txn, m) => txn.set.secret(m.user, m.password)),
    leave: open((txn, m) => txn.deleteSlice.inbox(m.org, 'u1')),
    forget: open((txn, m) => txn.deleteSlice.inbox(m.org, m.user, { erase: true })),
    sweep: open((txn, m) => txn.del.item(m.id)),
  };
}

/** the slots of a database over open deciders, with some replaced */
function slotsWith(deciders: Record<string, unknown> = {}, plugins?: Record<string, unknown>) {
  return {
    deciders: { ...openDeciders(), ...deciders },
    grant: (_txn: any, principal: any) => [`inbox:acme,${principal.user}!`, 'catalog'],
    lookup: (_txn: any, ident: any) =>
      ident.kind === 'password' ? { user: ident.identity } : null,
    ...(plugins === undefined ? {} : { plugins }),
  };
}

/** a database bundle over open deciders, with some replaced */
function bundle(deciders: Record<string, unknown> = {}) {
  return M.defineAppDB(slotsWith(deciders));
}

const anyone = { user: null };

describe('deciders', () => {
  it('generates a decider table with one decider per mutation', () => {
    expect(text).toContain('export type AppDBDeciders<P = {}> = {');
    compiles('deciders');
  });

  it('dispatches each mutation to the decider keyed by its camelCased model name', () => {
    const seen: string[] = [];
    const b = bundle({
      setProfile: (auth: any, _txn: any, m: any) => {
        auth.authorizeAnyone();
        seen.push(`setProfile ${m.name}`);
      },
      sweep: (auth: any, _txn: any, m: any) => {
        auth.authorizeAnyone();
        seen.push(`sweep ${m.id}`);
      },
    });
    b.bindWrite(fakeTxn().txn);
    b.decide({ type: 'sweep', id: 'i9' }, anyone);
    b.decide({ type: 'set-profile', org: 'acme', user: 'u1', name: 'Ann' }, anyone);
    expect(seen).toEqual(['sweep i9', 'setProfile Ann']);
  });

  it('runs a decider as (auth, txn, mutation), and answers null when it carried it out', () => {
    const { txn, calls } = fakeTxn(new Map([['catalog!item:i1', { id: 'i1' }]]));
    const got: unknown[] = [];
    const b = bundle({
      removeItem: (auth: any, ctx: any, m: any) => {
        auth.authorize(auth.user === 'u1');
        got.push(auth.user, ctx.get.item(m.id), m);
        ctx.del.item(m.id);
      },
    });
    const data = { type: 'remove-item', id: 'i1' };
    b.bindWrite(txn);
    expect(b.decide(data, { user: 'u1' })).toBeNull();
    expect(got).toEqual(['u1', { id: 'i1' }, data]);
    expect(calls).toEqual([
      ['get', 'catalog!item:i1', 'Item'],
      ['del', 'catalog!item:i1'],
    ]);
  });

  it("lets a decider hand its own transaction to the engine's predictor", () => {
    compiles('deciders');
    const predictor = M.writerEnginePredictor({
      addItem: (txn: any, m: any, pending?: true) =>
        txn.set.item(m.id, { id: m.id, title: pending ? 'pending' : m.title, added: m.added }),
    });
    const b = bundle({
      addItem: (auth: any, txn: any, m: any) => {
        auth.authorizeAnyone();
        predictor(txn, m);
      },
    });
    const { txn, calls } = fakeTxn();
    b.bindWrite(txn);
    b.decide({ type: 'add-item', id: 'i1', title: 'T', added }, anyone);
    expect(calls).toEqual([['set', 'catalog!item:i1', 'Item', { id: 'i1', title: 'T', added }]]);
  });

  it('deletes slices through the transaction, erasing their history or not', () => {
    const b = bundle();
    const { txn, calls } = fakeTxn();
    b.bindWrite(txn);
    b.decide({ type: 'forget', org: 'acme', user: 'u1' }, anyone);
    b.decide({ type: 'leave', org: 'acme', check: { kind: 'password' } }, anyone);
    expect(calls).toEqual([
      ['deleteSlice', 'inbox:acme,u1', true],
      ['deleteSlice', 'inbox:acme,u1', false],
    ]);
  });

  it('makes a missing decider and a misspelled extra decider compile errors', () => {
    compiles('deciderErrors');
  });

  it('rejects a decider that returns without an authorization decision (fail closed)', () => {
    const { txn } = fakeTxn();
    const sweep = { type: 'sweep', id: 'i1' };
    const over = (b: Bundle) => (b.bindWrite(txn), b);

    // in dev mode, a loud error naming the decider
    const silent = bundle({ sweep: () => {} });
    expect(() => over(silent).decide(sweep, anyone)).toThrow(/sweep/);

    // a failed authorization and a Reject are rejections, answered with their reasons
    const denied = bundle({
      sweep: (auth: any) => auth.authorize(auth.user !== null, 'signed-in users only'),
    });
    expect(over(denied).decide(sweep, anyone)).toBe('signed-in users only');
    const rejected = bundle({
      sweep: (auth: any) => {
        auth.authorizeAnyone();
        throw new M.Reject('no such item');
      },
    });
    expect(over(rejected).decide(sweep, anyone)).toBe('no such item');

    // any other throw is a bug, and goes to the host
    const buggy = bundle({
      sweep: () => {
        throw new Error('oops');
      },
    });
    expect(() => over(buggy).decide(sweep, anyone)).toThrow('oops');
  });
});

describe('predictors', () => {
  it('generates a predictor table per engine, with no entry for an @online mutation', () => {
    expect(text).toContain('export type WriterEnginePredictors = {');
    expect(text).not.toMatch(/leave\?: Predictor/);
    compiles('predictors');
  });

  it('dispatches each mutation to its predictor, passing pending on, and skips the rest', () => {
    const seen: unknown[] = [];
    const predictor = M.writerEnginePredictor({
      note: (_txn: any, m: any, pending?: true) => seen.push(['note', m.note, pending]),
    });
    const { txn } = fakeTxn();
    predictor(txn, { type: 'note', org: 'acme', user: 'u1', note: 'n1', text: '' }, true);
    predictor(txn, { type: 'remove-item', id: 'i1' }, true);
    predictor(txn, { type: 'leave', org: 'acme', check: { kind: 'password' } }, true);
    predictor(txn, { type: 'note', org: 'acme', user: 'u1', note: 'n2', text: '' });
    expect(seen).toEqual([
      ['note', 'n1', true],
      ['note', 'n2', undefined],
    ]);
  });
});

describe('grant, lookup, and bootstrap', () => {
  it('runs grant and lookup over one read context, whose writes throw', () => {
    compiles('database');
    const seen: unknown[] = [];
    const b = M.defineAppDB({
      ...slotsWith(),
      grant: (txn: any, principal: any) => {
        seen.push(txn.get.secret(principal.user));
        txn.set.count(1);
        return [];
      },
      lookup: (txn: any) => {
        txn.deleteSlice.catalog();
        return null;
      },
    });
    const { txn, calls } = fakeTxn(new Map([['secret:u1!secret', 'h']]));
    b.bindRead(txn);
    expect(() => b.grant({ user: 'u1' })).toThrow('this call reads only, and made a write');
    expect(() => b.lookup({ kind: 'token', user: 'u1' })).toThrow(
      'this call reads only, and made a write',
    );
    expect(seen).toEqual(['h']);
    expect(calls).toEqual([['get', 'secret:u1!secret', 'PasswordHash']]);
  });

  it('answers what grant and lookup answer', () => {
    const b = bundle();
    b.bindRead(fakeTxn().txn);
    expect(b.grant({ user: 'u1' })).toEqual(['inbox:acme,u1!', 'catalog']);
    expect(b.lookup({ kind: 'password', identity: 'ann' })).toEqual({ user: 'ann' });
  });

  it('runs bootstrap over the database context, writing through its transaction', () => {
    const b = M.defineAppDB({
      ...slotsWith(),
      bootstrap: (txn: any, ctx: any) => txn.set.secret('root', ctx.hashPassword('pw')),
    });
    const { txn, calls } = fakeTxn();
    b.bindWrite(txn);
    b.bootstrap!({ hashPassword: (p: string) => `#${p}`, env: () => '' });
    expect(calls).toEqual([['set', 'secret:root!secret', 'PasswordHash', '#pw']]);
    expect(bundle().bootstrap).toBeUndefined();
  });
});

describe('intake types', () => {
  it('types a mutation on the client with wire types (NewPassword as string)', () => {
    expect(text).toContain('export type NewPassword = string;');
    compiles('intake');
  });

  it('types the same mutation for its decider with results (a PasswordHash)', () => {
    expect(text).toContain('export type SignUpForDecider = {');
    expect(text).toContain('signUp: Decider<AppDBTxn<P>, SignUpForDecider>;');
    compiles('intake');
  });

  it('types the results as plain aliases of their shapes', () => {
    expect(text).toContain('export type PasswordHash = string;');
    compiles('intake');
  });

  it('needs no checker: the registry describes a prepared field by its wire type', () => {
    const s = M.appDBSchema;
    const leaf = (s: any, kind: string) =>
      s.nodes.findIndex((n: any[]) => n.length === 1 && n[0] === kind);
    const signUp = s.nodes[s.ids.SignUp];
    const password = signUp[2].find(([k]: [string]) => k === 'password');
    expect(s.nodes[password[1]]).toEqual(['intake', 'NewPassword', leaf(s, 'str')]);
  });
});

describe('sending mutations', () => {
  it('accepts @online mutations only through sendOnlineMutation and the rest only through sendMutation', () => {
    compiles('sending');
  });

  it("posts any of the database's mutations outside any Engine, each in a series of its own", async () => {
    compiles('posting');

    // the registry is built once for the transport, from the database's registry data, and each
    // mutation goes alone under a fresh id, numbered 1 in a fresh series
    const schemas: unknown[] = [];
    const posts: [Mutation<Uint8Array>[], unknown][] = [];
    const transport = {
      buildRegistry: (schema: Schema) => (schemas.push(schema), registry),
      connect: () => {
        throw new Error('a post never connects');
      },
      post: (mutations: Mutation<Uint8Array>[], session?: Session | null) => {
        posts.push([mutations, session]);
        return Promise.resolve([{ kind: 'ok' as const, position: 3 }]);
      },
    };
    const session = { token: 't', user: 'ann', exp: 0, ended: false };
    expect(await M.postAppMutation(transport, { type: 'sweep', id: 'i1' }, { session })).toEqual({
      kind: 'ok',
      position: 3,
    });
    await M.postAppMutation(transport, { type: 'add-item', id: 'i2', title: 'T', added });
    expect(schemas).toEqual([M.appDBSchema]);
    const [[[first], signedIn], [[second], anonymous]] = posts;
    expect(signedIn).toBe(session);
    expect(anonymous).toBeNull();
    for (const m of [first, second]) {
      expect(m.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
      expect(m.series).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(m.n).toBe(1);
    }
    expect(first.series).not.toBe(second.series);
    expect(JSON.parse(new TextDecoder().decode(first.data))).toEqual({ type: 'sweep', id: 'i1' });
  });
});

describe('plugins', () => {
  /** An install whose plugin's one request records its argument, recording each create, with the
      context it was given, and each bind.  With mutations, its plugin has a config, and runs a
      mutation by recording it and deleting the item it names. */
  function recorder(kind = 'recorder', mutations = false) {
    const created: string[] = [];
    const contexts: any[] = [];
    const sent: string[] = [];
    const bound: unknown[] = [];
    const ran: string[] = [];
    const install = {
      kind,
      create: (name: string, ctx: any) => {
        created.push(name);
        contexts.push(ctx);
        const run = (m: any) => {
          ran.push(`${name} ${m.id}`);
          ctx.del.item(m.id);
        };
        return {
          name,
          api: { send: (id: string) => sent.push(`${name} ${id}`) },
          bind: (txn: unknown) => bound.push(txn),
          ...(mutations ? { run, config: { entries: [name] } } : {}),
        };
      },
      db: (db: unknown) => db,
    };
    return { install, created, contexts, sent, bound, ran };
  }

  it('types the plugin set shared by the deciders and the database, and each install against it', () => {
    compiles('plugins');
  });

  it('creates every plugin under its name when the database is defined', () => {
    const { install, created } = recorder();
    const b = M.defineAppDB(slotsWith({}, { supportMail: install, alertsMail: install }));
    expect(created).toEqual(['supportMail', 'alertsMail']);
    expect(Object.keys(b.plugins)).toEqual(['supportMail', 'alertsMail']);
    expect(b.plugins.alertsMail).toEqual({ kind: 'recorder' });
  });

  it("creates every plugin over the database's context, the txn the deciders get", () => {
    const { install, contexts } = recorder();
    let seen: unknown;
    const b = M.defineAppDB(
      slotsWith(
        {
          sweep: (auth: any, txn: any) => {
            auth.authorizeAnyone();
            seen = txn;
          },
        },
        { supportMail: install, alertsMail: install },
      ),
    );
    b.bindWrite(fakeTxn().txn);
    b.decide({ type: 'sweep', id: 'i9' }, anyone);
    expect(contexts).toHaveLength(2);
    for (const ctx of contexts) expect(ctx).toBe(seen);
  });

  it("runs a plugin's own mutation over the transaction bindWrite bound every plugin to", () => {
    const { install: mail, bound: mailBound } = recorder();
    const { install: cron, ran, bound: cronBound } = recorder('cron', true);
    const b = M.defineAppDB(slotsWith({}, { mail, cron }));
    expect(b.plugins.mail).toEqual({ kind: 'recorder' });
    expect(b.plugins.cron.config).toEqual({ entries: ['cron'] });
    const { txn, calls } = fakeTxn();
    b.bindWrite(txn);
    b.plugins.cron.run!({ id: 'tick1' });
    expect(ran).toEqual(['cron tick1']);
    expect(calls).toEqual([['del', 'catalog!item:tick1']]);
    expect(mailBound).toEqual([txn]);
    expect(cronBound).toEqual([txn]);
  });

  it("attaches each plugin's request API to the txn under its name", () => {
    const { install, sent, bound } = recorder();
    const b = M.defineAppDB(
      slotsWith(
        {
          sweep: (auth: any, txn: any, m: any) => {
            auth.authorizeAnyone();
            txn.alertsMail.send(m.id);
          },
        },
        { supportMail: install, alertsMail: install },
      ),
    );
    const { txn } = fakeTxn();
    b.bindWrite(txn);
    expect(b.decide({ type: 'sweep', id: 'i9' }, anyone)).toBeNull();
    expect(sent).toEqual(['alertsMail i9']);
    expect(bound).toEqual([txn, txn]);
  });

  it('binds every plugin through bindWrite alone, never to the read context', () => {
    const { install, bound, contexts } = recorder();
    const b = M.defineAppDB({
      ...slotsWith({}, { mail: install }),
      grant: (txn: any) => (txn === contexts[0] ? ['shared'] : []),
    });
    const read = fakeTxn();
    const write = fakeTxn();
    b.bindRead(read.txn);
    expect(bound).toEqual([]);
    b.bindWrite(write.txn);
    expect(bound).toEqual([write.txn]);
    expect(b.grant(anyone)).toEqual([]);
  });

  it('refuses a plugin named after a context field, or __proto__', () => {
    for (const name of [
      'get',
      'scan',
      'set',
      'del',
      'update',
      'deleteSlice',
      'status',
      '__proto__',
    ]) {
      const { install } = recorder();
      expect(() => M.defineAppDB(slotsWith({}, { [name]: install }))).toThrow(
        `a plugin may not be named ${name}`,
      );
    }
  });

  it('refuses a plugin name that is not a JS identifier without $', () => {
    for (const name of ['my$mail', 'my-mail', '1mail', '']) {
      const { install } = recorder();
      expect(() => M.defineAppDB(slotsWith({}, { [name]: install }))).toThrow(
        `plugin name ${JSON.stringify(name)} is not a JS identifier without $`,
      );
    }
  });

  it('answers no plugins for a database that installs none', () => {
    expect(bundle().plugins).toEqual({});
  });
});

describe('slices, schema, and bundle', () => {
  it('puts the schema, the slots, the plugins, and DEV in the bundle', () => {
    const b = bundle();
    expect(Object.keys(b).sort()).toEqual([
      'bindRead',
      'bindWrite',
      'bootstrap',
      'decide',
      'dev',
      'grant',
      'lookup',
      'mapStack',
      'plugins',
      'schema',
    ]);
    expect(b.schema).toBe(M.appDBSchema);
    expect(b.dev).toBe(true);
    expect((globalThis as any).__bundle).toBe(b);
  });

  it('names the mutations union in each schema', () => {
    expect(M.writerEngineSchema.mutations).toBe('WriterMutations');
    expect(M.appDBSchema.mutations).toBe('AppDBMutation');
  });

  it('generates the engine subclass over its slice types and predictors', async () => {
    compiles('engines');
    compiles('predictors');

    // an engine over the catalog, whose predictor adds the item at once
    const errors: unknown[] = [];
    const server = new FakeServer();
    const abort = new AbortController();
    const engine = new M.WriterEngine(server.transport, {
      session: null,
      predictors: {
        addItem: (txn: any, m: any) => txn.set.item(m.id, { id: m.id, title: m.title }),
      },
      signal: abort.signal,
      onError: (e: unknown) => errors.push(e),
    });
    expect(server.conn.wants).toEqual(['catalog', 'inbox:*']);

    // live, and the prediction shows through a query on the engine's context
    const rig = { server, engine, data: {}, abort };
    await bootstrap(rig as any, ['catalog'], { catalog: { position: 10, seqs: {}, values: [] } });
    const q = engine.newQuery((txn: any) => txn.get.item('i1'));
    engine.sendMutation({ type: 'add-item', id: 'i1', title: 'T', added });
    await settle();
    expect(q.latest).toEqual({ id: 'i1', title: 'T' });
    expect(errors).toEqual([]);
    abort.abort();
    await settle();
  });
});
