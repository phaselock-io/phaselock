/**
 * Vocabulary tests: slices, engines, databases, mutations, and the intake-transformed types, with
 * the validation around each.  Every feature and every diagnostic of the vocabulary has a test
 * here, and the library example's model compiles clean as the end-to-end check.
 */

import { readFileSync } from 'node:fs';

import {
  type LoweredProgram,
  PIntake,
  type PLiteral,
  type PMutation,
  PResult,
  PString,
  PStruct,
  PUnion,
} from '@phaselock/typespec-core';
import { describe, expect, it } from 'vitest';

import { codes, lower, lowerFile, root } from './lower-harness.ts';

// two slices, a singleton and a parameterized one, shared by most tests below
const BOOK = `
  model Book { id: string; }
  interface BookSlice extends Slice<"book", { "book:{id}": Book; }> {}
`;
const PATRON = `
  model Patron { name: string; }
  interface PatronSlice extends Slice<"patron:{patron}", {
    "patron": Patron;
    "note:{note}": string;
  }> {}
`;
const OPEN = 'model Open { type: "open"; id: string; }';
const MUTATIONS = `
  ${OPEN}
  model Close { type: "close"; id: string; patron: string; }
  model Join { type: "join"; name: string; }
`;

function mutation(l: LoweredProgram, name: string): PMutation {
  const found = l.mutations.find((m) => m.name === name);
  if (found === undefined) throw new Error(`no mutation ${name}`);
  return found;
}

describe('slices', () => {
  it('lowers a singleton slice: its family and its slice-local key templates', async () => {
    const l = await lower(`
      ${BOOK.replace('{ "book:{id}": Book; }', '{ "book:{id}": Book; "count": int32; }')}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.slices).toHaveLength(1);
    const slice = l.lowered.slices[0];
    expect(slice.name).toBe('BookSlice');
    expect(slice.family).toBe('book');
    expect(slice.params).toEqual([]);
    expect(slice.template).toBe('book');
    expect(slice.store.items.map((i) => i.tpl)).toEqual(['book:{id}', 'count']);
  });

  it('parses a parameterized family into its parameters', async () => {
    const l = await lower(`
      interface ChatSlice extends Slice<"chat:{org},{channel}", {
        "message:{message}": string;
      }> {}
    `);
    expect(codes(l)).toEqual([]);
    const slice = l.lowered.slices[0];
    expect(slice.family).toBe('chat');
    expect(slice.params).toEqual(['org', 'channel']);
    expect(slice.template).toBe('chat:{org},{channel}');
  });

  it('takes an alias as the store spec', async () => {
    const l = await lower(`
      model Book { id: string; }
      alias BookStore = { "book:{id}": Book; "shelf:{shelf},{id}": true; };
      interface BookSlice extends Slice<"book", BookStore> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.slices[0].store.items.map((i) => i.tpl)).toEqual([
      'book:{id}',
      'shelf:{shelf},{id}',
    ]);
    expect(l.lowered.slices[0].store.items.map((i) => [i.name, i.params, i.chunks])).toEqual([
      ['book', ['id'], ['book:', '']],
      ['shelf', ['shelf', 'id'], ['shelf:', ',', '']],
    ]);
  });

  it.each([
    ['a trailing colon', 'book:'],
    ['a parameter with no family name', '{id}'],
    ['a literal segment after a parameter', 'chat:{org},room,{channel}'],
    ['a character outside the name set', 'bo ok'],
    ['an empty parameter', 'chat:{}'],
    ['an unclosed parameter', 'chat:{org'],
    ['a dot before a parameter', 'chat.{org}'],
    ['a comma before the first parameter', 'chat,{org}'],
    ['a colon between parameters', 'chat:{org}:{channel}'],
    ['adjacent parameters', 'chat:{org}{channel}'],
    ['a trailing comma', 'chat:{org},'],
  ])('rejects a family template with %s', async (_, family) => {
    const l = await lower(`
      interface BookSlice extends Slice<"${family}", { "book:{id}": string; }> {}
    `);
    expect(codes(l)).toContain('invalid-slice-family');
  });

  it.each([
    ['a trailing colon', 'book:'],
    ['a parameter with no name before it', '{id}'],
    ['a literal segment after a parameter', 'msg:{id},reactions'],
    ['a slash', 'book/{id}'],
    ['a dot before a parameter', 'book.{id}'],
    ['a bang before a parameter', 'book!{id}'],
    ['a colon between parameters', 'shelf:{shelf}:{id}'],
    ['a character outside the name set', 'bo~ok:{id}'],
  ])('rejects a key template with %s', async (_, tpl) => {
    const l = await lower(`
      interface BookSlice extends Slice<"book", { "${tpl}": string; }> {}
    `);
    expect(codes(l)).toContain('invalid-key-template');
  });

  it('reports key templates in one slice that share a name', async () => {
    const l = await lower(`
      interface BookSlice extends Slice<"book", {
        "book:{id}": string;
        "book:{shelf},{id}": string;
      }> {}
    `);
    expect(codes(l)).toContain('store-collision');
  });

  it('rejects a local key parameter that repeats a family parameter', async () => {
    const l = await lower(`
      interface PatronSlice extends Slice<"patron:{patron}", {
        "hold:{patron}": string;
      }> {}
    `);
    expect(codes(l)).toContain('duplicate-key-param');
  });
});

