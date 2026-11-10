# @setu-ts/vector-store-plugin

Tenant-scoped similarity search over collections declared up front. The tenant scope is a required
argument of every data method, not a filter key, so no call can be built without it. A filter names
only declared metadata fields and is refused, never ignored, when the backend cannot honour it.

The store takes vectors. It does not embed text and has no embedder port: build the vector with the
AI SDK's `embed`/`embedMany` (or any other client) and pass it to `upsert` or `query`. The plugin
provides the `CAPABILITIES.VECTOR_STORE` service (`IVectorStore`) and three adapters:

- `MemoryVectorStore` — in-process, the reference every other adapter is compared against.
- `PgVectorStore` — PostgreSQL with the pgvector extension, through the application's Drizzle
  instance.
- `QdrantVectorStore` — Qdrant, through the application's official client.

The Cloudflare Workers adapter, `VectorizeVectorStore`, ships in
[`@setu-ts/cloudflare-plugin`](https://github.com/setu-ts/setu-ts/blob/main/packages/cloudflare-plugin/README.md)
because a plugin never imports another plugin.

## Installation

```bash
npm install @setu-ts/vector-store-plugin
# Deno: deno add npm:@setu-ts/vector-store-plugin
```

`setu add vector-store` installs the package and prints a registration to paste into
`setu.config.ts`; it never inserts one, because collections and the adapter's client belong to the
application.

The pgvector adapter loads `drizzle-orm` lazily and declares it as an optional peer (`0.45.2`).
Install it beside the plugin, then install your PostgreSQL driver (`pg` or `postgres`):

```bash
npm install @setu-ts/vector-store-plugin drizzle-orm@0.45.2 pg
```

The Qdrant adapter imports nothing from `@qdrant/js-client-rest`; install the client yourself and
pass it in. The memory adapter needs nothing beyond the package.

## Usage

Collections are required and are validated when the plugin is created. The adapter creates or
verifies them during registration, so an unreachable backend or a mismatched index fails application
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

The routes that use the store go in a plugin registered after it;
[Tenancy and scope](#tenancy-and-scope) shows the complete application.

`adapter` may also be a factory `(runtime) => adapter | Promise<adapter>`, which is how an
application reads a connection string from `runtime.env` or imports a driver lazily. The factory is
called once, during registration.

## Collections

| Property      | Rule                                                                      |
| ------------- | ------------------------------------------------------------------------- |
| `name`        | `^[a-z][a-z0-9_]{0,39}$`; unique per application                          |
| `dimensions`  | Integer 1–4,096; an adapter may support fewer and refuses at registration |
| `filterable?` | At most 10 fields, each `'string'`, `'number'` or `'boolean'`             |

Field names match `^[a-z][a-z0-9_]{0,63}$` and may not be `scope`, `id`, `source_id` or `content`,
which the adapters use for their own columns or payload keys. Only declared fields may appear in a
filter or in a record's metadata.

An undeclared collection in a call throws `VectorCollectionUnknownError` before any backend I/O. It
is a programming error and carries a 500 status hint.

## Tenancy and scope

`IVectorStore.scopeFor(ctx)` returns the request's tenant id under the default
`tenancy: 'required'`, and throws `VectorScopeRequiredError` when the request has no tenant. The
service is registered under `CAPABILITIES.VECTOR_STORE`. This application registers its routes
plugin after `VectorStorePlugin` and validates each body, so a vector of the wrong length is a
`400`:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext, IVectorStore } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';
import { validateBody, ValidationPlugin } from '@setu-ts/validation-plugin';
import { MemoryVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import { z } from 'zod';

// Every vector has the collection's declared length, from the same embedding model.
const Embedding = z.array(z.number()).length(1024);
const Tag = z.string().min(1).max(64);
const upsertBody = validateBody(z.object({ id: z.string().min(1).max(256), vector: Embedding, tag: Tag }));
const searchBody = validateBody(z.object({ vector: Embedding, tag: Tag }));

export function documentsPlugin(): IPlugin {
  return {
    name: 'documents-routes',
    version: '1.0.0',
    dependencies: [CAPABILITIES.VECTOR_STORE],
    register(ctx: IPluginContext): void {
      const store = ctx.services.get<IVectorStore>(CAPABILITIES.VECTOR_STORE);
      ctx.router.post('/documents', {
        middleware: [upsertBody],
        handler: async (c) => {
          const body = upsertBody.value(c);
          await store.upsert('documents', store.scopeFor(c), [
            { id: body.id, vector: body.vector, metadata: { tag: body.tag } },
          ]);
          return c.response.status(204).send();
        },
      });
      ctx.router.post('/documents/search', {
        middleware: [searchBody],
        handler: async (c) => {
          const { vector, tag } = searchBody.value(c);
          const matches = await store.query('documents', store.scopeFor(c), {
            vector,
            topK: 5,
            filter: { field: 'tag', op: 'eq', value: tag },
          });
          return c.response.json(matches);
        },
      });
    },
  };
}

export const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ValidationPlugin(),
    MultiTenancyPlugin({ resolver: 'header', tenants: ['acme', 'globex'] }),
    VectorStorePlugin({
      adapter: new MemoryVectorStore(),
      collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
    }),
    documentsPlugin(),
  ],
});
```

The `header` resolver selects the tenant the caller names; it does not authenticate the caller, so
any client can send `x-tenant-id: globex` and read or overwrite that tenant's records. Use it for
local development and for trusted internal callers only. In production, resolve the tenant from the
signed-in principal, as
[the multi-tenancy plugin shows](https://github.com/setu-ts/setu-ts/blob/main/packages/multi-tenancy-plugin/README.md#tenant-from-the-signed-in-principal),
or authenticate the request and check that the principal belongs to the tenant before `scopeFor`.

Pass the scope as the second argument of `upsert`, `replaceSource`, `query`, `delete` and
`deleteScope`. A scope is a non-empty, well-formed string of at most 64 UTF-8 bytes; anything else
throws `VectorScopeInvalidError`. Each adapter maps it to its strongest native boundary: a primary
key column in pgvector, an `is_tenant` payload index and a `must` condition in Qdrant, a namespace
in Vectorize, and a map key in memory.

`tenancy: { fixed: 'shared' }` makes `scopeFor` return that scope for every request, tenant or not.
Use it for a store opened without multi-tenancy, never to let tenant and tenant-less requests share
rows.

A queue job resolves its own scope: validate the tenant id with `IMultiTenancyService.lookupTenant`
and pass `found.value.id` to the store. A job that runs after the tenant was removed should write
nothing.

## Searching

`query(collection, scope, { vector, topK, filter?, minScore? })` returns at most `topK` matches
ordered by cosine similarity descending, then record id ascending. `score` is cosine similarity in
`[-1, 1]`; `minScore` drops lower matches on the same scale. An adapter may return fewer than
`topK`.

```typescript
import type { VectorFilter } from '@setu-ts/common';

