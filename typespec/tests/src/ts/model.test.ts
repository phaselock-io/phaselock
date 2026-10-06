/**
 * What the TypeScript emitter generates from the slice vocabulary.  One model below exercises
 * every shape: a singleton slice, a slice with two parameters, a database-only slice, an engine
 * with one command and one with several, @online commands carrying intake types, and every kind
 * of @command output.  Runtime tests import the generated module; type tests compile snippets of
 * user code against it, asserting their errors with `// @ts-expect-error`.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  InMemStore,
  JS,
  type ReadTxn,
  type ReducerTxn,
  type RTxn,
  scanAll,
  type ScanRequest,
  type WTxn,
} from '../../../ts/assets/skeleton.ts';
import { bootstrap, FakeServer, registry, settle } from '../engine/harness.ts';

import { emit, outDir, typecheck } from './emit-harness.ts';

const SOURCE = `
  alias Id = string;

  // the catalog: a singleton slice
  interface CatalogSlice extends Slice<"catalog", CatalogEvents, {
    "item:{item}": Item;
    "count": int32;
  }> {}

  model Item { id: Id; title: string; added: utcDateTime; }

  union CatalogEvents { ItemAdded, ItemRemoved, Noted }

  model ItemAdded { type: "item-added"; id: Id; title: string; added: utcDateTime; }
  model ItemRemoved { type: "item-removed"; id: Id; }

  // an inbox per org and user: a slice with two parameters
  interface InboxSlice extends Slice<"inbox:{org},{user}", InboxEvents, {
    "profile": Profile;
    "note:{note}": string;
  }> {}

  model Profile { name: string; }

  union InboxEvents { ProfileSet, Noted }

  model ProfileSet { type: "profile-set"; name: string; }

  // folded by the catalog and by every inbox, and a passthrough command
  @command(Noted)
  model Noted { type: "noted"; note: Id; text: string; }

  // secrets: a database-only slice with a single event
  interface SecretSlice extends Slice<"secret:{user}", SecretSet, { "secret": PasswordHash }> {}

  model SecretSet { type: "secret-set"; password: PasswordHash; }

  @command(ItemAdded)
  model AddItem { type: "add-item"; id: Id; title: string; added: utcDateTime; }

  @command(ItemRemoved | Noted)
  model RemoveItem { type: "remove-item"; id: Id; }

  @command([ProfileSet, Noted])
  model SetProfile { type: "set-profile"; org: Id; user: Id; name: string; }

  @command(Noted[])
  model NoteMany { type: "note-many"; notes: Id[]; }

  @online
  @command([SecretSet, ProfileSet])
  model SignUp { type: "sign-up"; org: Id; user: Id; name: string; password: NewPassword; }

  @online
  @command([Death, ItemRemoved[]])
  model Leave { type: "leave"; check: CommandAuth; }

  @command(ItemRemoved)
  model Sweep { type: "sweep"; id: Id; }

  interface ReaderEngine extends Engine<[CatalogSlice], AddItem> {}

  union WriterCommands { AddItem, RemoveItem, SetProfile, NoteMany, Noted, Leave }

  interface WriterEngine extends Engine<[CatalogSlice, InboxSlice], WriterCommands> {}

  union DbCommands { Sweep, SignUp }

  interface AppDB extends Database<[ReaderEngine, WriterEngine], [SecretSlice], DbCommands> {}
`;

/* Snippets of user code, each type-checked as its own file against the generated module.  A
   snippet passes when it compiles with no diagnostics, so each error it expects is marked with
   `// @ts-expect-error` on the line before, and an expected error that does not happen fails. */