describe('engines', () => {
  it('lowers an engine: its slices, its mutations union, and its mutations', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${MUTATIONS}
      union UserMutations { Open, Close }
      interface UserEngine extends Engine<[BookSlice, PatronSlice], UserMutations> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.engines).toHaveLength(1);
    const eng = l.lowered.engines[0];
    expect(eng.name).toBe('UserEngine');
    expect(eng.slices.map((s) => s.name)).toEqual(['BookSlice', 'PatronSlice']);
    expect(eng.mutationType).toBe(root(l.lowered, 'UserMutations'));
    expect(eng.mutations.map((m) => m.name)).toEqual(['Open', 'Close']);
  });

  it('flattens nested mutation unions', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${MUTATIONS}
      union UserMutations { Open, Close }
      union AdminMutations { UserMutations, Join }
      interface AdminEngine extends Engine<[BookSlice, PatronSlice], AdminMutations> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.engines[0].mutations.map((m) => m.name)).toEqual(['Open', 'Close', 'Join']);
  });

  it('takes a single named model in place of a mutations union', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
    const eng = l.lowered.engines[0];
    expect(eng.mutationType).toBe(root(l.lowered, 'Open'));
    expect(eng.mutations.map((m) => m.name)).toEqual(['Open']);
  });

  it('rejects a slice list member that is not a Slice', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface NotASlice {}
      interface UserEngine extends Engine<[BookSlice, NotASlice], Open> {}
    `);
    expect(codes(l)).toContain('not-a-slice');
  });

  it.each([
    ['a scalar', 'string'],
    ['an anonymous model', '{ type: "shut"; id: string; }'],
    ['an array', 'Open[]'],
    ['a record', 'Record<Open>'],
  ])('rejects a mutation that is %s rather than a named model', async (_, member) => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      union UserMutations { Open, ${member} }
      interface UserEngine extends Engine<[BookSlice], UserMutations> {}
    `);
    expect(codes(l)).toContain('not-a-mutation');
  });

  it('requires the mutations union to be named', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Shut { type: "shut"; id: string; }
      interface UserEngine extends Engine<[BookSlice], Open | Shut> {}
    `);
    expect(codes(l)).toContain('invalid-template-args');
  });

  it("rejects local key names that collide across the engine's slices", async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface ShelfSlice extends Slice<"shelf:{shelf}", { "book:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice, ShelfSlice], Open> {}
    `);
    expect(codes(l)).toContain('key-name-collision');
  });

  it('rejects two slices of one family in an engine', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface OtherBookSlice extends Slice<"book", { "shelf:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice, OtherBookSlice], Open> {}
    `);
    expect(codes(l)).toContain('family-collision');
  });

  it('allows one local key name in slices that are never composed together', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface ShelfSlice extends Slice<"shelf:{shelf}", { "book:{id}": string; }> {}
      interface BookEngine extends Engine<[BookSlice], Open> {}
      interface ShelfEngine extends Engine<[ShelfSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
  });
});

describe('databases', () => {
  const SECRET = `
    interface SecretSlice extends Slice<"secret", { "secret:{id}": string; }> {}
    model Keep { type: "keep"; secret: string; }
  `;

  it('composes its slices and mutations from its engines, plus its own', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${MUTATIONS} ${SECRET}
      union UserMutations { Open, Close }
      union AdminMutations { UserMutations, Join }
      interface UserEngine extends Engine<[BookSlice, PatronSlice], UserMutations> {}
      interface AdminEngine extends Engine<[BookSlice, PatronSlice], AdminMutations> {}
      interface LibraryDB extends Database<[UserEngine, AdminEngine], [SecretSlice], Keep> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.databases).toHaveLength(1);
    const db = l.lowered.databases[0];
    expect(db.name).toBe('LibraryDB');
    expect(db.engines.map((e) => e.name)).toEqual(['UserEngine', 'AdminEngine']);
    expect(db.extraSlices.map((s) => s.name)).toEqual(['SecretSlice']);
    expect(db.extraMutations.map((m) => m.name)).toEqual(['Keep']);
    // each slice and mutation once, in first-seen order
    expect(db.slices.map((s) => s.name)).toEqual(['BookSlice', 'PatronSlice', 'SecretSlice']);
    expect(db.mutations.map((m) => m.name)).toEqual(['Open', 'Close', 'Join', 'Keep']);
  });

  it('takes its extra slices and mutations as optional', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    expect(codes(l)).toEqual([]);
    const db = l.lowered.databases[0];
    expect(db.slices.map((s) => s.name)).toEqual(['BookSlice']);
    expect(db.mutations.map((m) => m.name)).toEqual(['Open']);
  });

  it('takes its own mutations as an unnamed union', async () => {
    const l = await lower(`
      ${BOOK} ${MUTATIONS}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [], Close | Join> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.databases[0].extraMutations.map((m) => m.name)).toEqual(['Close', 'Join']);
  });

  it('rejects an engine list member that is not an Engine', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine, BookSlice]> {}
    `);
    expect(codes(l)).toContain('not-an-engine');
  });

  it('rejects a slice list member that is not a Slice', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [UserEngine]> {}
    `);
    expect(codes(l)).toContain('not-a-slice');
  });

  it('rejects a database mutation that is not a named model', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [], string> {}
    `);
    expect(codes(l)).toContain('not-a-mutation');
  });

  it('rejects local key names that collide among its composed slices', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface SecretSlice extends Slice<"secret", { "book:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [SecretSlice]> {}
    `);
    expect(codes(l)).toContain('key-name-collision');
  });

  it('is not required: a program of engines alone lowers clean', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.databases).toEqual([]);
  });

  it('may appear more than once', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface OneDB extends Database<[UserEngine]> {}
      interface TwoDB extends Database<[UserEngine]> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.databases.map((d) => d.name)).toEqual(['OneDB', 'TwoDB']);
  });
});

