/**
 * Vocabulary tests: slices, engines, databases, commands, and the intake-transformed types, with
 * the validation around each.  Every feature and every diagnostic of the vocabulary has a test
 * here, and the library example's model compiles clean as the end-to-end check.
 */

import { readFileSync } from 'node:fs';

import {
  type LoweredProgram,
  type PCommand,
  PIntake,
  type PLiteral,
  type POutput,
  PResult,
  PString,
  PStruct,
  PUnion,
} from '@phaselock/typespec-core';
import { describe, expect, it } from 'vitest';

import { codes, lower, lowerFile, root } from './lower-harness.ts';

// two slices, a singleton and a parameterized one, shared by most tests below
const BOOK = `
  model Opened { type: "opened"; id: string; }
  model Closed { type: "closed"; id: string; }
  union BookEvents { Opened, Closed }
  model Book { id: string; }
  interface BookSlice extends Slice<"book", BookEvents, { "book:{id}": Book; }> {}
`;
const PATRON = `
  model Joined { type: "joined"; name: string; }
  model Noted { type: "noted"; id: string; }
  union PatronEvents { Joined, Noted }
  model Patron { name: string; }
  interface PatronSlice extends Slice<"patron:{patron}", PatronEvents, {
    "patron": Patron;
    "note:{note}": string;
  }> {}
`;
const OPEN = '@command(Opened) model Open { type: "open"; id: string; }';
const COMMANDS = `
  ${OPEN}
  @command([Closed, Noted]) model Close { type: "close"; id: string; patron: string; }
  @command(Joined) model Join { type: "join"; name: string; }
`;

