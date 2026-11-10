/* eslint-disable require-await -- Test doubles keep the asynchronous contracts they stand in for. */
/**
 * The Qdrant adapter against a recording client that implements every method
 * of `QdrantClientLike`. Each request body is asserted: the scope rides in a
 * `must` condition on every read and delete, point ids are scope-derived UUIDs,
 * and numbers compare through `range`.
 */
import { describe, expect, it } from 'vitest';
import {
  BackendUnavailableError,
  VectorCollectionMismatchError,
  VectorOperationUnsupportedError,
  VectorVersionConflictError,
  vectorRecordKey,
} from '@setu-ts/common';
import type { IRuntimeServices, VectorCollectionSpec } from '@setu-ts/common';
import { QdrantVectorStore } from '../../src/adapters/qdrant/qdrant-store.ts';
import type { QdrantClientLike } from '../../src/adapters/qdrant/qdrant-store.ts';
import { translate } from '../../src/adapters/qdrant/qdrant-filter.ts';

const runtime = { subtle: globalThis.crypto.subtle } as IRuntimeServices;

it.each([undefined, 7])(
  'M139c slices Qdrant replacements before count/delete (version %s)',
  async (version) => {
    const client = recordingClient();
    const store = new QdrantVectorStore({ client });
    await store.open(runtime);
    const records = Array.from({ length: 1201 }, (_, i) => ({
      id: `r${i}`,
      sourceId: 'source',
      vector: [1, 0, 0],
    }));
    await store.replaceSource(spec, 'tenant-a', 'source', records, version);
    const calls = client.calls.filter((c) => c.method === 'upsert');
    const bodies = calls.map(
      (c) => c.body as { points: { payload: Record<string, unknown> }[]; update_filter?: unknown },
    );
    expect(bodies.map((b) => b.points.length)).toEqual([500, 500, 201]);
    for (const body of bodies) {
      for (const point of body.points) {
        expect(point.payload['scope']).toBe('tenant-a');
      }
      if (version === undefined) expect(body).not.toHaveProperty('update_filter');
      else
        expect(body.update_filter).toEqual({
          must_not: [
            {
              must: [
                { key: 'source_id', match: { value: 'source' } },
                { key: 'source_version', range: { gt: version } },
              ],
            },
          ],
        });
    }
    expect(client.calls.filter((c) => c.method === 'delete')).toHaveLength(1);
    expect(client.calls.at(-1)!.method).toBe('delete');
    expect(JSON.stringify(client.calls.at(-1)!.body)).toContain('tenant-a');
    expect(client.calls.filter((c) => c.method === 'count')).toHaveLength(
      version === undefined ? 0 : 1,
    );
  },
);
const spec: VectorCollectionSpec = Object.freeze({
  name: 'documents',
  dimensions: 3,
  filterable: Object.freeze({ tag: 'string', year: 'number', public: 'boolean' }),
});

type Call = {
  readonly method: keyof QdrantClientLike;
  readonly name: string;
  readonly body?: unknown;
};

function recordingClient(
  options: {
    exists?: boolean;
    vectors?: unknown;
    points?: unknown;
    fail?: Error;
    /** Points `count` reports, e.g. a newer version already stored. */
    count?: number;
    /** The server version `versionInfo` reports. */
    serverVersion?: string;
    /** Rejections for `versionInfo`, consumed one per call. */
    versionFailures?: Error[];
  } = {},
): QdrantClientLike & { readonly calls: Call[] } {
  const calls: Call[] = [];
  const record = (method: keyof QdrantClientLike, name: string, body?: unknown) => {
    calls.push({ method, name, ...(body === undefined ? {} : { body }) });
    if (options.fail !== undefined) throw options.fail;
  };
  return {
    calls,
    async collectionExists(name: string) {
      record('collectionExists', name);
      return { exists: options.exists ?? false };
    },
    async getCollection(name: string) {
      record('getCollection', name);
      return { config: { params: { vectors: options.vectors } } };
    },
    async createCollection(name: string, body: Record<string, unknown>) {
      record('createCollection', name, body);
      return true;
    },
    async createPayloadIndex(name: string, body: Record<string, unknown>) {
      record('createPayloadIndex', name, body);
      return {};
    },
    async upsert(name: string, body: Record<string, unknown>) {
      record('upsert', name, body);
      return {};
    },
    async query(name: string, body: Record<string, unknown>) {
      record('query', name, body);
      return { points: options.points ?? [] };
    },
    async delete(name: string, body: Record<string, unknown>) {
      record('delete', name, body);
      return {};
    },
    async count(name: string, body: Record<string, unknown>) {
      record('count', name, body);
      return { count: options.count ?? 0 };
    },
    async versionInfo() {
      record('versionInfo', '');
      const failure = options.versionFailures?.shift();
      if (failure !== undefined) throw failure;
      return { version: options.serverVersion ?? '1.20.0' };
    },
  };
}