export const filter = {
  and: [
    { field: 'tag', op: 'eq', value: 'release' },
    { field: 'year', op: 'gte', value: 2024 },
  ],
} satisfies VectorFilter;
```

The filter type is narrow on purpose. A field comparison uses `eq`, `in`, `gt`, `gte`, `lt` or
`lte`; `and` nests comparisons. Ranges apply to `number` fields only, `in` takes 1–100 strings or
numbers and is not available for `boolean` fields, and there is no `or`, substring match, negation
or path. A clause outside those rules throws `VectorFilterError` naming the clause before the
adapter is called. A record without the field never matches a comparison on it.

## Write, replace and delete

`upsert(collection, scope, records)` inserts or replaces by `(scope, id)`. One call takes at most
500 records and may not name the same id twice.

`replaceSource(collection, scope, sourceId, records)` writes the source's new records, then deletes
that source's other records in the scope. Every record must carry `sourceId`. A re-run with the same
ids therefore leaves one copy, and a shorter document leaves no stale chunk. A record id already
used by another source in the same scope is reassigned to this source.

One call replaces the WHOLE source and takes at most 5,000 records, so write a document in one call:
a second call for the same source deletes every record the first one wrote. On pgvector the call is
one transaction. Qdrant has no transactions, so a failed call can leave part of it written; retry
the whole call.

Pass `{ version }` as a fifth argument when submissions of one source can be processed out of order,
as queue retries can be. The version is a non-negative safe integer that grows with each newer
submission, such as the time the submission was accepted. The write is refused with
`VectorVersionConflictError` (409) when the source's stored records carry a higher version, so a
late retry of an older submission cannot replace a newer one; an equal version is written again, so
a retry of the same submission succeeds. A write without a version leaves the source unversioned,
and a source with no records keeps no version. memory, pgvector and Qdrant (1.16 or later) honour
versions; an adapter that does not declare `versionedReplace` refuses a versioned call with
`VectorOperationUnsupportedError`.

`delete(collection, scope, ids)` deletes at most 1,000 ids. `deleteScope(collection, scope)` deletes
every record of one tenant in the collection, for offboarding.

## Limits

| Limit                            | Value             |
| -------------------------------- | ----------------- |
| Dimensions per collection        | 4,096             |
| Filterable fields per collection | 10                |
| Matches per query (`topK`)       | 50                |
| Records per `upsert`             | 500               |
| Records per `replaceSource`      | 5,000             |
| Ids per `delete`                 | 1,000             |
| Scope                            | 64 UTF-8 bytes    |
| Record or source id              | 256 UTF-8 bytes   |
| Record `content`                 | 8,192 UTF-8 bytes |
| String metadata or filter value  | 64 UTF-8 bytes    |
| Values in one `in` clause        | 100               |
| `and` nesting depth              | 4                 |
| Clauses in one filter            | 32                |

Every limit is enforced by the service before the adapter sees the call, and is the tightest of the
four backends so a request behaves the same everywhere. A vector must have exactly the collection's
declared length, finite components within the float32 range and a non-zero norm after float32
rounding; otherwise it throws `VectorDimensionError`. A `topK` outside 1–50, a `minScore` outside
`[-1, 1]`, an over-size batch and an over-size id, content or metadata value throw
`VectorRecordError`.

## Adapters

### pgvector

`new PgVectorStore({ db, ensure?, onClose? })` takes a raw Drizzle PostgreSQL database
(`drizzle(pool)` from `drizzle-orm/node-postgres`, `drizzle(client)` from
`drizzle-orm/postgres-js`), not the opaque handle given to `DatabasePlugin`. Construction refuses a
database without `execute` and `transaction`. pgvector 0.8 or later is required.

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { PgVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import type { PgVectorDatabase } from '@setu-ts/vector-store-plugin';

// Bounds: a hung database answers 503/504 instead of holding the request.
const pool = new Pool({
  connectionString: 'postgres://postgres:postgres@localhost:5432/postgres',
  connectionTimeoutMillis: 5_000,
  query_timeout: 15_000,
});

export const plugin = VectorStorePlugin({
  adapter: new PgVectorStore({
    db: drizzle(pool) as unknown as PgVectorDatabase,
    onClose: () => pool.end(),
  }),
  collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
});
```