function command(l: LoweredProgram, name: string): PCommand {
  const found = l.commands.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no command ${name}`);
  return found;
}

/** a command output as a compact string, e.g. 'oneOf(all(A, B), C)' */
function show(o: POutput): string {
  switch (o.kind) {
    case 'event':
      return o.type.name!;
    case 'death':
      return o.erase ? 'erasure' : 'death';
    case 'oneOf':
      return `oneOf(${o.options.map(show).join(', ')})`;
    case 'all':
      return `all(${o.items.map(show).join(', ')})`;
    case 'many':
      return `many(${show(o.item)})`;
  }
}

describe('slices', () => {
  it('lowers a singleton slice: its family, events union, and instance-local key templates', async () => {
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
    expect(slice.events).toBe(root(l.lowered, 'BookEvents'));
    expect(slice.eventTypes.map((t) => t.name)).toEqual(['Opened', 'Closed']);
    expect(slice.store.items.map((i) => i.tpl)).toEqual(['book:{id}', 'count']);
  });

  it('parses a parameterized family into its parameters', async () => {
    const l = await lower(`
      model Said { type: "said"; text: string; }
      model Edited { type: "edited"; text: string; }
      union ChatEvents { Said, Edited }
      interface ChatSlice extends Slice<"chat:{org},{channel}", ChatEvents, {
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
      model Opened { type: "opened"; id: string; }
      model Closed { type: "closed"; id: string; }
      union BookEvents { Opened, Closed }
      model Book { id: string; }
      alias BookStore = { "book:{id}": Book; "shelf:{shelf},{id}": true; };
      interface BookSlice extends Slice<"book", BookEvents, BookStore> {}
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
      model Opened { type: "opened"; id: string; }
      model Closed { type: "closed"; id: string; }
      union BookEvents { Opened, Closed }
      interface BookSlice extends Slice<"${family}", BookEvents, { "book:{id}": string; }> {}
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
      model Opened { type: "opened"; id: string; }
      model Closed { type: "closed"; id: string; }
      union BookEvents { Opened, Closed }
      interface BookSlice extends Slice<"book", BookEvents, { "${tpl}": string; }> {}
    `);
    expect(codes(l)).toContain('invalid-key-template');
  });

  it('requires the events to be a named union', async () => {
    const l = await lower(`
      model Opened { type: "opened"; id: string; }
      model Closed { type: "closed"; id: string; }
      interface BookSlice extends Slice<"book", Opened | Closed, { "book:{id}": string; }> {}
    `);
    expect(codes(l)).toContain('slice-events-not-named');
  });

  it('requires every event to be a named model', async () => {
    const l = await lower(`
      model Opened { type: "opened"; id: string; }
      union BookEvents { Opened, [string, int32] }
      interface BookSlice extends Slice<"book", BookEvents, { "book:{id}": string; }> {}
    `);
    expect(codes(l)).toContain('slice-event-not-model');
  });

  it('reports key templates in one slice that share a name', async () => {
    const l = await lower(`
      model Opened { type: "opened"; id: string; }
      model Closed { type: "closed"; id: string; }
      union BookEvents { Opened, Closed }
      interface BookSlice extends Slice<"book", BookEvents, {
        "book:{id}": string;
        "book:{shelf},{id}": string;
      }> {}
    `);
    expect(codes(l)).toContain('store-collision');
  });

  it('rejects a local key parameter that repeats a family parameter', async () => {
    const l = await lower(`
      model Joined { type: "joined"; name: string; }
      model Noted { type: "noted"; id: string; }
      union PatronEvents { Joined, Noted }
      interface PatronSlice extends Slice<"patron:{patron}", PatronEvents, {
        "hold:{patron}": string;
      }> {}
    `);
    expect(codes(l)).toContain('duplicate-key-param');
  });
});

describe('engines', () => {
  it('lowers an engine: its slices, its commands union, and its commands', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${COMMANDS}
      union UserCommands { Open, Close }
      interface UserEngine extends Engine<[BookSlice, PatronSlice], UserCommands> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.engines).toHaveLength(1);
    const eng = l.lowered.engines[0];
    expect(eng.name).toBe('UserEngine');
    expect(eng.slices.map((s) => s.name)).toEqual(['BookSlice', 'PatronSlice']);
    expect(eng.commandType).toBe(root(l.lowered, 'UserCommands'));
    expect(eng.commands.map((c) => c.name)).toEqual(['Open', 'Close']);
  });

  it('flattens nested command unions', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${COMMANDS}
      union UserCommands { Open, Close }
      union AdminCommands { UserCommands, Join }
      interface AdminEngine extends Engine<[BookSlice, PatronSlice], AdminCommands> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.engines[0].commands.map((c) => c.name)).toEqual(['Open', 'Close', 'Join']);
  });

  it('takes a single named command in place of a commands union', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
    const eng = l.lowered.engines[0];
    expect(eng.commandType).toBe(root(l.lowered, 'Open'));
    expect(eng.commands.map((c) => c.name)).toEqual(['Open']);
  });

  it('rejects a slice list member that is not a Slice', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface NotASlice {}
      interface UserEngine extends Engine<[BookSlice, NotASlice], Open> {}
    `);
    expect(codes(l)).toContain('not-a-slice');
  });

  it('rejects a command that has no @command', async () => {
    const l = await lower(`
      ${BOOK}
      @command(Opened) model Open { type: "open"; id: string; }
      model Shut { type: "shut"; id: string; }
      union UserCommands { Open, Shut }
      interface UserEngine extends Engine<[BookSlice], UserCommands> {}
    `);
    expect(codes(l)).toContain('not-a-command');
  });

  it('requires the commands union to be named', async () => {
    const l = await lower(`
      ${BOOK}
      @command(Opened) model Open { type: "open"; id: string; }
      @command(Closed) model Shut { type: "shut"; id: string; }
      interface UserEngine extends Engine<[BookSlice], Open | Shut> {}
    `);
    expect(codes(l)).toContain('invalid-template-args');
  });

  it("rejects local key names that collide across the engine's slices", async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Shelved { type: "shelved"; id: string; }
      model Unshelved { type: "unshelved"; id: string; }
      union ShelfEvents { Shelved, Unshelved }
      interface ShelfSlice extends Slice<"shelf:{shelf}", ShelfEvents, { "book:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice, ShelfSlice], Open> {}
    `);
    expect(codes(l)).toContain('key-name-collision');
  });

  it('rejects two slices of one family in an engine', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Shelved { type: "shelved"; id: string; }
      model Unshelved { type: "unshelved"; id: string; }
      union ShelfEvents { Shelved, Unshelved }
      interface OtherBookSlice extends Slice<"book", ShelfEvents, { "shelf:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice, OtherBookSlice], Open> {}
    `);
    expect(codes(l)).toContain('family-collision');
  });

  it('allows one local key name in slices that are never composed together', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Shelved { type: "shelved"; id: string; }
      model Unshelved { type: "unshelved"; id: string; }
      union ShelfEvents { Shelved, Unshelved }
      interface ShelfSlice extends Slice<"shelf:{shelf}", ShelfEvents, { "book:{id}": string; }> {}
      interface BookEngine extends Engine<[BookSlice], Open> {}
      interface ShelfEngine extends Engine<[ShelfSlice], Open> {}
    `);
    expect(codes(l)).toEqual([]);
  });
});

describe('databases', () => {
  const SECRET = `
    model Kept { type: "kept"; secret: string; }
    model Dropped { type: "dropped"; secret: string; }
    union SecretEvents { Kept, Dropped }
    interface SecretSlice extends Slice<"secret", SecretEvents, { "secret:{id}": string; }> {}
    @command(Kept) model Keep { type: "keep"; secret: string; }
  `;

  it('composes its slices and commands from its engines, plus its own', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${COMMANDS} ${SECRET}
      union UserCommands { Open, Close }
      union AdminCommands { UserCommands, Join }
      interface UserEngine extends Engine<[BookSlice, PatronSlice], UserCommands> {}
      interface AdminEngine extends Engine<[BookSlice, PatronSlice], AdminCommands> {}
      interface LibraryDB extends Database<[UserEngine, AdminEngine], [SecretSlice], Keep> {}
    `);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.databases).toHaveLength(1);
    const db = l.lowered.databases[0];
    expect(db.name).toBe('LibraryDB');
    expect(db.engines.map((e) => e.name)).toEqual(['UserEngine', 'AdminEngine']);
    expect(db.extraSlices.map((s) => s.name)).toEqual(['SecretSlice']);
    expect(db.extraCommands.map((c) => c.name)).toEqual(['Keep']);
    // each slice and command once, in first-seen order
    expect(db.slices.map((s) => s.name)).toEqual(['BookSlice', 'PatronSlice', 'SecretSlice']);
    expect(db.commands.map((c) => c.name)).toEqual(['Open', 'Close', 'Join', 'Keep']);
  });

  it('takes its extra slices and commands as optional', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    expect(codes(l)).toEqual([]);
    const db = l.lowered.databases[0];
    expect(db.slices.map((s) => s.name)).toEqual(['BookSlice']);
    expect(db.commands.map((c) => c.name)).toEqual(['Open']);
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

  it('rejects a database command that has no @command', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Shut { type: "shut"; id: string; }
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [], Shut> {}
    `);
    expect(codes(l)).toContain('not-a-command');
  });

  it('rejects local key names that collide among its composed slices', async () => {
    const l = await lower(`
      ${BOOK} ${OPEN}
      model Kept { type: "kept"; secret: string; }
      model Dropped { type: "dropped"; secret: string; }
      union SecretEvents { Kept, Dropped }
      interface SecretSlice extends Slice<"secret", SecretEvents, { "book:{id}": string; }> {}
      interface UserEngine extends Engine<[BookSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine], [SecretSlice]> {}
    `);
    expect(codes(l)).toContain('key-name-collision');
  });

  it('rejects a command whose output lands in a slice the database lacks', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${COMMANDS}
      union UserCommands { Open, Close }
      interface UserEngine extends Engine<[BookSlice], UserCommands> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    // Close emits Noted, which only PatronSlice folds, and no engine of the database has it
    expect(codes(l)).toContain('command-output-outside-db');
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

describe('commands', () => {
  it('lowers a passthrough command, whose output is itself', async () => {
    const l = await lower(`
      @command(AddBook) model AddBook { type: "add-book"; id: string; }
      model Removed { type: "removed"; id: string; }
      union BookEvents { AddBook, Removed }
      interface BookSlice extends Slice<"book", BookEvents, { "book:{id}": string; }> {}
    `);
    expect(codes(l)).toEqual([]);
    const add = command(l.lowered, 'AddBook');
    expect(add.type).toBe(root(l.lowered, 'AddBook'));
    expect(add.output).toEqual({
      kind: 'event',
      type: root(l.lowered, 'AddBook'),
      slices: [l.lowered.slices[0]],
    });
  });

  it('lowers unions, tuples, arrays, and deaths in an output', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON}
      @command([Opened, Joined] | [Opened, Joined, Closed, Noted] | Noted)
      model Try { type: "try"; id: string; }
      @command([Noted, Death, Closed[]])
      model Leave { type: "leave"; patron: string; }
      @command([Erasure, Noted])
      model Forget { type: "forget"; patron: string; }
    `);
    expect(codes(l)).toEqual([]);
    expect(show(command(l.lowered, 'Try').output)).toBe(
      'oneOf(all(Opened, Joined), all(Opened, Joined, Closed, Noted), Noted)',
    );
    expect(show(command(l.lowered, 'Leave').output)).toBe('all(Noted, death, many(Closed))');
    expect(show(command(l.lowered, 'Forget').output)).toBe('all(erasure, Noted)');
  });

  it('labels an output event with every slice that folds it', async () => {
    const l = await lower(`
      @command(Dismiss) model Dismiss { type: "dismiss"; id: string; }
      model Warned { type: "warned"; id: string; reason: string; }
      model Alerted { type: "alerted"; id: string; reason: string; }
      union AdminEvents { Warned, Dismiss }
      union PatronEvents { Alerted, Dismiss }
      interface AdminSlice extends Slice<"admin", AdminEvents, { "admin_notice:{notice}": string; }> {}
      interface PatronSlice extends Slice<"patron:{patron}", PatronEvents, {
        "patron_notice:{notice}": string;
      }> {}
    `);
    expect(codes(l)).toEqual([]);
    const out = command(l.lowered, 'Dismiss').output;
    expect(out.kind).toBe('event');
    if (out.kind !== 'event') return;
    expect(out.slices.map((s) => s.name)).toEqual(['AdminSlice', 'PatronSlice']);
  });

  it('rejects an output model that no slice folds', async () => {
    const l = await lower(`
      ${BOOK}
      model Stray { type: "stray"; id: string; }
      @command(Stray) model Wander { type: "wander"; id: string; }
    `);
    expect(codes(l)).toContain('command-output-not-event');
  });

  it.each([
    ['a string literal', '"opened"'],
    ['a scalar', 'string'],
    ['a record', 'Record<Opened>'],
  ])('rejects an output that is %s', async (_, output) => {
    const l = await lower(`
      ${BOOK}
      @command(${output}) model Open { type: "open"; id: string; }
    `);
    expect(codes(l)).toContain('invalid-command-output');
  });

  it('records @online', async () => {
    const l = await lower(`
      ${BOOK}
      @online @command(Opened) model Open { type: "open"; id: string; }
      @command(Closed) model Shut { type: "shut"; id: string; }
    `);
    expect(codes(l)).toEqual([]);
    expect(command(l.lowered, 'Open').online).toBe(true);
    expect(command(l.lowered, 'Shut').online).toBe(false);
  });

  it('lowers every @command model, whether or not anything lists it', async () => {
    const l = await lower(`${BOOK} ${PATRON} ${COMMANDS}`);
    expect(codes(l)).toEqual([]);
    expect(l.lowered.commands.map((c) => c.name)).toEqual(['Open', 'Close', 'Join']);
  });

  it('rejects Death and Erasure anywhere but a command output', async () => {
    const l = await lower(`
      ${BOOK}
      model Gone { type: "gone"; death: Death; }
      model Forgotten { type: "forgotten"; erasure: Erasure; }
    `);
    expect(codes(l)).toEqual(['death-placement', 'death-placement']);
  });
});

