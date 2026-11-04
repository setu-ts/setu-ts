# Retrieval (vector search)

`@setu-ts/vector-store-plugin` stores embeddings and returns the closest ones inside a tenant. Two
rules separate it from a generic vector library:

- **The tenant scope is a required argument.** Every data method takes it second, so a call cannot
  be written without one. Each adapter maps it to its strongest native boundary.
- **A filter is refused, never ignored.** Only declared metadata fields may be filtered, with a
  small operator set. A clause the backend cannot honour throws instead of matching everything.

The store takes vectors. It does not embed text: embed chunks and queries with the AI SDK and pass
the vectors in. This guide covers the plugin, the three adapters it ships, the Cloudflare Workers
adapter in `@setu-ts/cloudflare-plugin`, and how the `semantic-search` example puts them together.
All of it is available from **0.12.0**.

## Install and compose

```bash
npm install @setu-ts/vector-store-plugin
# Deno: deno add npm:@setu-ts/vector-store-plugin
```

`setu add vector-store` installs the package and prints the registration; it does not insert one,
because collections and the adapter's client belong to the application.

Compose the plugin after the multi-tenancy plugin. Collections are validated when the plugin is
created, and the adapter creates or verifies them during registration, so a bad backend fails
startup rather than the first request.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MemoryVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';

export const app = createApplication({
  plugins: [
    RuntimePlugin(),
    MultiTenancyPlugin({ resolver: 'header', tenants: ['acme', 'globex'] }),
    VectorStorePlugin({
      adapter: new MemoryVectorStore(),
      collections: [
        { name: 'documents', dimensions: 1024, filterable: { tag: 'string', year: 'number' } },
      ],
    }),
  ],
});
```

## Declare collections

| Property      | Rule                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `name`        | `^[a-z][a-z0-9_]{0,39}$`, unique per application                          |
| `dimensions`  | Integer 1–4,096; an adapter may support fewer and refuses at registration |
| `filterable?` | At most 10 fields, each declared `'string'`, `'number'` or `'boolean'`    |

A field name matches `^[a-z][a-z0-9_]{0,63}$` and may not be `scope`, `id`, `source_id` or
`content`, which the adapters use internally. Declaring a field is what makes it filterable and what
makes it legal in a record's metadata. An undeclared collection in a call throws
`VectorCollectionUnknownError` before any backend I/O.

Dimensions must match the embedding model exactly. A model that returns another length is a
configuration error, and the first write fails rather than storing incomparable vectors.

## Write, replace and delete

`upsert(collection, scope, records)` inserts or replaces by `(scope, id)`. One call takes at most
500 records and may not name the same id twice.

`replaceSource(collection, scope, sourceId, records)` is the re-ingestion primitive. It writes the
source's new records, then deletes that source's other records in the same scope. Every record must
carry the same `sourceId`. Re-running an ingestion with the same chunk ids leaves one copy, and a
document that shrank leaves no stale chunk behind. A record id already used by another source in the
scope is reassigned to this source; it never leaves the tenant.

`delete(collection, scope, ids)` takes at most 1,000 ids. `deleteScope(collection, scope)` removes
every record of one tenant in the collection, for offboarding.

## Search

`query(collection, scope, { vector, topK, filter?, minScore? })` returns at most `topK` matches,
ordered by cosine similarity descending and then by record id ascending. That tie-break is defined
on every adapter. `score` is in `[-1, 1]`; `minScore` drops lower matches on the same scale. An
adapter may return fewer than `topK`, including under a selective filter.

A tenant's route takes its scope from `scopeFor`, which reads the tenant resolved by the
multi-tenancy middleware:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext, IRequestContext, IVectorStore } from '@setu-ts/common';

export function documentsPlugin(): IPlugin {
  return {
    name: 'documents-routes',
    version: '1.0.0',
    dependencies: [CAPABILITIES.VECTOR_STORE],
    register(ctx: IPluginContext): void {
      const store = ctx.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      ctx.router.post('/documents', async (c: IRequestContext) => {
        const body = await c.request.json<{ id: string; vector: number[]; tag: string }>();
        await store.upsert('documents', store.scopeFor(c), [
          { id: body.id, vector: body.vector, metadata: { tag: body.tag } },
        ]);
        return c.response.status(204).send();
      });
      ctx.router.get('/documents/search', async (c: IRequestContext) => {
        const matches = await store.query('documents', store.scopeFor(c), {
          vector: [0.1, 0.2],
          topK: 5,
          filter: { field: 'tag', op: 'eq', value: 'release' },
        });
        return c.response.json(matches);
      });
    },
  };
}
```