`PgVectorStore` creates one table per collection, `vs_<name>`, with a `scope` column in its primary
key and an HNSW cosine index. `ensure: 'create'` (default) creates missing objects;
`ensure: 'verify'` only checks them and refuses a missing table, for applications whose migrations
own the DDL (concurrent replica start-up can race on `CREATE`). Both modes check the `vector`
extension version, the column's dimensions and the two indexes. A migration must create them with
these names and shapes:

```sql
CREATE INDEX vs_documents_src ON vs_documents (scope, source_id);
CREATE INDEX vs_documents_hnsw ON vs_documents USING hnsw (embedding vector_cosine_ops);
```

An index with the right name but another table, columns, access method or operator class (an L2
`vector_l2_ops` HNSW index, say) is refused with `VectorCollectionMismatchError` naming the expected
definition. `ensure: 'create'` does not replace such an index either, so it refuses it too. Every
collection uses cosine distance.

Every query runs in a transaction with `hnsw.ef_search` raised to at least 40 and
`hnsw.iterative_scan = strict_order`, so filtered searches keep recall and results stay in distance
order. `replaceSource` runs in one transaction and serialises concurrent replacements of the same
source with an advisory lock; a version is read and checked under that lock. The version is the
`source_version bigint` column: `ensure: 'create'` adds it to an existing table, and
`ensure: 'verify'` refuses a table without it.

All tenants share one HNSW index per collection, and the scope is applied while the index is
scanned. The iterative scan stops after `hnsw.max_scan_tuples` index tuples (20,000 by default), so
a tenant that owns a small share of a large table can get fewer than `topK` matches. Raise the limit
for the application's role (`ALTER ROLE app SET hnsw.max_scan_tuples = 100000`), or give large
tenants their own collection.

**Bound every backend call.** The adapters set no timeouts of their own. Give the clients one, or a
hung backend holds the request: node-postgres `connectionTimeoutMillis` and `query_timeout` (a
timeout answers `503` before a statement is sent, `504` after), and `QdrantClient`'s `timeout` in
milliseconds (`504`). The pgvector adapter gives the pool an `'error'` listener at startup, so a
connection that drops — idle or inside a transaction — is reported through the application's logger
instead of exiting the process.

If the application uses `drizzle-kit push`, exclude these tables so it never offers to drop them:

```typescript
export default {
  schema: './src/database/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  tablesFilter: ['!vs_*'],
};
```

The adapter never closes the database the application injected; `onClose` is for a pool the factory
created for the store.

### Qdrant

`new QdrantVectorStore({ client, onClose? })` takes the application's `QdrantClient`, built with a
`timeout` (for example `new QdrantClient({ url, timeout: 15_000 })`). The client is typed by a
structural facade (`collectionExists`, `getCollection`, `createCollection`, `createPayloadIndex`,
`upsert`, `query`, `delete`, `count`, `versionInfo`) that is checked at construction; the package
never imports `@qdrant/js-client-rest`.