describe('mutations', () => {
  it('makes a model a mutation when a mutations union lists it, once however often', async () => {
    const l = await lower(`
      ${BOOK} ${MUTATIONS}
      union UserMutations { Open, Close }
      interface UserEngine extends Engine<[BookSlice], UserMutations> {}
      interface AdminEngine extends Engine<[BookSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.mutations.map((m) => m.name)).toEqual(['Open', 'Close']);
    expect(mutation(l.lowered, 'Open').type).toBe(root(l.lowered, 'Open'));
    expect(l.lowered.engines[1].mutations[0]).toBe(mutation(l.lowered, 'Open'));
  });

  it('lists mutations in the order of their declarations', async () => {
    const l = await lower(`
      ${BOOK} ${MUTATIONS}
      union UserMutations { Join, Open }
      interface UserEngine extends Engine<[BookSlice], UserMutations> {}
      interface LibraryDB extends Database<[UserEngine], [], Close> {}
    `);
    expect(l.lowered.mutations.map((m) => m.name)).toEqual(['Open', 'Close', 'Join']);
  });

  it('records @online', async () => {
    const l = await lower(`
      ${BOOK}
      @online model Open { type: "open"; id: string; }
      model Shut { type: "shut"; id: string; }
      union UserMutations { Open, Shut }
      interface UserEngine extends Engine<[BookSlice], UserMutations> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(mutation(l.lowered, 'Open').online).toBe(true);
    expect(mutation(l.lowered, 'Shut').online).toBe(false);
  });

  it('warns about an @online model that no union lists', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      @online model Stray { type: "stray"; }
      interface UserEngine extends Engine<[BookSlice], Open> {}
    `);
    const d = l.diagnostics.find((x) => x.code === 'online-not-mutation');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('Stray');
    expect(l.lowered.mutations.map((m) => m.name)).toEqual(['Open']);
  });
});

describe('intake types', () => {
  // a login slice whose values carry the results of intake
  const LOGIN = `
    model Login { login: string; password: PasswordHash; }
    interface LoginSlice extends Slice<"login", { "login:{login}": Login; }> {}
  `;

  /** an engine listing the model as its one mutation */
  const listing = (name: string) => `
    interface LoginEngine extends Engine<[LoginSlice], ${name}> {}
  `;

  it('lowers NewPassword to an intake from a string to a PasswordHash', async () => {
    const l = await lower(`
      ${LOGIN}
      @online
      model CreateAccount { type: "create-account"; login: string; password: NewPassword; }
      ${listing('CreateAccount')}
    `);
    expect(codes(l)).toEqual([]);
    const pw = (root(l.lowered, 'CreateAccount') as PStruct).fields.get('password')!;
    expect(pw).toBeInstanceOf(PIntake);
    const intake = pw as PIntake;
    expect(intake.kind).toBe('NewPassword');
    expect(intake.wire).toBeInstanceOf(PString);
    expect(intake.result).toBeInstanceOf(PResult);
    expect(intake.result.kind).toBe('PasswordHash');
    expect(intake.result.base).toBeInstanceOf(PString);
  });

  it('lowers PasswordHash to a result over string, the same one NewPassword produces', async () => {
    const l = await lower(`
      ${LOGIN}
      @online
      model CreateAccount { type: "create-account"; login: string; password: NewPassword; }
      ${listing('CreateAccount')}
    `);
    const hash = (root(l.lowered, 'Login') as PStruct).fields.get('password')!;
    expect(hash).toBeInstanceOf(PResult);
    const pw = (root(l.lowered, 'CreateAccount') as PStruct).fields.get('password') as PIntake;
    expect(pw.result).toBe(hash);
  });

  it('lowers MutationAuth to an intake from a proof union to a MutationAuthResult', async () => {
    const l = await lower(`
      ${LOGIN}
      @online
      model DeleteAccount { type: "delete-account"; check: MutationAuth; }
      ${listing('DeleteAccount')}
    `);
    expect(codes(l)).toEqual([]);
    const check = (root(l.lowered, 'DeleteAccount') as PStruct).fields.get('check') as PIntake;
    expect(check).toBeInstanceOf(PIntake);
    expect(check.kind).toBe('MutationAuth');
    expect(check.wire).toBeInstanceOf(PUnion);
    const kinds = (check.wire as PUnion).types.map(
      (t) => ((t as PStruct).fields.get('kind') as PLiteral).value,
    );
    expect(kinds).toEqual(['password', 'totp', 'email-code', 'webauthn', 'yubikey-otp']);
    expect(check.result.kind).toBe('MutationAuthResult');
    expect((check.result.base as PStruct).fields.has('kind')).toBe(true);
  });

  it.each([
    ['CaptchaToken', 'CaptchaResult'],
    ['IdentityProof', 'IdentityResult'],
  ])('lowers %s to an intake from a string to a %s', async (input, result) => {
    const l = await lower(`
      ${LOGIN}
      @online
      model SignUp { type: "sign-up"; proof: ${input}; }
      ${listing('SignUp')}
    `);
    expect(codes(l)).toEqual([]);
    const proof = (root(l.lowered, 'SignUp') as PStruct).fields.get('proof') as PIntake;
    expect(proof).toBeInstanceOf(PIntake);
    expect(proof.kind).toBe(input);
    expect(proof.wire).toBeInstanceOf(PString);
    expect(proof.result.kind).toBe(result);
  });

  it("accepts an intake type as an @online mutation's top-level field, optional or not", async () => {
    const l = await lower(`
      ${LOGIN}
      @online
      model CreateAccount {
        type: "create-account";
        password: NewPassword;
        captcha?: CaptchaToken;
      }
      ${listing('CreateAccount')}
    `);
    expect(codes(l)).toEqual([]);
  });

  it.each([
    [
      'nested inside a mutation',
      `@online model C { type: "c"; inner: { pw: NewPassword }; } ${listing('C')}`,
    ],
    [
      'in an array inside a mutation',
      `@online model C { type: "c"; pws: NewPassword[]; } ${listing('C')}`,
    ],
    [
      'in a union inside a mutation',
      `@online model C { type: "c"; pw: NewPassword | null; } ${listing('C')}`,
    ],
    ['in a model that is not a mutation', 'model Loose { pw: NewPassword; }'],
    ['in a store value', 'interface VaultSlice extends Slice<"vault", { "pw": NewPassword; }> {}'],
    ['in a query result', 'interface Q extends Queries { pw(): NewPassword; }'],
    [
      "in a store value that is a mutation's own model",
      `@online model Leaked { type: "leaked"; pw: NewPassword; } ${listing('Leaked')}
       interface LeakSlice extends Slice<"leak", { "last": Leaked; }> {}`,
    ],
  ])('rejects an intake type %s', async (_, code) => {
    const l = await lower(`${LOGIN} ${code}`);
    expect(codes(l)).toContain('placement-violation');
  });

  it('requires @online for a mutation that carries an intake type', async () => {
    const l = await lower(`
      ${LOGIN}
      model CreateAccount { type: "create-account"; password: NewPassword; }
      ${listing('CreateAccount')}
    `);
    expect(codes(l)).toContain('online-required');
  });

  it.each([
    ['directly', 'hash: PasswordHash;'],
    ['nested', 'inner: { hash: PasswordHash };'],
    ['as a MutationAuthResult', 'check: MutationAuthResult;'],
  ])('rejects an intake result in a mutation, where a client could forge it: %s', async (_, f) => {
    const l = await lower(`
      ${LOGIN}
      model Forge { type: "forge"; ${f} }
      ${listing('Forge')}
    `);
    expect(codes(l)).toContain('result-in-mutation');
  });
});

describe('reachability', () => {
  it('warns about a slice that no database reaches', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    const d = l.diagnostics.find((x) => x.code === 'unreachable-slice');
    expect(d?.severity).toBe('warning');
    expect(d?.message).toContain('PatronSlice');
  });

  it('warns about a mutation that no database reaches', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${MUTATIONS}
      union AdminMutations { Open, Close, Join }
      interface UserEngine extends Engine<[BookSlice, PatronSlice], Open> {}
      interface AdminEngine extends Engine<[BookSlice, PatronSlice], AdminMutations> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    const unreached = l.diagnostics.filter((x) => x.code === 'unreachable-mutation');
    expect(unreached.map((d) => d.severity)).toEqual(['warning', 'warning']);
    expect(unreached.map((d) => d.message).join(' ')).toMatch(/Close.*Join/);
  });

  it('does not warn without a database', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${MUTATIONS}
      union UserMutations { Open, Close, Join }
      interface UserEngine extends Engine<[BookSlice], UserMutations> {}
    `);
    expect(codes(l)).toEqual([]);
  });
});

