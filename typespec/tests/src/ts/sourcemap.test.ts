// mapStack: a stack's locations in one file mapped through that file's source map

import { describe, expect, it } from 'vitest';

import { mapStack, type SourceMap } from '../../../ts/assets/skeleton.ts';

/* Line 1 maps column 0 to a.ts 1:1 and column 9 to a.ts 1:10.  Line 2 maps column 0 to a.ts 2:1
   and column 16 to b.ts 3:17.  Every field but the generated column is relative to the segment
   before it across lines, so line 2 starts by stepping the original column back 9 (T), and 16 is
   two VLQ digits (gB).  Line 3 has no segments. */
const map: SourceMap = {
  sources: ['../src/a.ts', 'b.ts'],
  mappings: 'AAAA,SAAS;AACT,gBCCgB;',
};

describe('mapStack', () => {
  it("maps each location in the file to its source's line and column, 1-based", () => {
    const stack = ['    at f (bundle.js:1:10)', '    at g (bundle.js:2:20)'].join('\n');
    expect(mapStack(stack, 'bundle.js', map)).toBe(
      ['    at f (src/a.ts:1:10)', '    at g (b.ts:3:17)'].join('\n'),
    );
  });

  it('picks the last segment that starts at or before the column', () => {
    expect(mapStack('at f (bundle.js:1:9)', 'bundle.js', map)).toBe('at f (src/a.ts:1:1)');
    expect(mapStack('at f (bundle.js:2:17)', 'bundle.js', map)).toBe('at f (b.ts:3:17)');
  });

  it('leaves other files, unmapped lines, and native frames as they are', () => {
    const stack = [
      '    at h (host.js:1:1)',
      '    at i (bundle.js:3:1)',
      '    at j (bundle.js:9:1)',
      '    at k (native)',
    ].join('\n');
    expect(mapStack(stack, 'bundle.js', map)).toBe(stack);
  });
});
