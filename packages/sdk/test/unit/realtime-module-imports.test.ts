/** Guards Node/Bun source loading from accidental common value imports. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const MODULES = [
  'sse-contracts.ts',
  'sse-frame-parser.ts',
  'sse-client.ts',
  'websocket-contracts.ts',
  'realtime-client.ts',
] as const;

/**
 * Every `import ... from '<specifier>'`, capturing whether it is type-only.
 *
 * The specifier is matched by SUBSTRING rather than exact text: this package
 * spells the dependency `jsr:@setu-ts/common@^0.2.0`, so a pattern
 * anchored on the bare `@setu-ts/common` would miss every import the SDK
 * actually writes and the guard would pass whatever was added.
 */
const IMPORT = /import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g;

/** Lists non-type imports of `@setu-ts/common` in one module's source. */
export function valueImportsOfCommon(source: string): readonly string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT)) {
    const [, typeOnly, specifier] = match;
    if (specifier?.includes('@setu-ts/common') && typeOnly === undefined) {
      found.push(specifier);
    }
  }
  return found;
}

describe('SDK realtime module imports', () => {
  it('keeps every common import type-only for direct Node and Bun source loading', async () => {
    for (const module of MODULES) {
      const source = await Deno.readTextFile(
        new URL(`../../src/realtime/${module}`, import.meta.url),
      );
      expect(valueImportsOfCommon(source)).toEqual([]);
    }
  });

  it('detects a value import written the way this package spells the dependency', () => {
    // Without this case the guard passes vacuously: the realtime modules import
    // nothing from common today, so an always-false matcher looks identical to
    // a working one.
    expect(
      valueImportsOfCommon(
        "import { CAPABILITIES } from 'jsr:@setu-ts/common@^0.2.0';",
      ),
    ).toEqual(['jsr:@setu-ts/common@^0.2.0']);
    expect(
      valueImportsOfCommon("import type { IRequest } from 'jsr:@setu-ts/common@^0.2.0';"),
    ).toEqual([]);
  });
});