describe('removed vocabulary', () => {
  it.each([
    ['Store', 'interface S extends Store<{ "a": string; }> {}'],
    ['@command', '@command(Open) model Open { type: "open"; }'],
    ['Death', 'model Gone { death: Death; }'],
    ['Erasure', 'model Forgotten { erasure: Erasure; }'],
  ])('no longer has %s', async (_, code) => {
    const l = await lower(code);
    expect(codes(l)).toContain('invalid-ref');
  });

  it('takes no events in a Slice', async () => {
    const l = await lower(`
      model Opened { type: "opened"; }
      interface BookSlice extends Slice<"book", Opened, { "book:{id}": string; }> {}
    `);
    expect(codes(l)).toContain('invalid-template-args');
  });
});

describe('the library example', () => {
  it('compiles clean, with every slice and mutation reached', async () => {
    const path = new URL('../../../examples/library/model/model.tsp', import.meta.url);
    const l = await lowerFile(readFileSync(path, 'utf8'));
    expect(l.diagnostics).toEqual([]);

    const db = l.lowered.databases[0];
    expect(db.name).toBe('LibraryDB');
    expect(db.slices.map((s) => s.name)).toEqual([
      'BookSlice',
      'PatronSlice',
      'RoomSlice',
      'AdminSlice',
      'LoginSlice',
      'RoomRegistrySlice',
    ]);
    expect(mutation(l.lowered, 'DeleteAccount').online).toBe(true);
  });
});
