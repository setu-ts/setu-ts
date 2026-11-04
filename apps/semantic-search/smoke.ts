/**
 * The example through its real composition: documents are queued, indexed by
 * the job and searched per tenant. The deterministic cases replace the
 * embedding model with `MockEmbeddingModelV4`; `PGVECTOR_URL` reruns them on
 * pgvector, and a reachable `EMBED_BASE_URL` (default llama.cpp on 8081) adds
 * one case against the real model.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockEmbeddingModelV4 } from 'ai/test';
import { CAPABILITIES } from '@setu-ts/common';
import type { IVectorStore } from '@setu-ts/common';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from './setu.config.ts';
import { EMBEDDINGS } from './src/plugins/embeddings.plugin.ts';
import type { IEmbeddingsService } from './src/plugins/embeddings.plugin.ts';
import { DocumentsSearchResponse } from './src/modules/documents/documents.schemas.ts';

const DIMENSIONS = 1024;
const RUN = crypto.randomUUID().slice(0, 8);
const EMBED_BASE_URL = process.env.EMBED_BASE_URL ?? 'http://localhost:8081/v1';
const live = await fetch(`${EMBED_BASE_URL}/models`, { signal: AbortSignal.timeout(2_000) })
  .then((res) => res.ok)
  .catch(() => false);

/** Ids are unique per run, so a shared pgvector database never mixes runs. */
function id(name: string): string {
  return `${name}-${RUN}`;
}

/** Maps each text to one axis chosen by its first word, so scores are exact. */
function axisModel(dimensions = DIMENSIONS): MockEmbeddingModelV4 {
  const axes = ['cats', 'dogs', 'tax'];
  return new MockEmbeddingModelV4({
    doEmbed: ({ values }) =>
      Promise.resolve({
        embeddings: values.map((value) => {
          const vector = new Array<number>(dimensions).fill(0);
          const index = axes.indexOf(value.split(' ')[0]!.toLowerCase());
          vector[index === -1 ? dimensions - 1 : index] = 1;
          return vector;
        }),
        warnings: [],
      }),
  });
}

async function appWith(model?: MockEmbeddingModelV4, pgvector = false) {
  const previous = process.env.PGVECTOR_URL;
  if (!pgvector) delete process.env.PGVECTOR_URL;
  try {
    return await createTestApp({
      app: createApp(),
      without: ['logger-plugin'],
      overrides:
        model === undefined
          ? []
          : [overrideCapability(EMBEDDINGS, { model } satisfies IEmbeddingsService)],
    });
  } finally {
    if (previous !== undefined) process.env.PGVECTOR_URL = previous;
  }
}

type App = Awaited<ReturnType<typeof appWith>>;

function ingest(app: App, tenant: string, body: { id: string; text: string; tag?: string }) {
  return app.inject({
    method: 'POST',
    url: '/documents',
    headers: { 'x-tenant-id': tenant },
    body,
  });
}