async function uuidFor(scope: string, id: string): Promise<string> {
  const hex = await vectorRecordKey(runtime.subtle, scope, id);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

async function opened(client = recordingClient()) {
  const store = new QdrantVectorStore({ client });
  await store.open(runtime);
  return { store, client };
}

describe('QdrantVectorStore', () => {
  it('refuses a client missing a method', () => {
    expect(() => new QdrantVectorStore({ client: {} as never })).toThrow(
      'missing collectionExists',
    );
    expect(() => new QdrantVectorStore(undefined as never)).toThrow('missing client');
  });

  it('refuses a call before open()', async () => {
    const store = new QdrantVectorStore({ client: recordingClient() });
    await expect(store.delete(spec, 't', ['r'])).rejects.toThrow('open() must run');
  });

  it('creates a cosine collection with tenant, source and field indexes', async () => {
    const { store, client } = await opened();
    await store.ensureCollection(spec);
    expect(client.calls).toEqual([
      { method: 'collectionExists', name: 'vs_documents' },
      {
        method: 'createCollection',
        name: 'vs_documents',
        body: { vectors: { size: 3, distance: 'Cosine' } },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: {
          field_name: 'scope',
          field_schema: { type: 'keyword', is_tenant: true },
          wait: true,
        },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: { field_name: 'source_id', field_schema: 'keyword', wait: true },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: { field_name: 'source_version', field_schema: 'integer', wait: true },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: { field_name: 'metadata.tag', field_schema: 'keyword', wait: true },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: { field_name: 'metadata.year', field_schema: 'float', wait: true },
      },
      {
        method: 'createPayloadIndex',
        name: 'vs_documents',
        body: { field_name: 'metadata.public', field_schema: 'bool', wait: true },
      },
    ]);
  });

  it('verifies an existing collection and refuses a mismatch', async () => {
    const good = await opened(
      recordingClient({ exists: true, vectors: { size: 3, distance: 'Cosine' } }),
    );
    await good.store.ensureCollection({ name: 'plain', dimensions: 3 });
    expect(good.client.calls.map((c) => c.method)).toEqual([
      'collectionExists',
      'getCollection',
      'createPayloadIndex',
      'createPayloadIndex',
      'createPayloadIndex',
    ]);
    for (const vectors of [
      { size: 4, distance: 'Cosine' },
      { size: 3, distance: 'Dot' },
      undefined,
    ]) {
      const bad = await opened(recordingClient({ exists: true, vectors }));
      await expect(bad.store.ensureCollection(spec)).rejects.toThrow(VectorCollectionMismatchError);
    }
  });

  it('upserts scope-derived UUIDs with the original id and scope in the payload', async () => {
    const { store, client } = await opened();
    await store.upsert(spec, 'tenant-a', [
      { id: 'r1', vector: [1, 0, 0], sourceId: 's1', content: 'text', metadata: { tag: 'x' } },
      { id: 'r2', vector: [0, 1, 0], metadata: {} },
    ]);
    const [call] = client.calls;
    expect(call!.method).toBe('upsert');
    expect(call!.body).toEqual({
      wait: true,
      points: [
        {
          id: await uuidFor('tenant-a', 'r1'),
          vector: [1, 0, 0],
          payload: {
            scope: 'tenant-a',
            id: 'r1',
            source_id: 's1',
            content: 'text',
            metadata: { tag: 'x' },
          },
        },
        {
          id: await uuidFor('tenant-a', 'r2'),
          vector: [0, 1, 0],
          payload: { scope: 'tenant-a', id: 'r2', metadata: {} },
        },
      ],
    });
    expect(await uuidFor('tenant-a', 'r1')).not.toBe(await uuidFor('tenant-b', 'r1'));
    expect(await uuidFor('tenant-a', 'r1')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('replaceSource upserts, then deletes that source’s other points in the scope', async () => {
    const { store, client } = await opened();
    await store.replaceSource(spec, 'tenant-a', 's1', [
      { id: 'r1', vector: [1, 0, 0], sourceId: 's1' },
    ]);
    expect(client.calls.map((c) => c.method)).toEqual(['upsert', 'delete']);
    expect(client.calls[1]!.body).toEqual({
      wait: true,
      filter: {
        must: [
          { key: 'scope', match: { value: 'tenant-a' } },
          { key: 'source_id', match: { value: 's1' } },
        ],
        must_not: [{ has_id: [await uuidFor('tenant-a', 'r1')] }],
      },
    });
    client.calls.length = 0;
    await store.replaceSource(spec, 'tenant-a', 's1', []);
    expect(client.calls.map((c) => c.method)).toEqual(['delete']);
    expect(client.calls[0]!.body).toEqual({
      wait: true,
      filter: {
        must: [
          { key: 'scope', match: { value: 'tenant-a' } },
          { key: 'source_id', match: { value: 's1' } },
        ],
      },
    });
  });

  describe('versioned replaceSource', () => {
    const source = [
      { key: 'scope', match: { value: 'tenant-a' } },
      { key: 'source_id', match: { value: 's1' } },
    ];
    const newer = { key: 'source_version', range: { gt: 5 } };
    const record = { id: 'r1', vector: [1, 0, 0], sourceId: 's1' } as const;

    it('upserts under a filter that keeps newer points, checks, then deletes only older stale ids', async () => {
      const { store, client } = await opened();
      await store.replaceSource(spec, 'tenant-a', 's1', [record], 5);
      expect(client.calls.map((c) => c.method)).toEqual([
        'versionInfo',
        'upsert',
        'count',
        'delete',
      ]);
      const upsert = client.calls[1]!.body as {
        points: { payload: Record<string, unknown> }[];
        update_filter: unknown;
      };
      expect(upsert.update_filter).toEqual({ must_not: [{ must: [source[1], newer] }] });
      expect(upsert.points[0]!.payload['source_version']).toBe(5);
      expect(client.calls[2]!.body).toEqual({ exact: true, filter: { must: [...source, newer] } });
      expect(client.calls[3]!.body).toEqual({
        wait: true,
        filter: { must: source, must_not: [newer, { has_id: [await uuidFor('tenant-a', 'r1')] }] },
      });
      // The server version is probed once.
      client.calls.length = 0;
      await store.replaceSource(spec, 'tenant-a', 's1', [], 5);
      expect(client.calls.map((c) => c.method)).toEqual(['count', 'delete']);
      expect(client.calls[1]!.body).toEqual({
        wait: true,
        filter: { must: source, must_not: [newer] },
      });
    });

    it('removes its own older points and refuses when a newer version is already stored', async () => {
      const { store, client } = await opened(recordingClient({ count: 2 }));
      await expect(store.replaceSource(spec, 'tenant-a', 's1', [record], 5)).rejects.toThrow(
        VectorVersionConflictError,
      );
      expect(client.calls.map((c) => c.method)).toEqual([
        'versionInfo',
        'upsert',
        'count',
        'delete',
      ]);
      expect(client.calls[3]!.body).toEqual({
        wait: true,
        filter: { must: source, must_not: [newer] },
      });
    });

    it('refuses a versioned write on a server older than 1.16, before writing anything', async () => {
      for (const serverVersion of ['1.15.4', '0.11.0', 'dev']) {
        const { store, client } = await opened(recordingClient({ serverVersion }));
        await expect(store.replaceSource(spec, 'tenant-a', 's1', [record], 5)).rejects.toThrow(
          VectorOperationUnsupportedError,
        );
        expect(client.calls.map((c) => c.method)).toEqual(['versionInfo']);
      }
      for (const serverVersion of ['1.16.0', '2.0.0']) {
        const { store } = await opened(recordingClient({ serverVersion }));
        await expect(
          store.replaceSource(spec, 'tenant-a', 's1', [record], 5),
        ).resolves.toBeUndefined();
      }
    });

    it('probes the server version again after a failed probe', async () => {
      const unreachable = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), {
        code: 'ECONNREFUSED',
      });
      const { store, client } = await opened(recordingClient({ versionFailures: [unreachable] }));
      await expect(store.replaceSource(spec, 'tenant-a', 's1', [record], 5)).rejects.toThrow(
        BackendUnavailableError,
      );
      await store.replaceSource(spec, 'tenant-a', 's1', [record], 5);
      expect(client.calls.filter((c) => c.method === 'versionInfo')).toHaveLength(2);
    });
  });

  it('queries with the scope and filter in must, maps payloads, and orders ties by id', async () => {
    const { store, client } = await opened(
      recordingClient({
        points: [
          { score: 0.5, payload: { id: 'b', metadata: { tag: 'x' } } },
          {
            score: 0.5,
            payload: { id: 'a', source_id: 's1', content: 'text', metadata: { tag: 'x' } },
          },
          { score: 0.9, payload: { id: 'c' } },
          { id: 'raw-point', score: 0.1, payload: null },
        ],
      }),
    );
    const matches = await store.query(spec, 'tenant-a', {
      vector: [1, 0, 0],
      topK: 3,
      minScore: 0.2,
      filter: { field: 'tag', op: 'eq', value: 'x' },
    });
    expect(matches).toEqual([
      { id: 'c', score: 0.9, metadata: {} },
      { id: 'a', score: 0.5, sourceId: 's1', content: 'text', metadata: { tag: 'x' } },
      { id: 'b', score: 0.5, metadata: { tag: 'x' } },
      { id: 'raw-point', score: 0.1, metadata: {} },
    ]);
    expect(client.calls[0]!.body).toEqual({
      query: [1, 0, 0],
      filter: {
        must: [
          { key: 'scope', match: { value: 'tenant-a' } },
          { key: 'metadata.tag', match: { value: 'x' } },
        ],
      },
      limit: 3,
      with_payload: true,
      score_threshold: 0.2,
    });
    await store.query(spec, 'tenant-a', { vector: [1, 0, 0], topK: 1 });
    expect(client.calls[1]!.body).not.toHaveProperty('score_threshold');
  });

  it('answers no points as no matches', async () => {
    const client = recordingClient();
    (client as { query: QdrantClientLike['query'] }).query = async () => ({});
    const { store } = await opened(client);
    expect(await store.query(spec, 't', { vector: [1, 0, 0], topK: 1 })).toEqual([]);
  });

  it('deletes ids and scopes through scoped filters', async () => {
    const { store, client } = await opened();
    await store.delete(spec, 'tenant-a', ['r1']);
    await store.deleteScope(spec, 'tenant-a');
    expect(client.calls.map((c) => c.body)).toEqual([
      {
        wait: true,
        filter: {
          must: [
            { key: 'scope', match: { value: 'tenant-a' } },
            { has_id: [await uuidFor('tenant-a', 'r1')] },
          ],
        },
      },
      { wait: true, filter: { must: [{ key: 'scope', match: { value: 'tenant-a' } }] } },
    ]);
  });

  it('turns a connection failure into a backend fault and rethrows anything else', async () => {
    const refused = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6333'), {
        code: 'ECONNREFUSED',
      }),
    });
    const down = await opened(recordingClient({ fail: refused }));
    await expect(down.store.deleteScope(spec, 't')).rejects.toThrow(BackendUnavailableError);
    const broken = await opened(recordingClient({ fail: new Error('Bad Request') }));
    await expect(broken.store.deleteScope(spec, 't')).rejects.toThrow('Bad Request');
  });

  it('calls onClose once and never closes the client', async () => {
    let closed = 0;
    const store = new QdrantVectorStore({
      client: recordingClient(),
      onClose: () => void closed++,
    });
    await store.close();
    await new QdrantVectorStore({ client: recordingClient() }).close();
    expect(closed).toBe(1);
  });
});