const SNIPPETS: Record<string, string> = {
  reducers: `
    import type { CatalogSliceReducers, InboxSliceReducers } from './model.gen.ts';

    export const catalog: CatalogSliceReducers = {
      itemAdded: (txn, e) => txn.set.item(e.id, { id: e.id, title: e.title, added: e.added }),
      itemRemoved: (txn, e) => txn.del.item(e.id),
      noted: (txn, _e, pending) => {
        const n: number = txn.get.count() ?? 0;
        if (!pending) txn.set.count(n + 1);
      },
    };

    // @ts-expect-error every event of the slice needs its handler
    export const missing: CatalogSliceReducers = {
      itemAdded: () => {},
      itemRemoved: () => {},
    };

    export const extra: CatalogSliceReducers = {
      itemAdded: () => {},
      itemRemoved: () => {},
      noted: () => {},
      // @ts-expect-error a misspelled handler
      itemAded: () => {},
    };

    export const inbox: InboxSliceReducers = {
      profileSet: (txn, e) => {
        const org: string = txn.params.org;
        const user: string = txn.params.user;
        // @ts-expect-error a parameter the family does not have
        void txn.params.patron;
        txn.set.profile({ name: e.name + ' of ' + org + '/' + user });
        txn.update.profile((p) => {
          p.name = p.name.trim();
        });
      },
      noted: (txn, e) => {
        txn.set.note(e.note, e.text);
        // @ts-expect-error the stream binds the family's parameters
        txn.get.note('acme', 'u1', e.note);
        txn.del.note(e.note);

        // a reducer scans its own stream by the template's own parameters
        for (const [{ note }, text] of txn.scan.note({ note: { prefix: 'n' } })) {
          txn.set.note(note, text.trim());
        }
        // @ts-expect-error the stream binds the family's parameters
        txn.scan.note({ org: 'acme' });
        // @ts-expect-error a template with no parameter of its own names one key of the stream
        void txn.scan.profile;
      },
    };
  `,

  contexts: `
    import type {
      AppDBTxn,
      Item,
      PasswordHash,
      Profile,
      ReaderEngineTxn,
      WriterEngineTxn,
    } from './model.gen.ts';

    declare const reader: ReaderEngineTxn;
    declare const writer: WriterEngineTxn;
    declare const db: AppDBTxn;
    declare function export_(s: string): void;

    export const item: Item | undefined = reader.get.item('i1');
    export const count: number | undefined = reader.get.count();
    // @ts-expect-error the reader engine syncs no inbox
    reader.get.profile('acme', 'u1');
    export const profile: Profile | undefined = writer.get.profile('acme', 'u1');
    export const note: string | undefined = writer.get.note('acme', 'u1', 'n1');
    export const secret: PasswordHash | undefined = db.get.secret('u1');
    // @ts-expect-error a global context is read-only
    void db.set;

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

    // the database's context passes wherever one of its engines' contexts is wanted
    export const asWriter: WriterEngineTxn = db;
    export const asReader: ReaderEngineTxn = db;
  `,

  precommit: `
    import {
      type AppDBPrecommit,
      type Auth,
      type AppDBTxn,
      type NotedOutput,
      type PasswordHash,
      Reject,
      type Sweep,
      type SweepOutput,
      type WriterEngineForecasters,
    } from './model.gen.ts';

    // a forecaster shared with precommit, which authorizes and then calls it
    const forecasters = {
      addItem: (_txn, cmd) => ({
        stream: 'catalog',
        event: { type: 'item-added', id: cmd.id, title: cmd.title, added: cmd.added },
      }),
    } satisfies WriterEngineForecasters;

    // a helper typed by the generated names
    function sweep(auth: Auth, txn: AppDBTxn, cmd: Sweep): SweepOutput {
      auth.authorize(auth.traits.includes('admin'), 'admins only');
      if (txn.get.item(cmd.id) === undefined) throw new Reject('no such item');
      return { stream: 'catalog', event: { type: 'item-removed', id: cmd.id } };
    }

    export const precommit: AppDBPrecommit = {
      addItem: (auth, txn, cmd) => {
        auth.authorize(auth.user !== null);
        return forecasters.addItem(txn, cmd);
      },
      removeItem: (auth, txn, cmd) => {
        auth.authorizeAnyone();
        if (txn.get.item(cmd.id) === undefined) {
          return { stream: 'catalog', event: { type: 'noted', note: cmd.id, text: 'gone' } };
        }
        return { stream: 'catalog', event: { type: 'item-removed', id: cmd.id } };
      },
      setProfile: (auth, _txn, cmd) => {
        auth.authorize(auth.user === cmd.user);
        const stream = 'inbox:' + cmd.org + ',' + cmd.user;
        return [
          { stream, event: { type: 'profile-set', name: cmd.name } },
          { stream, event: { type: 'noted', note: 'n1', text: 'profile set' } },
        ];
      },
      noteMany: (auth, _txn, cmd) => {
        auth.authorizeAnyone();
        return cmd.notes.map((note): NotedOutput => ({
          stream: 'catalog',
          event: { type: 'noted', note, text: '' },
        }));
      },
      noted: (auth, _txn, cmd) => {
        auth.authorizeAnyone();
        return { stream: 'catalog', event: cmd };
      },
      signUp: (auth, _txn, cmd) => {
        auth.authorizeAnyone();
        const hash: PasswordHash = cmd.password;
        return [
          { stream: 'secret:' + cmd.user, event: { type: 'secret-set', password: hash } },
          { stream: 'inbox:' + cmd.org + ',' + cmd.user, event: { type: 'profile-set', name: cmd.name } },
        ];
      },
      leave: (auth, txn, cmd) => {
        auth.authorize(cmd.check.kind === 'password');
        const gone = txn.get.item('i1') === undefined ? [] : [{ stream: 'catalog' as const, event: { type: 'item-removed' as const, id: 'i1' } }];
        return [{ stream: 'inbox:acme,' + auth.user, death: true }, gone];
      },
      sweep,
    };
  `,

  precommitErrors: `
    import type { AppDBPrecommit } from './model.gen.ts';

    declare const ok: AppDBPrecommit;
    const { sweep: _sweep, ...rest } = ok;

    // @ts-expect-error every command needs its handler
    export const missing: AppDBPrecommit = rest;

    export const extra: AppDBPrecommit = {
      ...ok,
      // @ts-expect-error a misspelled handler
      sweeep: ok.sweep,
    };

    export const wrong: Partial<AppDBPrecommit> = {
      // @ts-expect-error a singleton slice's stream label is its family name
      addItem: (_auth, _txn, cmd) => ({ stream: 'catalog:x', event: { ...cmd, type: 'item-added' } }),
      // @ts-expect-error an event the output does not name
      removeItem: (_auth, _txn, cmd) => ({ stream: 'catalog', event: { type: 'item-added', id: cmd.id, title: '', added: new Date() } }),
      // @ts-expect-error a tuple output returns every item
      setProfile: (_auth, _txn, cmd) => [{ stream: 'inbox:' + cmd.org, event: { type: 'profile-set', name: cmd.name } }],
      // @ts-expect-error a death is { stream, death: true }
      leave: () => [{ stream: 'inbox:a,b', death: false }, []],
    };
  `,

  forecasters: `
    import type { ReaderEngineForecasters, WriterEngineForecasters } from './model.gen.ts';

    export const reader: ReaderEngineForecasters = {
      addItem: (txn, cmd) => {
        if (txn.get.item(cmd.id) !== undefined) throw new Error('already added');
        return { stream: 'catalog', event: { ...cmd, type: 'item-added' } };
      },
    };

    // a table may leave commands out, which forecast nothing
    export const writer: WriterEngineForecasters = {
      noted: (txn, cmd) => {
        void txn.get.profile('acme', 'u1');
        return { stream: 'catalog', event: cmd };
      },
      // @ts-expect-error an @online command is never forecast
      leave: () => [],
    };
  `,

  intake: `
    import type {
      CommandAuthResult,
      Leave,
      LeaveForPrecommit,
      PasswordHash,
      SignUp,
      SignUpForPrecommit,
    } from './model.gen.ts';

    // the client sends the wire types
    export const signUp: SignUp = {
      type: 'sign-up',
      org: 'acme',
      user: 'u1',
      name: 'Ann',
      password: 'hunter2',
    };
    export const leave: Leave = { type: 'leave', check: { kind: 'password', password: 'hunter2' } };

    // precommit sees the command as the database prepared it
    declare const received: SignUpForPrecommit;
    export const hash: PasswordHash = received.password;
    declare const left: LeaveForPrecommit;
    export const result: CommandAuthResult = left.check;
    // @ts-expect-error the prepared command carries the result, not the client's proof
    void left.check.password;

    // the results are plain aliases of their shapes
    export const text: string = hash;
    export const plain: PasswordHash = 'hunter2';
    export const auth: CommandAuthResult = { kind: 'password' };
  `,

  sending: `
    import type {
      AddItem,
      CommandResult,
      Item,
      Leave,
      Query,
      ReaderEngine,
      WriterEngine,
    } from './model.gen.ts';

    declare const writer: WriterEngine;
    declare const reader: ReaderEngine;
    declare const add: AddItem;
    declare const leave: Leave;

    writer.sendCommand(add);
    // @ts-expect-error an @online command never enters the outbox
    writer.sendCommand(leave);
    export const outcome: Promise<CommandResult> = writer.sendOnlineCommand(leave);
    // @ts-expect-error a command that is not @online goes through the outbox
    void writer.sendOnlineCommand(add);
    // @ts-expect-error the reader engine sends no @online command
    void reader.sendOnlineCommand(leave);

    export const q: Query<Item | undefined> = writer.newQuery((txn) => txn.get.item('i1'));
  `,

  engines: `
    import {
      type CatalogSliceReducers,
      type ConnectorFactory,
      type InboxSliceReducers,
      type Registry,
      type SecretSliceReducers,
      WriterEngine,
    } from './model.gen.ts';

    declare const catalog: CatalogSliceReducers;
    declare const inbox: InboxSliceReducers;
    declare const secret: SecretSliceReducers;
    declare const reg: Registry;
    declare const connect: ConnectorFactory;

    export const engine = new WriterEngine(null, reg, connect, { reducers: { catalog, inbox } });
    // @ts-expect-error every slice of the engine needs its reducers
    new WriterEngine(null, reg, connect, { reducers: { catalog } });
    // @ts-expect-error a slice the engine does not sync
    new WriterEngine(null, reg, connect, { reducers: { catalog, inbox, secret } });
  `,

  database: `
    import { type AppDBBootstrapContext, type AppDBSlots, defineAppDB } from './model.gen.ts';

    declare const slots: AppDBSlots;
    defineAppDB(slots);

    // bootstrap is optional
    const { bootstrap: _bootstrap, ...rest } = slots;
    defineAppDB(rest);

    // @ts-expect-error the database's own slices need their reducers too
    defineAppDB({ ...slots, reducers: { catalog: slots.reducers.catalog, inbox: slots.reducers.inbox } });

    declare const ctx: AppDBBootstrapContext;
    ctx.emit('catalog', { type: 'item-added', id: 'i1', title: 'T', added: new Date() });
    ctx.emit('secret:u1', { type: 'secret-set', password: ctx.hashPassword(ctx.env('PASSWORD')) });
    // @ts-expect-error no slice folds such an event
    ctx.emit('catalog', { type: 'bogus' });
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

/** a ReducerTxn or ReadTxn over a map, recording each call */
function fakeTxn(data: Map<string, unknown> = new Map()) {
  const calls: unknown[][] = [];
  const txn = {
    get(key: string, type: string): unknown {
      calls.push(['get', key, type]);
      return data.get(key);
    },
    set(key: string, type: string, value: unknown): void {
      calls.push(['set', key, type, value]);
      data.set(key, value);
    },
    del(key: string): void {
      calls.push(['del', key]);
      data.delete(key);
    },
  };
  return { txn, calls, data };
}

const added = new Date('2024-01-02T03:04:05Z');
const itemAdded = { type: 'item-added', id: 'i1', title: 'T', added };
const itemRemoved = { type: 'item-removed', id: 'i1' };
const noted = { type: 'noted', note: 'n1', text: 'hi' };

/** a catalog handler table that records each call */
function catalogRecorder(seen: unknown[][]) {
  return {
    itemAdded: (txn: any, e: any, pending: boolean) => seen.push(['itemAdded', e, pending, txn]),
    itemRemoved: (txn: any, e: any, pending: boolean) => seen.push(['itemRemoved', e, pending]),
    noted: (txn: any, e: any, pending: boolean) => seen.push(['noted', e, pending]),
  };
}

describe('reducer contexts', () => {
  it('generates one reducer context per slice, over its local key templates', () => {
    const { txn, calls } = fakeTxn();
    const reducer = M.catalogSliceReducer({
      itemAdded: (t: any, e: any) => {
        t.set.item(e.id, { id: e.id, title: e.title, added: e.added });
        t.set.count(1);
      },
      itemRemoved: () => {},
      noted: () => {},
    });
    reducer.reducer(txn, [itemAdded], 'catalog', false);
    expect(calls).toEqual([
      ['set', 'item:i1', 'Item', { id: 'i1', title: 'T', added }],
      ['set', 'count', 'catalog/count', 1],
    ]);
  });

  it("gives reducer accessors only the local template's own parameters (get.patron())", () => {
    const { txn, calls } = fakeTxn();
    const reducer = M.inboxSliceReducer({
      profileSet: (t: any) => t.get.profile(),
      noted: (t: any, e: any) => t.get.note(e.note),
    });
    reducer.reducer(txn, [{ type: 'profile-set', name: 'Ann' }, noted], 'inbox:acme,u1', false);
    expect(calls).toEqual([
      ['get', 'profile', 'Profile'],
      ['get', 'note:n1', 'inbox/note'],
    ]);
    compiles('reducers');
  });

  it('generates get, set, del, and update accessors, get answering undefined when absent', () => {
    const { txn, data } = fakeTxn();
    const seen: unknown[] = [];
    const reducer = M.inboxSliceReducer({
      profileSet: (t: any, e: any) => {
        seen.push(t.get.profile());
        t.set.profile({ name: e.name });
        seen.push(t.update.profile((p: any) => (p.name = p.name.toUpperCase())));
        seen.push(t.get.profile());
      },
      noted: (t: any) => t.del.profile(),
    });
    reducer.reducer(txn, [{ type: 'profile-set', name: 'ann' }], 'inbox:acme,u1', false);
    expect(seen).toEqual([undefined, 'ANN', { name: 'ANN' }]);
    expect(data.get('profile')).toEqual({ name: 'ANN' });

    reducer.reducer(txn, [noted], 'inbox:acme,u1', false);
    expect(data.has('profile')).toBe(false);

    // an update of an absent key throws, as any reducer may when its state is not as expected
    expect(() =>
      M.inboxSliceReducer({
        profileSet: (t: any) => t.update.profile((p: any) => p),
        noted: () => {},
      }).reducer(txn, [{ type: 'profile-set', name: 'x' }], 'inbox:acme,u1', false),
    ).toThrow('profile');
  });

  it('gives each SliceReducer its family template and its key templates', () => {
    const reducer = M.inboxSliceReducer({ profileSet: () => {}, noted: () => {} });
    expect(reducer.template).toBe('inbox:{org},{user}');
    expect(reducer.keys).toEqual(['note:{note}', 'profile']);
  });

  it('generates a handler table per slice: one reducer handler per event type', () => {
    expect(text).toContain('export type CatalogSliceReducers = {');
    expect(text).toContain('export type InboxSliceReducers = {');
    expect(text).toContain('export type SecretSliceReducers = {');
    compiles('reducers');
  });

  it("dispatches a run of events on each event's discriminant in the generated wrapper", () => {
    const seen: unknown[][] = [];
    const reducer = M.catalogSliceReducer(catalogRecorder(seen));
    const { txn } = fakeTxn();
    reducer.reducer(txn, [noted, itemAdded, itemRemoved, noted], 'catalog', true);
    expect(seen.map(([name, e, pending]) => [name, e, pending])).toEqual([
      ['noted', noted, true],
      ['itemAdded', itemAdded, true],
      ['itemRemoved', itemRemoved, true],
      ['noted', noted, true],
    ]);

    // a slice whose events are a single model
    const secrets: unknown[] = [];
    M.secretSliceReducer({ secretSet: (_t: any, e: any) => secrets.push(e) }).reducer(
      txn,
      [{ type: 'secret-set', password: 'h' }],
      'secret:u1',
      false,
    );
    expect(secrets).toEqual([{ type: 'secret-set', password: 'h' }]);
  });

  it('parses the stream name into typed params and hands them to the handlers', () => {
    const params: unknown[] = [];
    const { txn } = fakeTxn();
    M.inboxSliceReducer({
      profileSet: (t: any) => params.push(t.params),
      noted: (t: any) => params.push(t.params),
    }).reducer(txn, [noted], 'inbox:acme,u.1', false);
    M.catalogSliceReducer({
      itemAdded: () => {},
      itemRemoved: () => {},
      noted: (t: any) => params.push(t.params),
    }).reducer(txn, [noted], 'catalog', false);

    // the final parameter may hold dots
    expect(params).toEqual([{ org: 'acme', user: 'u.1' }, {}]);
  });
});

describe('global contexts', () => {
  it('generates a read-only global context per engine, over its slices', () => {
    const { txn } = fakeTxn();
    expect(Object.keys(M.readerEngineTxn(txn).get).sort()).toEqual(['count', 'item']);
    expect(Object.keys(M.writerEngineTxn(txn).get).sort()).toEqual([
      'count',
      'item',
      'note',
      'profile',
    ]);
    expect(Object.keys(M.writerEngineTxn(txn)).sort()).toEqual(['get', 'scan']);
    compiles('contexts');
  });

  it('generates a read-only global context per database, over all of its slices', () => {
    const { txn } = fakeTxn();
    expect(Object.keys(M.appDBTxn(txn).get).sort()).toEqual([
      'count',
      'item',
      'note',
      'profile',
      'secret',
    ]);
  });

  it("gives global accessors the family's parameters, then the local key's", () => {
    const { txn, calls } = fakeTxn();
    const ctx = M.appDBTxn(txn);
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

  it('checks each parameter against its place in its template', () => {
    const { txn, calls } = fakeTxn();
    const ctx = M.appDBTxn(txn);

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
    const ctx = M.appDBTxn(txn);
    for (const [org, user, note] of tuples) ctx.get.note(org, user, note);
    const keys = calls.map(([, key]) => key as string);
    expect(keys[0]).toBe('inbox:acme,gen!note:2026-10');

    // store them in reverse, then walk the family
    const store = new InMemStore(registry);
    store.write((w) => {
      for (const key of [...keys].reverse()) w.set(key, '.json', JS, key);
    });
    const pattern = {
      stream: { family: 'inbox', params: [null, null] },
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

  /** a ReducerTxn over a store transaction for one stream's keys, as the Engine hands a reducer one */
  const reducerOf = (txn: WTxn, stream: string): ReducerTxn => {
    const at = `${stream}!`;
    return {
      get: (key, type) => txn.get(at + key, type, JS),
      set: (key, type, value) => txn.set(at + key, type, JS, value),
      del: (key) => txn.del(at + key),
      scan: (req) => {
        const values: ScanRequest['values'] =
          req.type === false ? false : { type: req.type, rep: JS };
        const after = req.after === undefined ? undefined : at + req.after;
        const pattern = { stream, name: req.name, local: req.local };
        const { entries, next } = txn.scan({ ...req, pattern, values, after });
        return {
          entries: entries.map(([k, v]) => [k.slice(at.length), v]),
          next: next === null ? null : next.slice(at.length),
        };
      },
    };
  };

  const keys = [
    'inbox:acme,gen!note:2026-10',
    'inbox:acme,gen!note:2026-10-06',
    'inbox:acme,gen-2!note:a',
    'inbox:acme-2,gen!note:b',
    'inbox:acme,gen!profile',
  ];

  it('generates a scan accessor for each template with a parameter that varies in its context', () => {
    const { txn } = fakeTxn();
    expect(Object.keys(M.writerEngineTxn(txn).scan).sort()).toEqual(['item', 'note', 'profile']);
    expect(Object.keys(M.appDBTxn(txn).scan).sort()).toEqual(['item', 'note', 'profile', 'secret']);
    compiles('contexts');
  });

  it('walks a match by parameter name, yielding every parameter by name with the value', () => {
    const store = notes(...keys);
    const got = store.read((r) => {
      const ctx = M.appDBTxn(readOf(r));
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

  it("walks a reducer's own stream by the template's own parameters", () => {
    const store = notes(...keys);
    const seen: unknown[] = [];
    const reducer = M.inboxSliceReducer({
      profileSet: () => {},
      noted: (t: any) => seen.push(...t.scan.note({ note: { lt: 'b' } })),
    });
    store.write((w) =>
      reducer.reducer(reducerOf(w, 'inbox:acme,gen'), [noted], 'inbox:acme,gen', false),
    );
    expect(seen).toEqual([
      [{ note: '2026-10' }, 'inbox:acme,gen!note:2026-10'],
      [{ note: '2026-10-06' }, 'inbox:acme,gen!note:2026-10-06'],
    ]);
  });

  it('checks an exact value as get checks the parameter, and every value for lone surrogates', () => {
    const store = notes(...keys);
    store.read((r) => {
      const ctx = M.appDBTxn(readOf(r));
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

/** precommit handlers that authorize anyone and pass each command's events through */
function passthrough() {
  const open =
    (out: (cmd: any) => unknown) =>
    (auth: any, _txn: any, cmd: any): unknown => {
      auth.authorizeAnyone();
      return out(cmd);
    };
  return {
    addItem: open((c) => ({ stream: 'catalog', event: { ...c, type: 'item-added' } })),
    removeItem: open((c) => ({ stream: 'catalog', event: { type: 'item-removed', id: c.id } })),
    setProfile: open((c) => [
      { stream: `inbox:${c.org},${c.user}`, event: { type: 'profile-set', name: c.name } },
      { stream: `inbox:${c.org},${c.user}`, event: { type: 'noted', note: 'p', text: c.name } },
    ]),
    noteMany: open((c) =>
      c.notes.map((note: string) => ({
        stream: 'catalog',
        event: { type: 'noted', note, text: '' },
      })),
    ),
    noted: open((c) => ({ stream: 'catalog', event: c })),
    signUp: open((c) => [
      { stream: `secret:${c.user}`, event: { type: 'secret-set', password: c.password } },
      { stream: `inbox:${c.org},${c.user}`, event: { type: 'profile-set', name: c.name } },
    ]),
    leave: open(() => [
      { stream: 'inbox:acme,u1', death: true },
      [
        { stream: 'catalog', event: itemRemoved },
        { stream: 'catalog', event: { type: 'item-removed', id: 'i2' } },
      ],
    ]),
    sweep: open((c) => ({ stream: 'catalog', event: { type: 'item-removed', id: c.id } })),
  };
}

/** a database bundle over passthrough handlers, with some replaced */
function bundle(precommit: Record<string, unknown> = {}) {
  const seen: unknown[][] = [];
  return M.defineAppDB({
    reducers: {
      catalog: catalogRecorder(seen),
      inbox: { profileSet: () => {}, noted: () => {} },
      secret: { secretSet: () => {} },
    },
    precommit: { ...passthrough(), ...precommit },
    maySee: (_txn: any, principal: any) => [`inbox:acme,${principal.user}!`, 'catalog!'],
    lookup: (_txn: any, ident: any) =>
      ident.kind === 'password' ? { user: ident.identity, traits: [] } : null,
  });
}

const anyone = { user: null, traits: [] };

describe('precommit', () => {
  it('generates a precommit interface with one handler per @command model', () => {
    expect(text).toContain('export type AppDBPrecommit = {');
    compiles('precommit');
  });

  it('keys the handlers by the camelCased model name', () => {
    const seen: string[] = [];
    const b = bundle({
      noteMany: (auth: any, _txn: any, cmd: any) => {
        auth.authorizeAnyone();
        seen.push(`noteMany ${cmd.notes.join(',')}`);
        return [];
      },
      sweep: (auth: any, _txn: any, cmd: any) => {
        auth.authorizeAnyone();
        seen.push(`sweep ${cmd.id}`);
        return { stream: 'catalog', event: itemRemoved };
      },
    });
    const { txn } = fakeTxn();
    b.precommit(txn, { id: 'c1', data: { type: 'sweep', id: 'i9' } }, anyone);
    b.precommit(txn, { id: 'c2', data: { type: 'note-many', notes: ['a', 'b'] } }, anyone);
    expect(seen).toEqual(['sweep i9', 'noteMany a,b']);
  });

  it('types each handler as (auth, txn, cmd), with cmd the command as precommit sees it', () => {
    const { txn, calls } = fakeTxn(new Map([['catalog!item:i1', { id: 'i1' }]]));
    const got: unknown[] = [];
    const b = bundle({
      removeItem: (auth: any, ctx: any, cmd: any) => {
        auth.authorize(auth.user === 'u1');
        got.push(auth.user, auth.traits, ctx.get.item(cmd.id), cmd);
        return { stream: 'catalog', event: itemRemoved };
      },
    });
    const data = { type: 'remove-item', id: 'i1' };
    b.precommit(txn, { id: 'c1', data }, { user: 'u1', traits: ['admin'] });
    expect(got).toEqual(['u1', ['admin'], { id: 'i1' }, data]);
    expect(calls).toEqual([['get', 'catalog!item:i1', 'Item']]);
  });

  it("types each handler's return from its @command output, each event stream-labelled", () => {
    expect(text).toContain('export type SetProfileOutput = [');
    compiles('precommitErrors');
  });

  it("types a singleton slice's stream label as its literal family name", () => {
    expect(text).toMatch(/export type AddItemOutput = \{ stream: "catalog"; event: ItemAdded \};/);
  });

  it("types an event folded by several slices with any of those slices' streams", () => {
    expect(text).toMatch(/export type NotedOutput = \{ stream: string; event: Noted \};/);
  });

  it('types a Death output as { stream, death: true }', () => {
    expect(text).toContain('{ stream: string; death: true }');
  });

  it('flattens tuple and array outputs into the list the wrapper returns', () => {
    const b = bundle();
    const { txn } = fakeTxn();
    const leave = { type: 'leave', check: { kind: 'password' } };
    expect(b.precommit(txn, { id: 'c1', data: leave }, anyone)).toEqual([
      { stream: 'inbox:acme,u1', death: true },
      { stream: 'catalog', event: itemRemoved },
      { stream: 'catalog', event: { type: 'item-removed', id: 'i2' } },
    ]);
    const note = { type: 'noted', note: 'n1', text: 'hi' };
    expect(b.precommit(txn, { id: 'c2', data: note }, anyone)).toEqual([
      { stream: 'catalog', event: note },
    ]);
  });

  it('makes a missing handler and a misspelled extra handler compile errors', () => {
    compiles('precommitErrors');
  });

  it('rejects a handler that returns without an authorization decision (fail closed)', () => {
    const { txn } = fakeTxn();
    const sweep = { id: 'c1', data: { type: 'sweep', id: 'i1' } };

    // in dev mode, a loud error naming the handler
    const silent = bundle({ sweep: () => ({ stream: 'catalog', event: itemRemoved }) });
    expect(() => silent.precommit(txn, sweep, anyone)).toThrow(/sweep/);

    // a failed authorization and a Reject are rejections, answered with their reasons
    const denied = bundle({
      sweep: (auth: any) => auth.authorize(auth.traits.includes('admin'), 'admins only'),
    });
    expect(denied.precommit(txn, sweep, anyone)).toBe('admins only');
    const rejected = bundle({
      sweep: (auth: any) => {
        auth.authorizeAnyone();
        throw new M.Reject('no such item');
      },
    });
    expect(rejected.precommit(txn, sweep, anyone)).toBe('no such item');

    // any other throw is a bug, and goes to the host
    const buggy = bundle({
      sweep: () => {
        throw new Error('oops');
      },
    });
    expect(() => buggy.precommit(txn, sweep, anyone)).toThrow('oops');
  });
});

describe('intake types', () => {
  it('types a command on the client with wire types (NewPassword as string)', () => {
    expect(text).toContain('export type NewPassword = string;');
    compiles('intake');
  });

  it('types the same command in precommit with results (a PasswordHash)', () => {
    expect(text).toContain('export type SignUpForPrecommit = {');
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

describe('sending commands', () => {
  it('accepts @online commands only through sendOnlineCommand and the rest only through sendCommand', () => {
    compiles('sending');
  });

  it.todo("gives the database's own commands a direct-send helper, for use before sign-in");
});

describe('schema and bundle', () => {
  it("generates storeTypes from every slice's key templates", () => {
    expect(M.writerEngineSchema.storeTypes).toEqual({
      'catalog/item': 'Item',
      'catalog/count': 'catalog/count',
      'inbox/profile': 'Profile',
      'inbox/note': 'inbox/note',
    });
    expect(M.appDBSchema.storeTypes['secret/secret']).toBe('PasswordHash');
  });

  it("generates eventTypes from each slice's family to its events union", () => {
    expect(M.appDBSchema.eventTypes).toEqual({
      catalog: 'CatalogEvents',
      inbox: 'InboxEvents',
      secret: 'SecretSet',
    });
  });

  it('generates the engine subclass taking its reducers and forecaster, deriving its wants', async () => {
    compiles('engines');
    compiles('forecasters');

    // an engine over the catalog, whose forecaster adds the item at once
    const errors: unknown[] = [];
    const server = new FakeServer();
    const reg = { ...registry, storeTypes: { 'catalog/item': 'Item', 'catalog/count': 'count' } };
    const abort = new AbortController();
    const engine = new M.WriterEngine(null, reg, server.factory, {
      reducers: {
        catalog: {
          itemAdded: (txn: any, e: any) => txn.set.item(e.id, { id: e.id, title: e.title }),
          itemRemoved: (txn: any, e: any) => txn.del.item(e.id),
          noted: () => {},
        },
        inbox: { profileSet: () => {}, noted: () => {} },
      },
      forecasters: {
        addItem: (_txn: any, cmd: any) => ({
          stream: 'catalog',
          event: { type: 'item-added', id: cmd.id, title: cmd.title, added: cmd.added },
        }),
      },
      signal: abort.signal,
      onError: (e: unknown) => errors.push(e),
    });
    expect(server.conn.wants).toEqual(['catalog', 'inbox:*']);

    // live, and the forecast shows through a query on the engine's context
    const rig = { server, engine, data: {}, abort };
    await bootstrap(rig as any, ['catalog'], { catalog: { position: 10, seqs: {}, values: [] } });
    const q = engine.newQuery((txn: any) => txn.get.item('i1'));
    engine.sendCommand({ type: 'add-item', id: 'i1', title: 'T', added });
    await settle();
    expect(q.latest).toEqual({ id: 'i1', title: 'T' });
    expect(errors).toEqual([]);
    abort.abort();
    await settle();
  });

  it('types the bootstrap slot: emit(stream, event) typed like precommit outputs', () => {
    compiles('database');
    const emitted: unknown[] = [];
    const b = M.defineAppDB({
      reducers: {
        catalog: catalogRecorder([]),
        inbox: { profileSet: () => {}, noted: () => {} },
        secret: { secretSet: () => {} },
      },
      precommit: passthrough(),
      maySee: () => [],
      lookup: () => null,
      bootstrap: (ctx: any) => ctx.emit('catalog', itemAdded),
    });
    b.bootstrap({ emit: (stream: string, event: unknown) => emitted.push([stream, event]) });
    expect(emitted).toEqual([['catalog', itemAdded]]);
    expect((globalThis as any).__bundle).toBe(b);
    expect(b.schema).toBe(M.appDBSchema);
  });
});