A request with no tenant answers 400 (`VectorScopeRequiredError`) before the adapter is called.

## Tenancy

`tenancy: 'required'` is the default: `scopeFor` returns `ctx.request.tenant.id` and throws when the
request has none. `tenancy: { fixed: 'shared' }` returns that scope for every request, tenant or not
— the mode for a store opened without multi-tenancy. It is not a way to mix tenants in one scope.

A scope is a non-empty, well-formed string of at most 64 UTF-8 bytes; anything else throws
`VectorScopeInvalidError`. Each adapter maps it to a native boundary:

| Adapter   | Boundary                                                                |
| --------- | ----------------------------------------------------------------------- |
| memory    | a map keyed by scope, then record id                                    |
| pgvector  | a `scope` column in the table's primary key, and in every statement     |
| Qdrant    | a `scope` keyword payload index marked `is_tenant`, and a `must` filter |
| Vectorize | the namespace                                                           |

A queue job runs outside a request, so it resolves its own scope. Validate the tenant id with
`IMultiTenancyService.lookupTenant` and pass `found.value.id` to the store. A job whose tenant was
removed after the request was queued should write nothing. The
[`semantic-search` example](https://github.com/setu-ts/setu-ts/blob/main/apps/semantic-search/README.md)
shows the whole path: route, queue job, re-check, chunk, embed, `replaceSource`.

## Filters

A filter is a comparison on one declared field, or an `and` of filters:

```typescript
import type { VectorFilter } from '@setu-ts/common';

export const filter = {
  and: [
    { field: 'tag', op: 'eq', value: 'release' },
    { field: 'year', op: 'gte', value: 2024 },
  ],
} satisfies VectorFilter;
```

| Rule                     | Refused when                                                              |
| ------------------------ | ------------------------------------------------------------------------- |
| Declared field           | the field is not in the collection's `filterable` map                     |
| `eq`                     | the value is not the field's declared type                                |
| `in`                     | the field is `boolean`, the list is empty, or it has more than 100 values |
| `gt`, `gte`, `lt`, `lte` | the field is not `number`, or the value is not a finite number            |
| Strings                  | longer than 64 UTF-8 bytes (Vectorize indexes only the first 64)          |
| Nesting                  | `and` deeper than 4, or more than 32 clauses in the whole filter          |

There is no `or`, substring match, negation or path. Three of the four backends cannot honour them,
and an operator that cannot be translated would otherwise have to be dropped. Every refusal throws
`VectorFilterError` naming the clause, and the service checks before any adapter is called. A record
without the field never matches a comparison on it.

## Limits

| Limit                                | Value             |
| ------------------------------------ | ----------------- |
| Dimensions per collection            | 4,096             |
| Filterable fields per collection     | 10                |
| Matches per query (`topK`)           | 50                |
| Records per `upsert`/`replaceSource` | 500               |
| Ids per `delete`                     | 1,000             |
| Scope                                | 64 UTF-8 bytes    |
| Record or source id                  | 256 UTF-8 bytes   |
| Record `content`                     | 8,192 UTF-8 bytes |
| String metadata or filter value      | 64 UTF-8 bytes    |
| Values in one `in` clause            | 100               |
| `and` nesting depth                  | 4                 |
| Clauses in one filter                | 32                |

The service enforces every limit before the adapter sees the call, and each value is the tightest of
the four backends so a request behaves the same everywhere. A vector must have exactly the
collection's length, finite components and a non-zero norm (`VectorDimensionError`). A `topK`
outside 1–50, a `minScore` outside `[-1, 1]`, an over-size batch and an over-size id, content or
metadata value throw `VectorRecordError`.

## Adapters

The memory adapter is the default for development, tests and small corpora; it is exact brute-force
cosine search and loses everything on restart. The other three take a client the application owns.

### pgvector

`PgVectorStore` needs PostgreSQL with the pgvector extension, version 0.8 or later, and the
application's raw Drizzle database — `drizzle(pool)` from `drizzle-orm/node-postgres` or
`drizzle(client)` from `drizzle-orm/postgres-js`, not the opaque handle given to `DatabasePlugin`.
`drizzle-orm@0.45.2` is an optional peer, loaded lazily.

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PgVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import type { PgVectorDatabase } from '@setu-ts/vector-store-plugin';

const pool = new Pool({ connectionString: 'postgres://postgres:postgres@localhost:5432/postgres' });

export const plugin = VectorStorePlugin({
  adapter: new PgVectorStore({
    db: drizzle(pool) as unknown as PgVectorDatabase,
    onClose: () => pool.end(),
  }),
  collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
});
```

Each collection is one table named `vs_<name>`, with a `scope` column in its primary key and an HNSW
cosine index. `ensure: 'create'` (default) creates missing objects; `ensure: 'verify'` only checks
them and refuses a missing table, for applications whose migrations own the DDL. Both modes check
the extension version and the column's dimensions.

Queries run in a transaction with `hnsw.ef_search` raised to at least 40 and
`hnsw.iterative_scan = strict_order`, so filtered searches keep recall and results stay in distance
order. `replaceSource` runs in one transaction and serialises concurrent replacements of the same
source with an advisory lock.

Exclude the adapter's tables from `drizzle-kit push`, or it may offer to drop them:

```typescript
export default {
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  tablesFilter: ['!vs_*'],
};
```

### Qdrant

`QdrantVectorStore` takes the application's official client and never imports it. The client is
checked structurally at construction for `collectionExists`, `getCollection`, `createCollection`,
`createPayloadIndex`, `upsert`, `query` and `delete`.

```typescript
import { QdrantVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import type { QdrantClientLike } from '@setu-ts/vector-store-plugin';

declare const client: QdrantClientLike;

export const plugin = VectorStorePlugin({
  adapter: new QdrantVectorStore({ client }),
  collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
});
```

Each collection is a Qdrant collection `vs_<name>` with `distance: 'Cosine'`. The adapter creates
the `scope` payload index marked `is_tenant`, a `source_id` index, and one payload index per
declared field. An existing collection is verified by size and distance. Point ids are derived from
`vectorRecordKey(subtle, scope, id)`, and the original id is stored in the payload.

`replaceSource` upserts the new points and then deletes the source's stale ones. The two calls are
not atomic, so two replacements of the same source must not run concurrently; serialise them per
source.

### Cloudflare Vectorize

`VectorizeVectorStore` ships in `@setu-ts/cloudflare-plugin`. It takes the current `Vectorize`
binding, not the deprecated beta `VectorizeIndex`, through a facade checked at construction.

```typescript
import { VectorizeVectorStore } from '@setu-ts/cloudflare-plugin';
import type { VectorizeIndexLike } from '@setu-ts/cloudflare-plugin';
import { VectorStorePlugin } from '@setu-ts/vector-store-plugin';

declare const index: VectorizeIndexLike;

export const plugin = VectorStorePlugin({
  adapter: new VectorizeVectorStore({ index }),
  collections: [{ name: 'documents', dimensions: 768, filterable: { tag: 'string' } }],
});
```

Create the index with cosine distance and a metadata index for every declared field before the first
write:

```bash
npx wrangler vectorize create documents --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index documents --property-name=tag --type=string
```

The binding reports dimensions but not the metric, so registration can check only the dimensions. A
filter on a field without a metadata index is not refused by the binding; the query may return
nothing. Writes are applied asynchronously, so a read may not see a write yet.

Vectorize cannot delete by namespace or by filter, so `replaceSource` and `deleteScope` throw
`VectorOperationUnsupportedError`. Upsert deterministic ids and delete stale ids yourself, or give
each tenant group its own index: one index holds 50,000 namespaces on Workers Paid (1,000 on Free).

### Capability matrix

| Operation       | memory | pgvector | Qdrant | Vectorize |
| --------------- | ------ | -------- | ------ | --------- |
| `upsert`        | yes    | yes      | yes    | yes       |
| `query`         | yes    | yes      | yes    | yes       |
| `delete`        | yes    | yes      | yes    | yes       |
| `replaceSource` | yes    | yes      | yes    | refused   |
| `deleteScope`   | yes    | yes      | yes    | refused   |

pgvector indexes at most 2,000 dimensions and Vectorize at most 1,536; a larger declaration fails
registration with `VectorOperationUnsupportedError`. A mismatch in an existing collection fails with
`VectorCollectionMismatchError`. Neither is recoverable at request time.

## Embeddings

The store has no embedder port and calls no provider. Embed with the AI SDK and pass the vectors in;
keep one model per collection, because vectors from two models are not comparable even at equal
dimensions.

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embedMany } from 'ai';
import type { IVectorStore, VectorRecord } from '@setu-ts/common';

declare const store: IVectorStore;

const provider = createOpenAICompatible({
  name: 'embeddings',
  baseURL: 'http://localhost:8081/v1',
});
const model = provider.embeddingModel('qwen3-embedding-0.6b');
const chunks = ['first chunk', 'second chunk'];
const { embeddings } = await embedMany({ model, values: chunks });
const records: VectorRecord[] = chunks.map((content, index) => ({
  id: `doc#${index}`,
  vector: embeddings[index]!,
  sourceId: 'doc',
  content,
}));