describe('intake types', () => {
  // a login slice whose events carry the results of intake
  const LOGIN = `
    model LoginCreated { type: "login-created"; login: string; password: PasswordHash; }
    model LoginDeleted { type: "login-deleted"; login: string; }
    union LoginEvents { LoginCreated, LoginDeleted }
    interface LoginSlice extends Slice<"login", LoginEvents, { "login:{login}": PasswordHash; }> {}
  `;

  it('lowers NewPassword to an intake from a string to a PasswordHash', async () => {
    const l = await lower(`
      ${LOGIN}
      @online @command(LoginCreated)
      model CreateAccount { type: "create-account"; login: string; password: NewPassword; }
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
      @online @command(LoginCreated)
      model CreateAccount { type: "create-account"; login: string; password: NewPassword; }
    `);
    const hash = (root(l.lowered, 'LoginCreated') as PStruct).fields.get('password')!;
    expect(hash).toBeInstanceOf(PResult);
    const pw = (root(l.lowered, 'CreateAccount') as PStruct).fields.get('password') as PIntake;
    expect(pw.result).toBe(hash);
  });

  it('lowers CommandAuth to an intake from a proof union to a CommandAuthResult', async () => {
    const l = await lower(`
      ${LOGIN}
      @online @command(LoginDeleted)
      model DeleteAccount { type: "delete-account"; check: CommandAuth; }
    `);
    expect(codes(l)).toEqual([]);
    const check = (root(l.lowered, 'DeleteAccount') as PStruct).fields.get('check') as PIntake;
    expect(check).toBeInstanceOf(PIntake);
    expect(check.kind).toBe('CommandAuth');
    expect(check.wire).toBeInstanceOf(PUnion);
    const kinds = (check.wire as PUnion).types.map(
      (t) => ((t as PStruct).fields.get('kind') as PLiteral).value,
    );
    expect(kinds).toEqual(['password', 'totp', 'email-code', 'webauthn', 'yubikey-otp']);
    expect(check.result.kind).toBe('CommandAuthResult');
    expect((check.result.base as PStruct).fields.has('kind')).toBe(true);
  });

  it.each([
    ['CaptchaToken', 'CaptchaResult'],
    ['IdentityProof', 'IdentityResult'],
  ])('lowers %s to an intake from a string to a %s', async (input, result) => {
    const l = await lower(`
      ${LOGIN}
      @online @command(LoginCreated)
      model SignUp { type: "sign-up"; proof: ${input}; }
    `);
    expect(codes(l)).toEqual([]);
    const proof = (root(l.lowered, 'SignUp') as PStruct).fields.get('proof') as PIntake;
    expect(proof).toBeInstanceOf(PIntake);
    expect(proof.kind).toBe(input);
    expect(proof.wire).toBeInstanceOf(PString);
    expect(proof.result.kind).toBe(result);
  });

  it("accepts an intake type as an @online command's top-level field, optional or not", async () => {
    const l = await lower(`
      ${LOGIN}
      @online @command(LoginCreated)
      model CreateAccount {
        type: "create-account";
        password: NewPassword;
        captcha?: CaptchaToken;
      }
    `);
    expect(codes(l)).toEqual([]);
  });

  it.each([
    [
      'nested inside a command',
      '@online @command(LoginCreated) model C { type: "c"; inner: { pw: NewPassword }; }',
    ],
    [
      'in an array inside a command',
      '@online @command(LoginCreated) model C { type: "c"; pws: NewPassword[]; }',
    ],
    [
      'in a union inside a command',
      '@online @command(LoginCreated) model C { type: "c"; pw: NewPassword | null; }',
    ],
    ['in a model that is not a command', 'model Loose { pw: NewPassword; }'],
    [
      'in a store value',
      `model Kept { type: "kept"; id: string; }
       model Dropped { type: "dropped"; id: string; }
       union VaultEvents { Kept, Dropped }
       interface VaultSlice extends Slice<"vault", VaultEvents, { "pw": NewPassword; }> {}`,
    ],
    ['in a query result', 'interface Q extends Queries { pw(): NewPassword; }'],
    [
      "in an event, even a passthrough command's",
      `@online @command(Leaked) model Leaked { type: "leaked"; pw: NewPassword; }
       model Sealed { type: "sealed"; id: string; }
       union LeakEvents { Leaked, Sealed }
       interface LeakSlice extends Slice<"leak", LeakEvents, { "leak:{id}": string; }> {}`,
    ],
  ])('rejects an intake type %s', async (_, code) => {
    const l = await lower(`${LOGIN} ${code}`);
    expect(codes(l)).toContain('placement-violation');
  });

  it('requires @online for a command that carries an intake type', async () => {
    const l = await lower(`
      ${LOGIN}
      @command(LoginCreated)
      model CreateAccount { type: "create-account"; password: NewPassword; }
    `);
    expect(codes(l)).toContain('online-required');
  });

  it.each([
    ['directly', 'hash: PasswordHash;'],
    ['nested', 'inner: { hash: PasswordHash };'],
    ['as a CommandAuthResult', 'check: CommandAuthResult;'],
  ])('rejects an intake result in a command, where a client could forge it: %s', async (_, f) => {
    const l = await lower(`
      ${LOGIN}
      @command(LoginDeleted) model Forge { type: "forge"; ${f} }
    `);
    expect(codes(l)).toContain('result-in-command');
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

  it('warns about a command that no database reaches', async () => {
    const l = await lower(`
      ${BOOK} ${PATRON} ${COMMANDS}
      interface UserEngine extends Engine<[BookSlice, PatronSlice], Open> {}
      interface LibraryDB extends Database<[UserEngine]> {}
    `);
    const unreached = l.diagnostics.filter((x) => x.code === 'unreachable-command');
    expect(unreached.map((d) => d.severity)).toEqual(['warning', 'warning']);
    expect(unreached.map((d) => d.message).join(' ')).toMatch(/Close.*Join/);
  });

  it('does not warn without a database', async () => {
    const l = await lower(`${BOOK} ${PATRON} ${COMMANDS}`);
    expect(codes(l)).toEqual([]);
  });
});

describe('removed vocabulary', () => {
  it('no longer has Store', async () => {
    const l = await lower(`interface S extends Store<{ "a": string; }> {}`);
    expect(codes(l)).toContain('invalid-ref');
  });
});

describe('the library example', () => {
  it('compiles clean, with every slice and command reached', async () => {
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
    expect(show(command(l.lowered, 'DeleteAccount').output)).toBe(
      'all(LoginDeleted, erasure, many(HoldClosed))',
    );
  });
});