```typescript
import { QdrantVectorStore, VectorStorePlugin } from '@setu-ts/vector-store-plugin';
import type { QdrantClientLike } from '@setu-ts/vector-store-plugin';

declare const client: QdrantClientLike;

export const plugin = VectorStorePlugin({
  adapter: new QdrantVectorStore({ client }),
  collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
});
```

Each collection becomes a Qdrant collection `vs_<name>` with `distance: 'Cosine'`. The adapter
creates a `scope` keyword payload index marked `is_tenant`, a `source_id` index, and one index per
declared filterable field. An existing collection is verified by size and distance. Point ids are
the first 128 bits of `vectorRecordKey(subtle, scope, id)` formatted as a UUID, so two tenants
writing the same id never meet; the original id travels in the payload.

`replaceSource` is an upsert followed by a delete of the source's stale points. The two calls are
not atomic, so unversioned replacements of the same source must not run concurrently; serialise them
per source, or pass a version. A versioned write needs Qdrant 1.16 or later, which the adapter
checks once with `versionInfo()`: the upsert's `update_filter` keeps points a newer version wrote, a
`count` afterwards finds a newer version that landed first, and the stale-delete never removes a
newer point. Concurrent versioned writes settle on the highest version, though a reader can briefly
see chunks of both.

### Cloudflare Vectorize

`VectorizeVectorStore` lives in `@setu-ts/cloudflare-plugin`. It takes the current `Vectorize`
binding (not the deprecated beta `VectorizeIndex`), through a structural facade validated at
construction. The scope is the namespace, and the stored id is the 64-character hexadecimal
`vectorRecordKey(subtle, scope, id)`; the caller's id travels in metadata.

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

Create the index with cosine distance and a metadata index for every declared filterable field
before the first write:

```bash
npx wrangler vectorize create documents --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index documents --property-name=tag --type=string
```

The binding reports dimensions but not the metric, so `ensureCollection` can verify only the
dimensions. A filter on a field without a metadata index is not refused by the binding; the query
may simply match nothing. Writes are applied asynchronously, so a read may not see a write yet.

Vectorize cannot delete by namespace or by filter: `replaceSource` and `deleteScope` throw
`VectorOperationUnsupportedError` instead of being emulated. Upsert deterministic ids and delete the
stale ones yourself, or give each tenant group its own index.

## Errors

| Error                             | Thrown when                                                                              | Status hint |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ----------- |
| `VectorScopeRequiredError`        | Tenancy is `'required'` and the request has no tenant                                    | 400         |
| `VectorScopeInvalidError`         | A scope is empty, ill-formed or over 64 bytes                                            | 400         |
| `VectorFilterError`               | A filter clause names an undeclared field or breaks an operator rule                     | 400         |
| `VectorDimensionError`            | A vector has the wrong length, a component that is not finite as a float32, or zero norm | 400         |
| `VectorRecordError`               | A record, id, metadata value, batch, `topK` or `minScore` is invalid                     | 400         |
| `VectorCollectionUnknownError`    | A call names a collection the plugin was not configured with                             | 500         |
| `VectorCollectionMismatchError`   | An existing collection's dimensions, `source_version` column or index shape disagree     | —           |
| `VectorOperationUnsupportedError` | The backend cannot perform the operation or support the declaration                      | 501         |

`VectorCollectionMismatchError` and a refused declaration fail registration, so the application does
not start. The pgvector and Qdrant adapters classify transport failures with `toBackendFault`: an
unreachable backend answers 503 and an unanswered request answers 504, with no connection details in
the served detail.

## Embeddings stay in the application

The store has no embedding model, so the same collection is only comparable when every vector in it
came from the same model. Embed chunks and queries with the AI SDK and pass the results in:

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

To change the model, do not re-embed in place: declare a new collection with the new dimensions,
dual-write, backfill, switch reads, then delete the old collection. Vectors from two models are not
comparable even when their dimensions agree.

Budget embedding spend with the application's own policy; the store never calls a provider. The
[AI guide](https://github.com/setu-ts/setu-ts/blob/main/docs/ai.md) covers weighted quotas for those
calls.

## Exports

| Export                     | Kind      |
| -------------------------- | --------- |
| `VectorStorePlugin`        | function  |
| `MemoryVectorStore`        | class     |
| `PgVectorStore`            | class     |
| `QdrantVectorStore`        | class     |
| `VERSION`                  | const     |
| `MemoryVectorStoreOptions` | interface |
| `PgVectorDatabase`         | interface |
| `PgVectorExecutor`         | interface |
| `PgVectorStoreOptions`     | interface |
| `QdrantClientLike`         | interface |
| `QdrantVectorStoreOptions` | interface |
| `VectorStorePluginOptions` | interface |
| `VectorStoreTenancy`       | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

See
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#vector-store-setu-tscommon--setu-tsvector-store-plugin).