async function search(app: App, tenant: string, q: string, tag?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/documents/search?q=${encodeURIComponent(q)}${tag === undefined ? '' : `&tag=${tag}`}`,
    headers: { 'x-tenant-id': tenant },
  });
  assert.equal(res.statusCode, 200, res.body ?? undefined);
  return DocumentsSearchResponse.parse(res.json()).matches;
}

/** Ingestion runs on the in-process queue; poll until `done` holds, with a deadline. */
async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const value = await read();
    if (done(value) || performance.now() > deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function scenarios(pgvector: boolean) {
  it('indexes in the background, searches by meaning and filters by tag', async () => {
    const app = await appWith(axisModel(), pgvector);
    try {
      assert.equal(
        (await ingest(app, 'acme', { id: id('pets'), text: 'cats purr', tag: 'pets' })).statusCode,
        202,
      );
      assert.equal(
        (await ingest(app, 'acme', { id: id('money'), text: 'tax is due', tag: 'finance' }))
          .statusCode,
        202,
      );
      const matches = await eventually(
        () => search(app, 'acme', 'cats'),
        (found) => found.length >= 2,
      );
      assert.deepEqual(matches[0], {
        documentId: id('pets'),
        chunk: 'cats purr',
        score: 1,
        tag: 'pets',
      });
      assert.deepEqual(
        (await search(app, 'acme', 'cats', 'finance')).map((m) => m.documentId),
        [id('money')],
      );
    } finally {
      await app.services
        .get<IVectorStore>(CAPABILITIES.VECTOR_STORE)
        .deleteScope('documents', 'acme');
      await app.stop();
    }
  });

  it('keeps tenants apart and refuses a request without one', async () => {
    const app = await appWith(axisModel(), pgvector);
    try {
      await ingest(app, 'acme', { id: id('shared'), text: 'dogs bark' });
      await ingest(app, 'globex', { id: id('shared'), text: 'cats nap' });
      const acme = await eventually(
        () => search(app, 'acme', 'dogs'),
        (m) => m.length > 0,
      );
      const globex = await eventually(
        () => search(app, 'globex', 'dogs'),
        (m) => m.length > 0,
      );
      assert.deepEqual(
        acme.map((m) => m.chunk),
        ['dogs bark'],
      );
      assert.deepEqual(
        globex.map((m) => m.chunk),
        ['cats nap'],
      );
      const tenantless = await app.inject({ method: 'GET', url: '/documents/search?q=dogs' });
      assert.equal(tenantless.statusCode, 400);
      const unknown = await app.inject({
        method: 'GET',
        url: '/documents/search?q=dogs',
        headers: { 'x-tenant-id': 'initech' },
      });
      assert.equal(unknown.statusCode, 404);
    } finally {
      const store = app.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      await store.deleteScope('documents', 'acme');
      await store.deleteScope('documents', 'globex');
      await app.stop();
    }
  });

  it('re-ingesting a shorter document leaves exactly its new chunks', async () => {
    const app = await appWith(axisModel(), pgvector);
    try {
      const long = Array.from({ length: 3 }, () => `cats ${'word '.repeat(150)}`).join(' ');
      await ingest(app, 'acme', { id: id('essay'), text: long });
      const before = await eventually(
        () => search(app, 'acme', 'cats'),
        (m) => m.length > 1,
      );
      assert.ok(before.length > 1);
      await ingest(app, 'acme', { id: id('essay'), text: 'cats only' });
      const after = await eventually(
        () => search(app, 'acme', 'cats'),
        (m) => m.length === 1,
      );
      assert.deepEqual(
        after.map((m) => m.chunk),
        ['cats only'],
      );
    } finally {
      await app.services
        .get<IVectorStore>(CAPABILITIES.VECTOR_STORE)
        .deleteScope('documents', 'acme');
      await app.stop();
    }
  });
}

describe('semantic search (memory)', () => {
  scenarios(false);

  it('refuses a filter on an undeclared field instead of ignoring it', async () => {
    const app = await appWith(axisModel());
    try {
      const store = app.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      await assert.rejects(
        store.query('documents', 'acme', {
          vector: new Array<number>(DIMENSIONS).fill(1),
          topK: 1,
          filter: { field: 'author', op: 'eq', value: 'x' },
        }),
        { name: 'VectorFilterError' },
      );
    } finally {
      await app.stop();
    }
  });

  it('refuses vectors of the wrong length from a mismatched model', async () => {
    const app = await appWith(axisModel(3));
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/documents/search?q=cats',
        headers: { 'x-tenant-id': 'acme' },
      });
      assert.equal(res.statusCode, 400);
    } finally {
      await app.stop();
    }
  });
});

describe(
  'semantic search (pgvector)',
  { skip: process.env.PGVECTOR_URL === undefined && 'set PGVECTOR_URL' },
  () => {
    scenarios(true);
  },
);

describe(
  'semantic search (live model)',
  { skip: !live && `no embedding server at ${EMBED_BASE_URL}` },
  () => {
    it('ranks the document about the query first', async () => {
      const app = await appWith();
      try {
        await ingest(app, 'acme', {
          id: id('cooking'),
          text: 'Simmer the tomatoes with garlic and basil for twenty minutes.',
        });
        await ingest(app, 'acme', {
          id: id('networking'),
          text: 'TCP retransmits a segment when its acknowledgement does not arrive in time.',
        });
        const matches = await eventually(
          () => search(app, 'acme', 'how do I make pasta sauce'),
          (found) => found.length >= 2,
        );
        assert.equal(matches[0]!.documentId, id('cooking'));
      } finally {
        await app.services
          .get<IVectorStore>(CAPABILITIES.VECTOR_STORE)
          .deleteScope('documents', 'acme');
        await app.stop();
      }
    });
  },
);
