/**
 * Behavioral test of the emitted TypeScript decoders.
 *
 * This runs the actual generated code: `pnpm gen` compiles fixtures/main.tsp through the TS
 * emitter into tsp-output/, and the assertions below feed plain JSON values to the decodeX
 * functions and check the typed result.  Decoders coerce dates to Date and dispatch unions to the
 * right member; they trust their input otherwise (validation is the checkers' job, tested in the
 * Python/Go suites).
 */

import { describe, expect, it } from 'vitest';

import * as M from '../../tsp-output/@phaselock/typespec-ts/fixtures.gen.ts';

const ISO = '2024-01-02T03:04:05.000Z';
const ISO2 = '2020-06-07T08:09:10.000Z';
const ms = (iso: string) => new Date(iso).getTime();

describe('plain / scalar decode', () => {
  it('passes through a struct with no fields to transform', () => {
    const input = { id: 'x', n: 7, flag: true };
    expect(M.decodePlain(input)).toEqual(input);
  });

  it('passes through a Record field untouched', () => {
    const input = { meta: { a: 1, b: 2 } };
    expect(M.decodeWithRecord(input)).toEqual(input);
  });
});

describe('date decode', () => {
  it('coerces a required date and a present optional date', () => {
    const out = M.decodeTimed({ at: ISO, note: ISO2 });
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.getTime()).toBe(ms(ISO));
    expect(out.note).toBeInstanceOf(Date);
    expect(out.note!.getTime()).toBe(ms(ISO2));
  });

  it('leaves an absent optional date undefined', () => {
    const out = M.decodeTimed({ at: ISO });
    expect(out.at).toBeInstanceOf(Date);
    expect(out.note).toBeUndefined();
  });
});

describe('nested and collection decode', () => {
  it('recurses into a nested struct and preserves siblings', () => {
    const out = M.decodeNested({ inner: { at: ISO }, tags: ['a', 'b'], count: 3 });
    expect(out.inner.at).toBeInstanceOf(Date);
    expect(out.inner.at.getTime()).toBe(ms(ISO));
    expect(out.tags).toEqual(['a', 'b']);
    expect(out.count).toBe(3);
  });

  it('decodes a date element inside a tuple', () => {
    const out = M.decodeWithTuple({ pair: ['label', ISO] });
    expect(out.pair[0]).toBe('label');
    expect(out.pair[1]).toBeInstanceOf(Date);
    expect(out.pair[1].getTime()).toBe(ms(ISO));
  });

  it('decodes record values that need transformation', () => {
    const out = M.decodeWithDateRecord({ stamps: { a: ISO, b: ISO2 } });
    expect(out.stamps.a).toBeInstanceOf(Date);
    expect(out.stamps.a.getTime()).toBe(ms(ISO));
    expect(out.stamps.b).toBeInstanceOf(Date);
    expect(out.stamps.b.getTime()).toBe(ms(ISO2));
  });
});

describe('discriminated-union decode (by `type`)', () => {
  it('dispatches to the matching member and decodes its dates', () => {
    expect(M.decodeGreek({ type: 'alpha', a: 1 })).toEqual({ type: 'alpha', a: 1 });
    const beta = M.decodeGreek({ type: 'beta', at: ISO }) as M.Beta;
    expect(beta.at).toBeInstanceOf(Date);
    expect(beta.at.getTime()).toBe(ms(ISO));
  });

  it('throws on an unknown discriminator value', () => {
    expect(() => M.decodeGreek({ type: 'gamma' })).toThrow();
  });
});

describe('sub-discriminated-union decode (by `[type, v]`)', () => {
  it('splits on type, then on v within the shared-type bucket', () => {
    // va/v=1 needs no transform; va/v=2 carries a date; vb is a separate type
    expect(M.decodeVersioned({ type: 'va', v: 1, a: 9 })).toEqual({ type: 'va', v: 1, a: 9 });
    const va2 = M.decodeVersioned({ type: 'va', v: 2, at: ISO }) as M.VA2;
    expect(va2.at).toBeInstanceOf(Date);
    expect(va2.at.getTime()).toBe(ms(ISO));
    expect(M.decodeVersioned({ type: 'vb', v: 1, b: 'z' })).toEqual({ type: 'vb', v: 1, b: 'z' });
  });

  it('throws on an unknown sub-discriminator value', () => {
    expect(() => M.decodeVersioned({ type: 'va', v: 99 })).toThrow();
  });
});

describe('one-of-union decode (by present key)', () => {
  it('detects the present key and decodes the matching member', () => {
    expect(M.decodeTarget({ book: 'b1' })).toEqual({ book: 'b1' });
    const ed = M.decodeTarget({ at: ISO }) as M.ByEdition;
    expect(ed.at).toBeInstanceOf(Date);
    expect(ed.at.getTime()).toBe(ms(ISO));
  });

  it('throws when no member key is present', () => {
    expect(() => M.decodeTarget({ nope: 1 })).toThrow();
  });
});

describe('engine event / command decode', () => {
  it('decodes events through the event union', () => {
    const beta = M.decodeEvents({ type: 'beta', at: ISO }) as M.Beta;
    expect(beta.at).toBeInstanceOf(Date);
    expect(M.decodeEvents({ type: 'other' })).toEqual({ type: 'other' });
  });

  it('decodes commands through the command union', () => {
    const cmd = M.decodeCommands({ type: 'do-thing', when: ISO }) as M.DoThing;
    expect(cmd.when).toBeInstanceOf(Date);
    expect(cmd.when.getTime()).toBe(ms(ISO));
    expect(M.decodeCommands({ type: 'undo' })).toEqual({ type: 'undo' });
  });
});

describe('literal-union decode', () => {
  it('passes literal-union values through unchanged', () => {
    expect(M.decodeColor('green')).toBe('green');
    expect(M.decodeLevel(2)).toBe(2);
  });
});
