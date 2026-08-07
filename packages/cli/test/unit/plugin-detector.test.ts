import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { detectPlugins } from '../../src/utils/plugin-detector.ts';

describe('detectPlugins', () => {
  it('reads the imports map of a Deno project', async () => {
    const fs = createFakeFs({
      '/app/deno.json': JSON.stringify({
        imports: {
          '@setu-ts/kernel': 'jsr:@setu-ts/kernel@^0.1.0-alpha.1',
          '@setu-ts/auth-plugin': 'jsr:@setu-ts/auth-plugin@^0.1.0-alpha.1',
          '@std/expect': 'jsr:@std/expect@^1',
        },
      }),
    });
    const plugins = await detectPlugins(fs, '/app');
    expect([...plugins].sort()).toEqual(['auth-plugin', 'kernel']);
  });

  it('reads dependencies and devDependencies of an npm project', async () => {
    const fs = createFakeFs({
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/kernel': '*', hono: '^4' },
        devDependencies: { '@setu-ts/testing': '*' },
      }),
    });
    const plugins = await detectPlugins(fs, '/app');
    expect([...plugins].sort()).toEqual(['kernel', 'testing']);
  });

  it('falls back to package.json when deno.json has no scoped imports', async () => {
    const fs = createFakeFs({
      '/app/deno.json': JSON.stringify({ imports: { '@std/expect': 'jsr:@std/expect@^1' } }),
      '/app/package.json': JSON.stringify({
        dependencies: { '@setu-ts/cqrs-plugin': '*' },
      }),
    });
    expect([...await detectPlugins(fs, '/app')]).toEqual(['cqrs-plugin']);
  });

  it('returns an empty set when neither manifest exists', async () => {
    expect((await detectPlugins(createFakeFs(), '/app')).size).toBe(0);
  });

  it('returns an empty set for a malformed manifest without throwing', async () => {
    const fs = createFakeFs({ '/app/deno.json': '{ not json' });
    expect((await detectPlugins(fs, '/app')).size).toBe(0);
  });

  it('returns an empty set when a manifest parses to a non-object', async () => {
    const fs = createFakeFs({ '/app/deno.json': '"a string"' });
    expect((await detectPlugins(fs, '/app')).size).toBe(0);
  });

  it('tolerates a manifest with no imports or dependencies key', async () => {
    const fs = createFakeFs({
      '/app/deno.json': JSON.stringify({ tasks: {} }),
      '/app/package.json': JSON.stringify({ name: 'app' }),
    });
    expect((await detectPlugins(fs, '/app')).size).toBe(0);
  });

  it('ignores a non-object imports value', async () => {
    const fs = createFakeFs({ '/app/deno.json': JSON.stringify({ imports: 'nope' }) });
    expect((await detectPlugins(fs, '/app')).size).toBe(0);
  });

  it('ignores subpath and empty specifiers', async () => {
    const fs = createFakeFs({
      '/app/deno.json': JSON.stringify({
        imports: {
          '@setu-ts/runtime/worker': 'jsr:@setu-ts/runtime@^0.1.0-alpha.1/worker',
          '@setu-ts/': 'jsr:@setu-ts/',
          '@setu-ts/cache-plugin': 'jsr:@setu-ts/cache-plugin@^0.1.0-alpha.1',
        },
      }),
    });
    expect([...await detectPlugins(fs, '/app')]).toEqual(['cache-plugin']);
  });
});
