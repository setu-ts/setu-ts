/**
 * Tests for moving a pre-0.9 project's framework pins onto npm during adoption.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { VERSION } from '../../../src/constants.ts';
import { legacyFrameworkPackage, rewriteLegacyPins } from '../../../src/workspace/legacy-pins.ts';

describe('legacyFrameworkPackage', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ['jsr:@setu-ts/kernel@^0.8.0', 'kernel'],
    ['jsr:/@setu-ts/cache-plugin@^0.8.0', 'cache-plugin'],
    ['npm:@jsr/setu-ts__runtime@^0.8.0', 'runtime'],
    ['npm:@setu-ts/kernel@^0.9.0', undefined],
    ['^0.9.0', undefined],
    ['jsr:@setu-ts/kernel', undefined],
    ['jsr:@other/kernel@1', undefined],
  ];
  for (const [value, pkg] of cases) {
    it(`reads ${value} as ${String(pkg)}`, () => {
      expect(legacyFrameworkPackage(value)).toBe(pkg);
    });
  }
});

describe('rewriteLegacyPins', () => {
  it('moves every Deno import-map pin onto npm and reports each', () => {
    const source = JSON.stringify({
      tasks: { start: 'deno run main.ts' },
      imports: {
        '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^0.8.0',
        '@setu-ts/runtime': 'npm:@jsr/setu-ts__runtime@^0.8.0',
        '@std/expect': 'jsr:@std/expect@^1',
      },
    });
    const result = rewriteLegacyPins(source, 'deno');
    const parsed = JSON.parse(result.contents!);
    expect(parsed.imports).toEqual({
      '@setu-ts/kernel': `npm:@setu-ts/kernel@^${VERSION}`,
      '@setu-ts/runtime': `npm:@setu-ts/runtime@^${VERSION}`,
      '@std/expect': 'jsr:@std/expect@^1',
    });
    expect(parsed.tasks).toEqual({ start: 'deno run main.ts' });
    expect(result.rewrites.map((rewrite) => rewrite.name)).toEqual([
      '@setu-ts/kernel',
      '@setu-ts/runtime',
    ]);
    expect(result.contents!.endsWith('}\n')).toBe(true);
  });

  it('moves npm-compatibility pins in both npm sections to plain ranges', () => {
    const source = JSON.stringify({
      dependencies: { '@setu-ts/kernel': 'npm:@jsr/setu-ts__kernel@^0.8.0' },
      devDependencies: { '@setu-ts/testing': 'npm:@jsr/setu-ts__testing@^0.8.0' },
    });
    const parsed = JSON.parse(rewriteLegacyPins(source, 'npm').contents!);
    expect(parsed.dependencies['@setu-ts/kernel']).toBe(`^${VERSION}`);
    expect(parsed.devDependencies['@setu-ts/testing']).toBe(`^${VERSION}`);
  });

  // A hand-written alias pointing one framework name at another package is the
  // developer's, and is never "corrected".
  it('leaves an alias naming a different package alone', () => {
    const source = JSON.stringify({
      imports: { '@setu-ts/kernel': 'jsr:@setu-ts/runtime@^0.8.0' },
    });
    expect(rewriteLegacyPins(source, 'deno')).toEqual({ contents: undefined, rewrites: [] });
  });

  it('reports nothing for a manifest already on npm, or with no pin sections', () => {
    for (
      const source of [
        JSON.stringify({ imports: { '@setu-ts/kernel': `npm:@setu-ts/kernel@^${VERSION}` } }),
        JSON.stringify({ tasks: {} }),
        JSON.stringify({ imports: ['not', 'a', 'map'] }),
        JSON.stringify({ imports: { '@setu-ts/kernel': 3 } }),
      ]
    ) {
      expect(rewriteLegacyPins(source, 'deno'), source).toEqual({
        contents: undefined,
        rewrites: [],
      });
    }
  });

  it('leaves a manifest that is not a JSON object untouched', () => {
    for (const source of ['{ not json', '[]', 'null', '"text"']) {
      expect(rewriteLegacyPins(source, 'npm'), source).toEqual({
        contents: undefined,
        rewrites: [],
      });
    }
  });
});
