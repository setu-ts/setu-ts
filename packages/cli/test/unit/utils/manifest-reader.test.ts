import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { readJsonManifest } from '../../../src/utils/manifest-reader.ts';

describe('readJsonManifest', () => {
  it('reads JSON and reports its format', async () => {
    const result = await readJsonManifest(
      createFakeFs({ '/app/deno.json': '{"imports":{}}' }),
      '/app/deno.json',
    );
    expect(result).toEqual({ kind: 'ok', value: { imports: {} }, format: 'json' });
  });

  it('reads comments and trailing commas without stripping comment-like strings', async () => {
    const source = `{
      // line comment
      "url": "https://example.test/a//b",
      "escaped": "quote: \\" and slash: \\\\ // still a string",
      "nested": { /* block
        comment */ "items": [1, 2,], },
    }`;
    const result = await readJsonManifest(
      createFakeFs({ '/app/deno.jsonc': source }),
      '/app/deno.jsonc',
    );
    expect(result).toEqual({
      kind: 'ok',
      value: {
        url: 'https://example.test/a//b',
        escaped: 'quote: " and slash: \\ // still a string',
        nested: { items: [1, 2] },
      },
      format: 'jsonc',
    });
  });

  it('distinguishes missing and malformed files', async () => {
    expect(await readJsonManifest(createFakeFs(), '/missing')).toEqual({ kind: 'missing' });
    const malformed = await readJsonManifest(createFakeFs({ '/bad': '{ nope' }), '/bad');
    expect(malformed.kind).toBe('unreadable');
    const unterminated = await readJsonManifest(
      createFakeFs({ '/bad': '{ "ok": true } /*' }),
      '/bad',
    );
    expect(unterminated.kind).toBe('unreadable');
  });
});
