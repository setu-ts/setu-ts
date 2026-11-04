import { describe, it } from 'node:test';
import assert from 'node:assert';
import { MockEmbeddingModelV4 } from 'ai/test';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from '../../../setu.config.ts';
import { EMBEDDINGS } from '../../plugins/embeddings.plugin.ts';
import type { IEmbeddingsService } from '../../plugins/embeddings.plugin.ts';
import { splitText } from './documents.service.ts';

// These tests use the memory store; `npm run smoke` covers pgvector.
delete process.env['PGVECTOR_URL'];

/** A deterministic model: each text maps to a fixed axis by its first word. */
function axisModel(): MockEmbeddingModelV4 {
  const axes = ['cats', 'dogs', 'tax'];
  return new MockEmbeddingModelV4({
    doEmbed: ({ values }) =>
      Promise.resolve({
        embeddings: values.map((value) => {
          const vector = new Array<number>(1024).fill(0);
          const index = axes.indexOf(value.split(' ')[0]!.toLowerCase());
          vector[index === -1 ? 1023 : index] = 1;
          return vector;
        }),
        warnings: [],
      }),
  });
}

async function searchUntil(
  app: Awaited<ReturnType<typeof createTestApp>>,
  tenant: string,
  q: string,
  expected: number,
) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const res = await app.inject({
      method: 'GET',
      url: `/documents/search?q=${encodeURIComponent(q)}`,
      headers: { 'x-tenant-id': tenant },
    });
    const body = res.json<{ matches: { documentId: string; chunk: string }[] }>();
    if (body.matches.length >= expected || Date.now() > deadline) return body.matches;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('documents module', () => {
  it('indexes a document in the background and finds it for its own tenant only', async () => {
    const app = await createTestApp({
      app: await createApp(),
      overrides: [
        overrideCapability(EMBEDDINGS, { model: axisModel() } satisfies IEmbeddingsService),
      ],
    });
    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/documents',
        headers: { 'x-tenant-id': 'acme' },
        body: { id: 'pets', text: 'cats sleep all day', tag: 'animals' },
      });
      assert.deepStrictEqual(accepted.statusCode, 202);
      const matches = await searchUntil(app, 'acme', 'cats', 1);
      assert.deepStrictEqual(
        matches.map((m) => [m.documentId, m.chunk]),
        [['pets', 'cats sleep all day']],
      );
      assert.deepStrictEqual(await searchUntil(app, 'globex', 'cats', 1), []);
      const tenantless = await app.inject({ method: 'GET', url: '/documents/search?q=cats' });
      assert.deepStrictEqual(tenantless.statusCode, 400);
    } finally {
      await app.stop();
    }
  });

  it('splits on word boundaries and cuts a word longer than a chunk', () => {
    assert.deepStrictEqual(splitText('  a  b '), ['a b']);
    const long = 'x'.repeat(1_700);
    assert.deepStrictEqual(
      splitText(`start ${long}`).map((chunk) => chunk.length),
      [5, 800, 800, 100],
    );
  });
});
