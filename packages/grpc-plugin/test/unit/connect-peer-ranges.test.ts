/** The published minimum must support the wire-error flag used for discovery outcomes. @module */
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it.skipIf(typeof Deno !== 'undefined')(
  'requires Connect 2.2.0 in both Node declarations and every Deno subpath',
  async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of ['@connectrpc/connect', '@connectrpc/connect-node']) {
      expect(manifest.peerDependencies[name]).toBe('^2.2.0');
      expect(manifest.devDependencies[name]).toBe('^2.2.0');
    }
    const deno = JSON.parse(
      await readFile(new URL('../../deno.json', import.meta.url), 'utf8'),
    ) as {
      imports: Record<string, string>;
    };
    const peers = Object.entries(deno.imports).filter(([name]) => name.startsWith('@connectrpc/'));
    expect(peers).toHaveLength(5);
    for (const [name, specifier] of peers) expect(specifier, name).toContain('@^2.2.0');
  },
);