await store.replaceSource('documents', 'acme', 'doc', records);
```

Budget embedding spend with the application's own policy; the [AI guide](./ai.md) covers weighted
quotas for those calls.

## Rebuild a collection for a new model

Vectors from different models are not comparable, so do not re-embed a live collection in place:

1. Declare a new collection with the new model's dimensions and the same filterable fields.
2. Write to both collections while the new one backfills.
3. Read from the new one when the backfill is complete.
4. Remove the old collection's declaration, then drop its table, Qdrant collection or Vectorize
   index with the backend's own tools.

The store has no rename, copy or drop, so the application owns this sequence.

## Test the store

Use `MemoryVectorStore` in tests: it is the reference the real adapters are compared against and
needs no service. Write the same id under two scopes and assert each query sees only its own record;
assert that an undeclared filter field throws `VectorFilterError` before the adapter is called. The
`semantic-search` example's `smoke.ts` does both through the real routes, plus re-ingestion, a
refused filter and a dimension mismatch.

For a real backend, pass `PGVECTOR_URL` or `QDRANT_URL` to the adapter's factory in the test or in
CI. The store's own suite runs the same conformance table against memory, a Vectorize fake, and real
pgvector and Qdrant when those URLs are set.

## Operational notes

- A failed registration fails startup. That includes an unreachable backend, a missing extension, a
  dimension mismatch and a refused declaration.
- The pgvector and Qdrant adapters classify transport failures: an unreachable backend answers 503,
  an unanswered request answers 504, and the served detail carries no connection string.
- Concurrent writes to one source are the application's concern. `replaceSource` serialises them on
  pgvector and not on Qdrant, which uses two calls.
- A filter on a Vectorize field written before its metadata index existed may match nothing. Create
  the indexes before the first write.