describe('qdrant filter translation', () => {
  it('compares numbers through range and strings through match', () => {
    expect(translate({ field: 'year', op: 'eq', value: 2020 })).toEqual({
      key: 'metadata.year',
      range: { gte: 2020, lte: 2020 },
    });
    expect(translate({ field: 'public', op: 'eq', value: true })).toEqual({
      key: 'metadata.public',
      match: { value: true },
    });
    expect(translate({ field: 'tag', op: 'in', value: ['a', 'b'] })).toEqual({
      key: 'metadata.tag',
      match: { any: ['a', 'b'] },
    });
    expect(translate({ field: 'year', op: 'in', value: [1, 2] })).toEqual({
      should: [
        { key: 'metadata.year', range: { gte: 1, lte: 1 } },
        { key: 'metadata.year', range: { gte: 2, lte: 2 } },
      ],
    });
    for (const op of ['gt', 'gte', 'lt', 'lte'] as const) {
      expect(translate({ field: 'year', op, value: 5 })).toEqual({
        key: 'metadata.year',
        range: { [op]: 5 },
      });
    }
    expect(
      translate({
        and: [
          { field: 'tag', op: 'eq', value: 'x' },
          { field: 'year', op: 'gt', value: 1 },
        ],
      }),
    ).toEqual({
      must: [
        { key: 'metadata.tag', match: { value: 'x' } },
        { key: 'metadata.year', range: { gt: 1 } },
      ],
    });
  });

  it('throws on an operator outside the filter type rather than skipping it', () => {
    expect(() => translate({ field: 'tag', op: 'contains', value: 'x' } as never)).toThrow(
      "unsupported filter operator 'contains'",
    );
  });
});
