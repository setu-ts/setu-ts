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

describe('SDK realtime module imports', () => {
  it('keeps every common import type-only for direct Node and Bun source loading', async () => {
    for (const module of MODULES) {
      const source = await Deno.readTextFile(
        new URL(`../../src/realtime/${module}`, import.meta.url),
      );
      expect(source).not.toMatch(/import\s+\{[^}]*\}\s+from\s+['"]@setu-ts\/common['"]/);
    }
  });
});
