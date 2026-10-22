/**
 * Tests for moving a pre-0.9 project's framework pins onto npm during adoption.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { VERSION } from '../../../src/constants.ts';
import { legacyFrameworkPackage, rewriteLegacyPins } from '../../../src/workspace/legacy-pins.ts';
import { parseJsonc } from '../../../src/utils/manifest-reader.ts';

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
    const source = `${JSON.stringify(
      {
        tasks: { start: 'deno run main.ts' },
        imports: {
          '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^0.8.0',
          '@setu-ts/runtime': 'npm:@jsr/setu-ts__runtime@^0.8.0',
          '@std/expect': 'jsr:@std/expect@^1',
        },
      },
      null,
      2,
    )}\n`;
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
    // Edited in place, so the file keeps its own trailing newline and layout.
    expect(result.contents!.endsWith('}\n')).toBe(true);
    expect(result.contents!.split('\n')).toHaveLength(source.split('\n').length);
  });

  // A commented, trailing-comma `deno.jsonc` is a legal Deno manifest. It is
  // rewritten in place: only the pinned value changes, so comments, a trailing
  // comma and an alias line all survive.
  it('rewrites a JSONC manifest without losing its comments', () => {
    const source = [
      '{',
      '  // framework pins',
      '  "imports": {',
      '    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0", // core',
      '    "alias": "jsr:@setu-ts/kernel@^0.8.0",',
      '  },',
      '}',
      '',
    ].join('\n');
    const result = rewriteLegacyPins(source, 'deno');
    expect(result.contents).toBe(
      source.replace(
        '"@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0"',
        `"@setu-ts/kernel": "npm:@setu-ts/kernel@^${VERSION}"`,
      ),
    );
    expect(result.rewrites).toHaveLength(1);
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
    for (const source of [
      JSON.stringify({ imports: { '@setu-ts/kernel': `npm:@setu-ts/kernel@^${VERSION}` } }),
      JSON.stringify({ tasks: {} }),
      JSON.stringify({ imports: ['not', 'a', 'map'] }),
      JSON.stringify({ imports: { '@setu-ts/kernel': 3 } }),
    ]) {
      expect(rewriteLegacyPins(source, 'deno'), source).toEqual({
        contents: undefined,
        rewrites: [],
      });
    }
  });

  // M111d audit F4: the rewrite edits only a real entry of a pin section — never
  // a comment that quotes one, never the same key in another section — and it
  // reads a JSON-escaped spelling as the value it decodes to. Each case used to
  // report `moved` while the real pin stayed on JSR.
  describe('edits only real pin entries', () => {
    const PIN = 'jsr:@setu-ts/kernel@^0.8.0';
    const TO = `npm:@setu-ts/kernel@^${VERSION}`;

    it('skips a commented copy that precedes the entry', () => {
      const source = [
        '{',
        `  // "@setu-ts/kernel": "${PIN}",`,
        `  /* "@setu-ts/kernel": "${PIN}" */`,
        `  "imports": { "@setu-ts/kernel": "${PIN}" }`,
        '}',
      ].join('\n');
      const out = rewriteLegacyPins(source, 'deno').contents!;
      expect(out.split('\n').slice(0, 3)).toEqual(source.split('\n').slice(0, 3));
      expect(
        (parseJsonc(out) as { imports: Record<string, string> }).imports['@setu-ts/kernel'],
      ).toBe(TO);
    });

    it('leaves the same key in another section alone', () => {
      const source = JSON.stringify(
        {
          overrides: { '@setu-ts/kernel': 'npm:@jsr/setu-ts__kernel@^0.8.0' },
          dependencies: { '@setu-ts/kernel': 'npm:@jsr/setu-ts__kernel@^0.8.0' },
        },
        null,
        2,
      );
      const out = JSON.parse(rewriteLegacyPins(source, 'npm').contents!) as {
        overrides: Record<string, string>;
        dependencies: Record<string, string>;
      };
      expect(out.overrides['@setu-ts/kernel']).toBe('npm:@jsr/setu-ts__kernel@^0.8.0');
      expect(out.dependencies['@setu-ts/kernel']).toBe(`^${VERSION}`);
    });

    it('rewrites a pin spelled with JSON escapes', () => {
      const source = '{ "imports": { "@setu-ts\\/kernel": "jsr:\\/@setu-ts\\/kernel@^0.8.0" } }';
      const result = rewriteLegacyPins(source, 'deno');
      expect((parseJsonc(result.contents!) as { imports: Record<string, string> }).imports).toEqual(
        { '@setu-ts/kernel': TO },
      );
      expect(result.rewrites).toEqual([
        { name: '@setu-ts/kernel', from: 'jsr:/@setu-ts/kernel@^0.8.0', to: TO },
      ]);
    });

    it('ignores nested values, arrays and non-string entries inside a section', () => {
      const source = JSON.stringify({
        imports: {
          nested: { '@setu-ts/kernel': PIN },
          list: [PIN, { x: 1 }],
          count: 3,
          flag: true,
          '@setu-ts/kernel': PIN,
        },
        other: [PIN],
      });
      const result = rewriteLegacyPins(source, 'deno');
      expect(result.rewrites).toHaveLength(1);
      const out = parseJsonc(result.contents!) as {
        imports: { nested: Record<string, string>; list: unknown[] };
        other: string[];
      };
      expect(out.imports.nested['@setu-ts/kernel']).toBe(PIN);
      expect(out.imports.list[0]).toBe(PIN);
      expect(out.other).toEqual([PIN]);
    });

    it('rewrites every entry of a section, each in its own span', () => {
      const source = JSON.stringify({
        imports: {
          '@setu-ts/kernel': PIN,
          '@setu-ts/runtime': 'jsr:@setu-ts/runtime@^0.8.0',
        },
      });
      const out = parseJsonc(rewriteLegacyPins(source, 'deno').contents!) as {
        imports: Record<string, string>;
      };
      expect(out.imports).toEqual({
        '@setu-ts/kernel': TO,
        '@setu-ts/runtime': `npm:@setu-ts/runtime@^${VERSION}`,
      });
    });
  });

  // Never silent: adoption reports a manifest it could not read, because the
  // project still pins the framework however it did before.
  it('reports a manifest it cannot read, and rewrites nothing', () => {
    for (const source of ['{ not json', '/* unterminated', '[]', 'null', '"text"']) {
      const result = rewriteLegacyPins(source, 'npm');
      expect(result.contents, source).toBeUndefined();
      expect(result.rewrites, source).toEqual([]);
      expect(result.unreadable, source).toEqual(expect.any(String));
    }
  });
});
