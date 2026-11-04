# Milestone 135 — Tenant-scoped vector retrieval (`@setu-ts/vector-store-plugin`)

> **Status:** Planning. Branch: `feat/m135-vector-store`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Retrieval needs similarity search, and today the only route in Setu is raw SQL through
`IDatabaseService.query()`, with the tenant predicate left to the caller. Every vector abstraction
the AI-layer survey (track 03, 2026-11-01) read ships a filter translator that fails OPEN — a clause
it cannot translate is dropped and the query matches everything (langchainjs #11763), or a
delete-by-filter removes the wrong rows (Spring AI #7258, #7119). M135 adds a **thin port whose only
job is the part no library does: a tenant scope that cannot be omitted, and a filter that is
refused, never ignored.** Everything else comes from the standard libraries the application already
uses: Drizzle's built-in pgvector support, the official Qdrant client, the Vectorize binding, and
the AI SDK's `embed`/`embedMany` (M134's library-first rule, memory `prefer-existing-libraries`).

Maintainer decisions taken before this plan (2026-11-04, recorded in the PR):

- **Shape:** a thin tenant-safe port over standard libraries — not a full vector abstraction, not
  docs only.
- **Adapters:** memory (the conformance oracle), pgvector through Drizzle, Qdrant, Cloudflare
  Vectorize.
- **No embedder port:** the store takes vectors; applications embed with the AI SDK and budget with
  M134's `createQuota`.
- **Example app** offered through `setu new --example`, generated from this tree's CLI.

Compared with (survey track 03, primary sources cited there):

| Concern      | Spring AI                     | LangChain.js                       | Mastra                         | AI SDK / Laravel / Rails         | M135                                                      |
| ------------ | ----------------------------- | ---------------------------------- | ------------------------------ | -------------------------------- | --------------------------------------------------------- |
| Shape        | `VectorStore` over ~20 stores | abstract `VectorStore`             | `MastraVector` over ~20 stores | no store; ORM column + operators | thin port, 4 adapters over standard clients               |
| Tenant scope | a filter key                  | a filter key                       | a filter key                   | a `WHERE` clause                 | required argument; native boundary per adapter            |
| Filter       | portable DSL                  | none portable (`object \| string`) | Mongo-style DSL                | SQL                              | 6 operators + `and`, declared fields, refused not dropped |
| Embedder     | inside the store              | inside the store                   | outside                        | `embed`/`embedMany`              | outside (AI SDK)                                          |
| Re-ingest    | none                          | `index()` + record manager         | `upsert({ deleteFilter })`     | none                             | `replaceSource`                                           |

- **In scope:** the `vector-store` capability token and the `IVectorStore` port in `common`; a new
  `packages/vector-store-plugin` (plugin, service, memory/pgvector/Qdrant adapters, filter
  validation); a `VectorizeVectorStore` in `cloudflare-plugin`; `setu add vector-store`; the
  `apps/semantic-search` example and a website guide `docs/retrieval.md`; CI images for pgvector and
  Qdrant; one conformance table across all four adapters.
- **NOT this milestone:** an embedder port (decided against; the AI SDK owns embedding); hybrid
  lexical + vector search, re-ranking, MMR, sparse vectors (survey §7.5 — AI SDK `rerank` covers
  re-ranking); MongoDB Atlas and Cosmos DB vector search (named follow-ons, ROADMAP decision 5);
  document loaders and chunking libraries (the example shows a plain splitter; loaders are the
  application's); metrics, diagnostics and a health indicator for the store (follow-on); dot-product
  and euclidean metrics (§3.4; follow-on); durable agent runs (M136).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                    | Source (file:line)                                                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                                               | `packages/common/src/tokens.ts:39-313`                                                                                                                                                                                       | No vector, embedding or retrieval token exists. `createCapabilityToken` (`:353`) enforces `^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.…)*$` (`:326-334`); `vector-store` passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `FilterExpression` / `FilterOperator`                        | `packages/common/src/services/database.ts:76,83,114`                                                                                                                                                                         | Operators `eq contains gt gte lt lte in` plus `and`/`or`; `field` may be a path array. No `ne`/`not`. The vector filter is a narrower, separate type (§3.5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `matchesFilter`                                              | `packages/database-plugin/src/query/query-builder.ts:157`                                                                                                                                                                    | Internal to database-plugin (not in `src/index.ts`; `package.json` exports only `.`). The vector-store memory adapter needs its own evaluator over the narrower filter (§3.5); nothing is shared or re-exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `IDatabaseService.query()`                                   | `packages/database-plugin/src/interfaces/index.ts:247`                                                                                                                                                                       | The only registry-reachable SQL route; untyped, applies no tenant scope, refused on memory (`UnsupportedRawQueryError`, `errors.ts:217`). Not used: the pgvector adapter takes the application's Drizzle instance (§3.7).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `getDrizzleDatabase` / `createDrizzleDatabase`               | `packages/database-plugin/src/query/drizzle-query.ts:115`, `drizzle-database.ts:141`                                                                                                                                         | The native Drizzle db is an application-held handle; a plugin cannot obtain it from the registry. Precedent for the adapter taking it as a constructor argument: `D1Adapter(db)` (`cloudflare-plugin/src/database/d1-adapter.ts:170`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Drizzle raw `execute()`                                      | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:515-546`                                                                                                                                                   | Executes a bound `sql` statement; result is `{ rows }` (node-postgres) or an array (postgres-js), normalised as `(result.rows ?? result)`; a db without `execute` is refused. The pgvector adapter reuses this shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Drizzle lazy load                                            | `drizzle-adapter.ts:294` (`await import('drizzle-orm')`)                                                                                                                                                                     | The awaited literal import pattern (AI_GUIDELINES §12.2) the pgvector adapter follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| drizzle-orm 0.45.2 vector support                            | `node_modules/drizzle-orm/sql/functions/vector.d.ts:26,70,93`; `pg-core/columns/vector_extension/vector.d.ts:40`                                                                                                             | `cosineDistance`, `l2Distance`, `innerProduct`, `vector(name, { dimensions })` exist. pgvector-node is NOT needed (it has no Drizzle integration because Drizzle ships one).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tenant in a request                                          | `packages/common/src/http.ts:69`                                                                                                                                                                                             | `ctx.request.tenant?: ITenant` (set by the multi-tenancy middleware).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IMultiTenancyService`                                       | `packages/common/src/services/tenancy.ts:78,136`                                                                                                                                                                             | `lookupTenant(id): Promise<Option<ITenant>>` validates a job payload's tenant id — the non-request entry point the example's ingest job uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Tenant scoping precedent outside database-plugin             | `packages/cache-plugin/src/utils/cache-key.ts:42-48`                                                                                                                                                                         | Reads `ctx.request.tenant?.id` and length-prefixes it into the key — the shape `vectorScope(ctx)` follows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IQueue` / `AddJobOptions`                                   | `packages/common/src/services/queue.ts:59-77,131-150`                                                                                                                                                                        | `add(name, data, options?)` returns a queue-assigned id; options are only `delayMs`, `maxAttempts`, `headers`. **No caller job id, no dedup.** A re-run's idempotency must come from the store (`replaceSource`, §3.9), not the queue.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Job schematic                                                | `packages/cli/src/schematics/job.ts`; `generate.ts:377`                                                                                                                                                                      | `setu generate job` exists; the example's ingest worker is generated, not hand-written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ICloudflareBindings.get<T>`                                 | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:77,184`                                                                                                                                                         | Generic accessor for bindings with no facade (doc names Vectorize). No Vectorize code exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Vectorize binding (`@cloudflare/workers-types` 5.20261104.1) | `index.d.ts:17816-17825, 17854-17860, 17893-17902, 18004-18047`                                                                                                                                                              | The CURRENT class is `Vectorize` (`:18004`); `VectorizeIndex` (`:17958`) is the deprecated beta. `describe(): VectorizeIndexInfo` = `{ vectorCount, dimensions, processedUpToDatetime, processedUpToMutation }` — no metric. `query(vector, { topK, namespace, returnMetadata, filter })`, `upsert`/`deleteByIds` return `{ mutationId }` (applied asynchronously). Filter ops `$eq $ne $lt $lte $gt $gte $in $nin`, implicit AND. No delete-by-namespace or by-filter. Ids are index-global. Docs: topK ≤ 50 with metadata, metadata indexes cover the first 64 B of a string, ≤ 10 metadata indexes, 1,536 dims, 1,000 vectors per upsert, 50,000 namespaces (Paid). |
| `@qdrant/js-client-rest` 1.20.0                              | `dist/types/qdrant-client.d.ts:222,289,541,604,848,875`; `generated_schema.d.ts:1082,1317`                                                                                                                                   | `upsert`, `delete` (by points or filter), `createCollection`, `createPayloadIndex` (keyword `is_tenant`), `collectionExists`, `query` (`filter`, `limit`, `score_threshold`, `with_payload`). `ExtendedPointId: number                                                                                                                                                                                                                                                                                                                                                                                                                                                 | string` and the server requires an unsigned int or a UUID. |
| AI SDK 7.0.159                                               | `ai/dist/index.d.ts:7922,8076,8977`; `ai/dist/test/index.d.ts:61`                                                                                                                                                            | `embed`, `embedMany`, `cosineSimilarity`; `MockEmbeddingModelV4` in `ai/test`. Only the root and `apps/ai-chat` depend on `ai`; it is not in `EXTERNAL_RANGES`/`CLIENT_RANGES`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Optional peers                                               | `scripts/node-manifests.ts:20-26,465-470`; `scripts/node-dependency-ranges.ts:26`                                                                                                                                            | Peers are DERIVED from dynamic/type-only imports; each range must exist in `EXTERNAL_RANGES` (`drizzle-orm: '0.45.2'` `:78`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| New-package registries                                       | `scripts/release-packages.ts:7`; `scripts/jsr-metadata.ts:161`; `compat/compat.test.mjs:26`; `packages/cli/src/agents/package-data.ts:18`; `packages/cli/src/devtool/sources.ts:171`; `packages/cli/src/commands/add.ts:166` | `PUBLISHED_PACKAGES`, `PACKAGE_METADATA`, `PENDING_FIRST_PUBLISH`, `PACKAGE_DATA` (tokens must exist and appear in src), `FRAMEWORK_PACKAGES`, `ADDABLE`; `AGENT_CARD.md` required by `scripts/npm-release-gate.ts:48-61`.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| CI PostgreSQL                                                | `.github/workflows/ci.yml:149`; `drift.yml:86`; `release.yml:99`; `scripts/lib/local-ci-plan.ts:265`                                                                                                                         | Plain `postgres:16`; pgvector is absent everywhere. Verified tags exist: `pgvector/pgvector:0.8.1-pg16`, `qdrant/qdrant:v1.20.0` (Docker Hub, 2026-11-04).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Weighted quota (for the guide)                               | `packages/auth-plugin/src/quota/quota.ts:46`                                                                                                                                                                                 | `createQuota` / `IQuota.reserve`/`settle` — documented for embedding spend; no code dependency.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Local embedding model (live test)                            | probed 2026-11-04: `POST localhost:8081/v1/embeddings`                                                                                                                                                                       | `qwen3-embedding-0.6b`, OpenAI-compatible, 1,024 dimensions, `usage.prompt_tokens` reported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                            | Resolution (picked side)                                                                                                      | Doc deliverable (same PR)                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | ROADMAP M135 decision 4 plans an embedder port "building on the AI SDK and M134 quota"; M134 shipped no AI package. | No embedder port (maintainer, 2026-11-04). The store takes vectors.                                                           | ROADMAP M135 section rewritten to the shipped scope.  |
| C2  | ROADMAP decision 6: "ingestion as a queue job with an idempotent document id"; the queue has no caller job id.      | Idempotency comes from `replaceSource` keyed by `(scope, sourceId)`; the queue job is the example's, not a framework feature. | ROADMAP M135 section; `docs/retrieval.md`.            |
| C3  | ROADMAP decision 5 lists memory, pgvector, Vectorize; the maintainer added Qdrant.                                  | Four adapters.                                                                                                                | ROADMAP M135 section and Progress Tracking row.       |
| C4  | ROADMAP decision 3 implies every adapter supports every operation; Vectorize cannot delete by namespace or filter.  | The conformance table marks those cells REFUSED, asserted as a named error.                                                   | `docs/retrieval.md` capability matrix; plugin README. |

## 3. Design decisions

### 3.1 Package, token, port and shared pieces

- **Decision:** `CAPABILITIES.VECTOR_STORE = 'vector-store'`, the port, its data types, every error
  an adapter throws, and the `(scope, id)` key helper live in `@setu-ts/common`
  (`src/services/vector-store.ts`, `src/errors/vector-store.ts`). The plugin, service and the
  memory, pgvector and Qdrant adapters live in `packages/vector-store-plugin`;
  `VectorizeVectorStore` lives in `packages/cloudflare-plugin` (the `D1Adapter` precedent). Because
  cloudflare-plugin cannot import vector-store-plugin, anything both need — errors, the key helper —
  must be in `common` (review B1). The key helper is pure: `vectorRecordKey(subtle, scope, id)`
  hashes a length-prefixed encoding (`<len>:<scope>|<len>:<id>`, the `cache-key.ts:42-48` precedent)
  with SHA-256 and returns lowercase hex; callers pass `runtime.subtle`.
- **Why:** AI_GUIDELINES §1.3/§2.2 ports in `common`; no plugin imports another.
- **Test home:** `common/test/unit/vector-store-contract.test.ts`,
  `common/test/unit/vector-record-key.test.ts`.

### 3.2 Plugin identity, lifecycle and collections

- **Decision:** `VectorStorePlugin(options)` returns a plugin named `vector-store-plugin` that
  `provides: [CAPABILITIES.VECTOR_STORE]`, depends on the runtime plugin, and is single-instance (a
  second registration fails at the kernel's duplicate-name check, `plugin-resolver.ts:111`). Inside
  `register()` (which may be async) it: resolves `adapter`, which may be an adapter or a factory
  `(runtime) => adapter | Promise<adapter>` (a factory exists so an application can build a client
  from `runtime.env` and import a driver lazily); calls `adapter.open(runtime)`; calls
  `adapter.ensureCollection(spec)` for each declared collection in order; registers the service; and
  adds `ctx.lifecycle.onShutdown(() => adapter.close?.())`. Any failure during these steps fails
  application startup, including an unreachable backend (no health indicator in M135; §0). Built-in
  adapters never close an injected client: the application that created it owns it. Each built-in
  adapter accepts an optional `onClose` callback, which its `close()` calls, so a factory that
  creates a pool can hand its teardown to the plugin.
- **Collections:** specs `{ name, dimensions, filterable }`. Names match `^[a-z][a-z0-9_]{0,39}$`
  (the pgvector table `vs_<name>` and its index names `vs_<name>_hnsw`/`vs_<name>_src` stay under
  PostgreSQL's 63-byte identifier limit). Dimensions are integers 1–4,096; an adapter refuses a
  larger spec than it supports in `ensureCollection` with `VectorOperationUnsupportedError`
  (pgvector HNSW 2,000; Vectorize 1,536). At most 10 filterable fields per collection (Vectorize's
  metadata-index limit, applied everywhere for uniformity). Field names match
  `^[a-z][a-z0-9_]{0,63}$` (excludes the `.`, `[`, `"`, `|` and `$` that Qdrant or Vectorize read as
  syntax) and must not be `scope`, `id`, `source_id` or `content`. An undeclared collection in a
  call throws `VectorCollectionUnknownError` before any I/O.
- **Why:** AI_GUIDELINES §14.5 (close on shutdown); review M3, M6.
- **Test home:** `vector-store-plugin.test.ts` (registration, factory sync and async, open/ensure
  order, startup failure, shutdown close, duplicate registration), `collection-spec.test.ts`.

### 3.3 Tenant scope is a required argument, never a filter key

- **Decision:** every data method of `IVectorStore` takes `scope: string` as its second argument.
  The plugin option `tenancy` is `'required'` (default) or `{ fixed: string }`. The service method
  `IVectorStore.scopeFor(ctx)` (not a free function, so it reads the plugin's own option) returns
  `ctx.request.tenant.id` under `'required'` and throws `VectorScopeRequiredError` when there is no
  tenant; under `{ fixed }` it ALWAYS returns the fixed scope, whatever the request's tenant (review
  M7: ROADMAP decision 2's "a store opened without multi-tenancy"), so tenant and tenant-less
  requests never share rows. Jobs pass a tenant id they validated with
  `IMultiTenancyService.lookupTenant`. A scope must be a non-empty, well-formed string of at most 64
  UTF-8 bytes (Vectorize's namespace limit), else `VectorScopeInvalidError`. Each adapter maps the
  scope to its strongest native boundary: pgvector a `scope` column in the primary key and in every
  statement; Qdrant a `scope` keyword payload index with `is_tenant: true` and a `must` condition on
  every request; Vectorize the namespace; memory a map keyed by scope.
- **Why:** survey §3 — a retriever must be unable to build a query without the tenant predicate.
- **Test home:** `vector-scope.test.ts`; conformance tenant-leak rows; §8a probes.

### 3.4 Cosine similarity only, one score scale, defined ties

- **Decision:** one metric, cosine. `VectorMatch.score` is cosine similarity in `[-1, 1]`, higher is
  closer, on every adapter. Results are ordered by score descending, then by `id` ascending (ties
  are defined; memory implements the same rule). `minScore` filters on that scale. A zero-norm
  vector (query or record) is refused with `VectorDimensionError` (cosine is undefined for it;
  review M10).
- **Why:** every backend supports cosine; one portable `minScore` needs one scale.
- **Test home:** conformance ordering rows; `vector-store-service.test.ts` zero-norm row.

### 3.5 The filter: a narrow, declared, validated type

- **Decision:**
  `VectorFilter = { field, op: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte', value } | { and: readonly VectorFilter[] }`.
  No `or`, `contains`, `ne`, regex or paths. `filterable` maps a field to
  `'string' | 'number' | 'boolean'`. The SERVICE validates every filter before the adapter is
  called: undeclared field; operator not allowed for the type (ranges only on `number`); wrong value
  type; non-finite number; a string longer than 64 UTF-8 bytes (Vectorize indexes only the first 64
  bytes, so a longer value would match on prefix — fail-open, review M4); `in` empty or longer than
  100 values; nesting deeper than 4 or more than 32 clauses. Each throws `VectorFilterError` naming
  the clause. Adapters keep their own refusals (defence in depth). Values AND field names reach SQL
  only as bound parameters (`metadata->>$n`), never interpolated.
- **Why:** survey §6 fail-open DSL bugs; Vectorize has no `or`; `FilterExpression`'s `contains`,
  `or` and paths cannot be honoured by three of four backends.
- **Test home:** `filter-validation.test.ts` (each refusal, with a spy proving the adapter was not
  called).

### 3.6 Records, ids, metadata and `replaceSource`

- **Decision:** `VectorRecord = { id, vector, sourceId?, content?, metadata? }`. The service
  validates every record on write (review M3, M4): `id` and `sourceId` non-empty, well-formed, at
  most 256 UTF-8 bytes; `content` at most 8 KiB (Vectorize's 10 KiB metadata cap holds content plus
  the original id and fields); `metadata` read by OWN keys only (`Object.hasOwn`, so `constructor`
  or `__proto__` are never read through a prototype), every key declared, every value of its
  declared type, numbers finite, strings at most 64 UTF-8 bytes. Batches: at most 500 records per
  `upsert`/`replaceSource` and 1,000 ids per `delete` (pgvector's 65,535-parameter limit,
  Vectorize's 1,000-vector upsert; review M5); over-size batches throw `VectorRecordError`, as does
  a batch naming one id twice (PostgreSQL refuses an upsert that touches a key twice; the other
  adapters would keep the last copy). Methods: `upsert`,
  `replaceSource(collection, scope, sourceId, records)`, `query`, `delete(collection, scope, ids)`,
  `deleteScope(collection, scope)`. `replaceSource` writes the new records, then deletes the
  source's records (same scope) whose ids are not in the new set; every record must carry that
  `sourceId`. A record id already used by another source in the same scope is reassigned to this
  source (documented; it stays inside one tenant).
- **Why:** gate "a re-run ingestion leaves one copy"; Mastra's `upsert({ deleteFilter })` precedent.
- **Test home:** `vector-store-service.test.ts`; conformance rows "re-run leaves one copy", "shrink
  removes stale chunks", "reassigned id".

### 3.7 pgvector adapter

- **Decision:** `new PgVectorStore({ db, ensure?, onClose? })` takes a raw Drizzle PostgreSQL
  database (`drizzle(pool)`), NOT the opaque `DrizzleDatabase` handle given to DatabasePlugin
  (review M2). Supported drivers are node-postgres (tested against real PostgreSQL) and postgres-js
  (its array result shape is unit-tested; `postgres` is not in `EXTERNAL_RANGES`, so no real run).
  Construction refuses a db without `execute` and `transaction`; neon-http and other drivers whose
  `transaction` throws are documented as unsupported. It lazily loads `drizzle-orm` (awaited literal
  import inside try/catch, `OptionalDependencyUnavailableError`) for `sql`, and normalises
  `{ rows }`/array results as `DrizzleAdapter.rawQuery` does. Per collection: table
  `vs_<name>(scope text, id text, source_id text, content text, metadata jsonb, embedding vector(<d>), primary key (scope, id))`
  in the connection's `search_path` schema, index `vs_<name>_src (scope, source_id)`, HNSW index
  `vs_<name>_hnsw vector_cosine_ops`. `ensure: 'create'` (default) creates missing objects;
  `'verify'` only checks them and refuses missing ones, for applications that create tables in
  migrations (concurrent replica start-up can race on DDL). In both modes it requires the `vector`
  extension at version ≥ 0.8.0 (`VectorOperationUnsupportedError` otherwise) and checks the column's
  dimensions (`VectorCollectionMismatchError`). Every query runs in `db.transaction` with
  `tx.execute(SET LOCAL hnsw.ef_search = max(40, topK))` and
  `SET LOCAL hnsw.iterative_scan = strict_order` (results stay in distance order; review M1), as an
  inner query ordered by distance, with `minScore` and the final `ORDER BY score DESC, id` applied
  in an outer query (so `minScore` does not defeat the index). `replaceSource` runs in one
  transaction that first takes `pg_advisory_xact_lock` keyed on table, scope and source, so
  concurrent replacements of one source serialise (code review 2026-11-04). The guide documents
  drizzle-kit's `tablesFilter: ['!vs_*']` so `push` never offers to drop these tables.
- **Why:** pgvector through Drizzle is the dominant TS pattern; Drizzle 0.45.2 has the types.
- **Test home:** `pgvector-store.test.ts` (recording fake: bound parameters only, scope in every
  statement, `SET LOCAL` through `tx`, transaction for `replaceSource`, load error);
  `pgvector-store.real.test.ts` (guarded by `PGVECTOR_URL`).

### 3.8 Qdrant adapter

- **Decision:** `new QdrantVectorStore({ client, onClose? })` takes the application's
  `QdrantClient`, typed by a structural facade (`collectionExists`, `getCollection`,
  `createCollection`, `createPayloadIndex`, `upsert`, `query`, `delete`) validated at construction;
  src never imports `@qdrant/js-client-rest`. Per collection: Qdrant collection `vs_<name>` with
  vectors `{ size, distance: 'Cosine' }`; payload indexes `scope` (`keyword`, `is_tenant: true`),
  `source_id` (`keyword`), and each filterable field (`keyword`, `float` or `bool` by declared
  type). An existing collection is verified through `getCollection` (size and distance;
  `VectorCollectionMismatchError`). Point ids: the first 128 bits of `vectorRecordKey` formatted as
  a UUID; the original id is stored in the payload. Every `query`, `delete` and cleanup carries
  `must: [{ key: 'scope', match: { value } }]`; delete-by-ids is a filter
  `must: [scope, { has_id }]` (a points selector cannot carry the scope). Number `eq` and `in`
  translate to `range` conditions (one `range { gte: v, lte: v }`, or `should` of ranges), never
  `match`, because `match` on floats is not relied on (review M8). Writes pass `wait: true`.
  `replaceSource` upserts, then deletes `must [scope, source_id]`, `must_not [has_id: new ids]`; the
  two calls are not atomic, so replacements of the same source must not run concurrently (one could
  delete the other's records); the guide and the adapter's JSDoc say to serialise them per source.
- **Why:** maintainer decision; Qdrant's documented `is_tenant` design.
- **Test home:** `qdrant-store.test.ts` (recording fake asserting each request body);
  `qdrant-store.real.test.ts` (guarded by `QDRANT_URL`).

### 3.9 Vectorize adapter

- **Decision:** `new VectorizeVectorStore({ index })` in cloudflare-plugin takes a binding of the
  CURRENT `Vectorize` class (`index.d.ts:18004`), not the deprecated beta `VectorizeIndex` (review
  B2), through a structural facade (`describe`, `query`, `upsert`, `deleteByIds`). Scope →
  namespace. The stored id is the 64-character hex `vectorRecordKey(scope, id)` (index-global ids
  would otherwise let two tenants overwrite each other), with the original id in metadata.
  `ensureCollection` verifies `describe().dimensions` only: the current API does not report the
  metric, so the README and guide tell users to create the index with `--metric cosine` and the
  metadata indexes with `wrangler vectorize create-metadata-index` for every declared field.
  `replaceSource` and `deleteScope` throw `VectorOperationUnsupportedError` (no delete by namespace
  or filter exists). Writes are applied asynchronously (`{ mutationId }`); the guide states that a
  read may not see a write yet, and no test reads its own Vectorize write through a live index.
  Documented limits: 50,000 namespaces per index on Workers Paid (1,000 on Free) caps the tenants
  per index.
- **Why:** verified binding surface; hashed ids close a cross-tenant overwrite.
- **Test home:** `cloudflare-plugin/test/unit/vectorize-store.test.ts` (a fake implementing only the
  documented semantics — namespace before filter, implicit AND, index-global ids — each with its
  docs citation).

### 3.10 Validation before I/O, in one place; errors carry their HTTP meaning

- **Decision:** `VectorStoreService` validates collection, scope, ids, records (§3.6), vector length
  equal to the declared dimensions with finite components and a non-zero norm, `topK` integer 1–50
  (Vectorize's limit with metadata, applied everywhere), `minScore` finite in `[-1, 1]`, and filters
  (§3.5), then calls the adapter. Caller errors carry `withHttpStatusHint` (`status-hint.ts:141`):
  `VectorFilterError`, `VectorDimensionError`, `VectorRecordError`, `VectorScopeInvalidError` → 400;
  `VectorScopeRequiredError` → 400; `VectorCollectionUnknownError` → 500 (a programming error). The
  pgvector and Qdrant adapters classify transport failures with `toBackendFault`
  (`backend-fault.ts:244`) so an outage answers 503/504, not a masked 500 (review M9).
- **Why:** one implementation for every entry point; repository error conventions.
- **Test home:** `vector-store-service.test.ts` (hostile numerics, bounds, short-circuit: a refused
  call never reaches the adapter); adapter tests for fault classification.

### 3.11 One conformance table, as data

- **Decision:** `test/integration/conformance.test.ts` defines records (two scopes, several sources,
  typed metadata; fixture vectors chosen so neighbouring scores differ by more than 1e-3) and cases
  once. RESULT rows run on memory (the oracle), the Vectorize fake, and — when `PGVECTOR_URL` /
  `QDRANT_URL` are set — real pgvector and real Qdrant, asserting identical ids in identical order
  and scores within 1e-4. TRANSLATION rows run the pgvector and Qdrant recording fakes and assert
  the exact statement or request each case produces (a recording fake cannot evaluate results;
  review M1). Rows: ordering and ties; every operator on every type; `and`; `minScore`; tenant-leak
  negative controls on every adapter; `deleteScope` above 1,000 records; `replaceSource` re-run,
  shrink and reassignment; every refusal, including Vectorize's REFUSED cells.
- **Why:** ROADMAP decision 3; the `filter-conformance.test.ts` precedent.
- **Test home:** that file.

### 3.12 Embedding stays in the application

- **Decision:** no embedder port. The example's generated plugin `embeddings` registers an
  application-local token `createCapabilityToken('embeddings')` whose service holds an AI SDK
  `EmbeddingModel` built with `@ai-sdk/openai-compatible` from `EMBED_BASE_URL` / `EMBED_MODEL`
  (defaults: the local `qwen3-embedding-0.6b` at `http://localhost:8081/v1`, 1,024 dimensions) — the
  `apps/ai-chat` `CHAT_MODELS` pattern. The guide shows `embedMany` and recording spend under M134's
  `createQuota`. Tests override the token with `MockEmbeddingModelV4`; a guarded live case runs when
  `EMBED_BASE_URL` answers.
- **Why:** maintainer decision; M134 kept the AI SDK unwrapped.
- **Test home:** example smoke and its live case.

### 3.13 `setu add vector-store`

- **Decision:** an `ADDABLE` entry `vector-store` → `vector-store-plugin` with no static peers; the
  adapters' load errors name what to install. Not zero-config wiring (collections are required).
- **Why:** adapters take injected clients; only pgvector lazily loads `drizzle-orm`.
- **Test home:** `packages/cli/test/unit/commands/add.test.ts`.

### 3.14 Example app `apps/semantic-search`, offered via `--example`

- **Decision:** generated with this tree's CLI: `setu new --template rest`, then `setu add queue`,
  `setu add multi-tenancy`, `setu add vector-store`,
  `generate module documents --adopt-controllers`, `generate job ingest-document` (functional jobs
  wire through the queue plugin; `schematics/job.ts`, `registry.ts:168-176`),
  `generate plugin embeddings`; greeting removed; `setu sync`. CLI-owned files byte-identical,
  `setu check` clean, structure diff limited to retrieval additions (the `apps/mcp-tools` rules).
  Routes: `POST /documents` (validated body; enqueues the job) and `GET /search?q=&tag=`. The job
  validates the tenant with `lookupTenant`, splits text with a plain splitter, embeds with
  `embedMany`, and calls `replaceSource`. Tenancy: header resolver with a fixed tenant registry.
  Store: memory by default; pgvector when `PGVECTOR_URL` is set, built in the `adapter` factory. The
  smoke awaits ingestion by polling the search route with a bounded deadline (the job runs on the
  memory queue in-process). Smoke cases: ingest and search; tenant isolation; re-ingest leaves one
  copy; undeclared filter → 400; dimension mismatch refused; guarded pgvector and live-Qwen cases.
- **Why:** maintainer decision.
- **Test home:** `apps/semantic-search/smoke.ts`; the CLI `--example` e2e.

### 3.15 CI backends

- **Decision:** switch every CI and local-CI PostgreSQL from `postgres:16` to
  `pgvector/pgvector:0.8.1-pg16` and add a Qdrant service `qdrant/qdrant:v1.20.0` (both tags
  verified, §1); export `PGVECTOR_URL` and `QDRANT_URL` to the package shard.
- **Why:** the gate requires real pgvector and Qdrant runs.
- **Test home:** `test/unit/local-ci-plan.test.ts`; the guarded real suites.

### 3.16 Release

- **Decision:** the new exports are `@since 0.12.0`, the release M132–M134 ship in (assumed; the
  maintainer has not overridden it). The CHANGELOG entry sits under Unreleased and names the PR.
- **Test home:** `pnpm run check:docs` (`@since` check).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none (new token, new port, new package, one new cloudflare-plugin
export).

| Exported symbol                                                                                                                                                                                                                      | Kind      | Consumer / real code path that READS it                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.VECTOR_STORE` (common)                                                                                                                                                                                                 | token     | `VectorStorePlugin` registers under it; the example resolves it.                                  |
| `IVectorStore`, `VectorRecord`, `VectorQuery`, `VectorMatch`, `VectorFilter`, `VectorCollectionSpec` (common)                                                                                                                        | types     | The service implements `IVectorStore`; adapters and the example use the data types.               |
| `IVectorStoreAdapter` (common)                                                                                                                                                                                                       | interface | Implemented by the four adapters; called by `VectorStoreService`.                                 |
| `vectorRecordKey` (common)                                                                                                                                                                                                           | fn        | Qdrant and Vectorize adapters derive stored ids from it.                                          |
| `VectorScopeRequiredError`, `VectorScopeInvalidError`, `VectorFilterError`, `VectorDimensionError`, `VectorRecordError`, `VectorCollectionUnknownError`, `VectorCollectionMismatchError`, `VectorOperationUnsupportedError` (common) | classes   | Thrown by the service and all four adapters; the error handler reads their status hints.          |
| `VectorStorePlugin`, `VectorStorePluginOptions`                                                                                                                                                                                      | fn, type  | The example's `setu.config.ts`.                                                                   |
| `VectorStoreTenancy`, `MemoryVectorStoreOptions`, `PgVectorStoreOptions`, `PgVectorDatabase`, `PgVectorExecutor`, `QdrantClientLike`, `QdrantVectorStoreOptions`                                                                     | types     | Option and facade types of the plugin and its adapters; the example and the guide construct them. |
| `MemoryVectorStore`, `PgVectorStore`, `QdrantVectorStore`                                                                                                                                                                            | classes   | The example (memory, pgvector); Qdrant through the guide and its real suite.                      |
| `VectorizeVectorStore` (cloudflare-plugin)                                                                                                                                                                                           | class     | A Worker application; the guide's Workers section.                                                |
| `VectorizeIndexLike`, `VectorizeVectorLike`, `VectorizeVectorStoreOptions` (cloudflare-plugin)                                                                                                                                       | types     | The binding facade and options a Worker passes.                                                   |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                     | Behavior (per implementation)                                                                |
| --------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| `adapter`                         | plugin `register()`          | An adapter, or a factory `(runtime) => adapter \| Promise<adapter>` resolved once. Required. |
| `collections`                     | plugin `register()`; service | Declared specs; ensured at registration; validation reads `dimensions` and `filterable`.     |
| `tenancy`                         | `IVectorStore.scopeFor`      | `'required'` (default) throws without a tenant; `{ fixed }` always returns the fixed scope.  |
| `PgVectorStore` `db`              | pgvector adapter             | Raw Drizzle PostgreSQL db with `execute` and `transaction`; refused otherwise.               |
| `PgVectorStore` `ensure`          | `ensureCollection`           | `'create'` (default) creates missing objects; `'verify'` refuses them.                       |
| `onClose` (all built-in adapters) | adapter `close()`            | Called once at shutdown, e.g. to end a pool the factory created.                             |
| `QdrantVectorStore` `client`      | Qdrant adapter               | The application's client; facade validated at construction.                                  |
| `VectorizeVectorStore` `index`    | Vectorize adapter            | The current `Vectorize` binding; facade validated at construction.                           |

## 5. Implementation files

| File                                                                                 | Purpose                                      |
| ------------------------------------------------------------------------------------ | -------------------------------------------- |
| `packages/common/src/services/vector-store.ts`                                       | Port and data types.                         |
| `packages/common/src/errors/vector-store.ts`                                         | The eight named errors with status hints.    |
| `packages/common/src/vector-record-key.ts`                                           | `vectorRecordKey`.                           |
| `packages/common/src/tokens.ts`, `src/index.ts`                                      | `VECTOR_STORE` token; barrel.                |
| `packages/vector-store-plugin/src/index.ts`, `src/version.ts`                        | Barrel exports; `VERSION`.                   |
| `src/plugin/vector-store-plugin.ts`                                                  | Plugin: options, lifecycle (§3.2).           |
| `src/services/vector-store-service.ts`                                               | Validation (§3.10), `scopeFor`, delegation.  |
| `src/services/collection-spec.ts`                                                    | Spec, name and field-name grammar.           |
| `src/services/record-validation.ts`                                                  | §3.6 record and batch validation.            |
| `src/services/filter-validation.ts`                                                  | §3.5 validator.                              |
| `src/adapters/memory/memory-vector-store.ts`                                         | Brute-force oracle and its filter evaluator. |
| `src/adapters/pgvector/pgvector-store.ts`, `pgvector-sql.ts`                         | Adapter; SQL and filter translation.         |
| `src/adapters/qdrant/qdrant-store.ts`, `qdrant-filter.ts`                            | Adapter; filter translation.                 |
| `packages/cloudflare-plugin/src/vectorize/vectorize-store.ts`                        | Vectorize adapter.                           |
| `packages/cli/src/commands/add.ts` and the registry files of §5.1                    | `setu add vector-store`; registrations.      |
| `apps/semantic-search/**`                                                            | Generated example (§3.14).                   |
| `docs/retrieval.md`, plugin `README.md`, `AGENT_CARD.md`, `LICENSE`, `tsconfig.json` | Guide and package files.                     |

### 5.1 Registries a new package, example and guide must touch

Every one of these failed a gate on M133, M134 or #554 when missed:

| File                                                                                                                                                                                                                          | Change                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `scripts/release-packages.ts`, `scripts/jsr-metadata.ts`                                                                                                                                                                      | `PUBLISHED_PACKAGES`; `PACKAGE_METADATA` description.                                   |
| `compat/compat.test.mjs`, `compat/package.json`                                                                                                                                                                               | `PENDING_FIRST_PUBLISH` until the first publish.                                        |
| `tsconfig.json` references, `tsconfig.check.json`, `typedoc.check.json`                                                                                                                                                       | The new member.                                                                         |
| `scripts/generate-api-docs.ts`, `test/api-docs-generation.test.ts`                                                                                                                                                            | API reference generation.                                                               |
| `scripts/fixtures/node-boot/boot.mjs`                                                                                                                                                                                         | Installed-member count 53 → 54.                                                         |
| `test/version-constant.test.ts`                                                                                                                                                                                               | The package's `VERSION`.                                                                |
| `packages/cli/src/agents/package-data.ts`, `packages/cli/src/devtool/sources.ts`, `packages/cli/test/unit/agents/budget.test.ts`                                                                                              | `PACKAGE_DATA` (token `VECTOR_STORE`); `FRAMEWORK_PACKAGES`; card budget.               |
| `packages/vector-store-plugin/AGENT_CARD.md`; `test/agent-card-gate.test.ts`, `test/package-readme-fence-compiler.test.ts`, `test/set-jsr-metadata-dry-run.test.ts`, `test/unit/jsr-sunset.test.ts`, `test/apps-gate.test.ts` | Gates that enumerate packages, cards, READMEs and apps.                                 |
| `scripts/node-dependency-ranges.ts`                                                                                                                                                                                           | `@qdrant/js-client-rest` exact range (devDependency for the real suite).                |
| `scripts/node-manifests.ts`, root `package.json`                                                                                                                                                                              | Root devDependencies the guide's fences need.                                           |
| `packages/cli/src/examples/catalog.ts`, `manifest.ts`, `new.ts`; `scripts/generate-example-manifest.ts`; `test/example-manifest.test.ts`; `packages/cli/test/unit/examples.test.ts`                                           | Offer `semantic-search`; regenerate the manifest.                                       |
| `scripts/check-deploy.ts`                                                                                                                                                                                                     | Exclusion entry (the `rest-api` shape).                                                 |
| `website/src/lib/docs-nav.ts`, `docs/README.md`, `docs/cli.md`, `docs/examples.md`, `docs/plugins.md`, `apps/README.md`                                                                                                       | Guide and example listings.                                                             |
| `website/test/repository.test.ts`                                                                                                                                                                                             | `PACKAGES` 53 → 54, carded 51 → 52, `APPS` + 1 (`ci:local` does not run website tests). |
| `test/guide-fence-compiler.test.ts`, fence fixtures                                                                                                                                                                           | `docs/retrieval.md` fence counts.                                                       |
| `.github/workflows/{ci,drift,release}.yml`, `scripts/lib/local-ci-plan.ts`                                                                                                                                                    | §3.15 images and env.                                                                   |
| `packages/cloudflare-plugin/README.md`, `AGENT_CARD.md`                                                                                                                                                                       | The new Vectorize export.                                                               |
| `CHANGELOG.md`, `PUBLIC_API.md`, `ROADMAP.md`, `CLAUDE.md`                                                                                                                                                                    | Entries naming the PR; §2 corrections and the Progress row; the status line.            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                            | Key assertions                                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/vector-store-contract.test.ts`      | `services/vector-store.ts`, token      | Token value and grammar; shapes compile against §4.                                                                                                             |
| `common/test/unit/vector-store-errors.test.ts`        | `errors/vector-store.ts`               | Each error's name, message and status hint.                                                                                                                     |
| `common/test/unit/vector-record-key.test.ts`          | `vector-record-key.ts`                 | Deterministic; length-prefixed (`('a                                                                                                                            | 1','b')`≠`('a','1 | b')`); hex format. |
| `test/unit/vector-store-plugin.test.ts`               | `vector-store-plugin.ts`               | §3.2 lifecycle, factory forms, startup failure, shutdown close, duplicate registration.                                                                         |
| `test/unit/collection-spec.test.ts`                   | `collection-spec.ts`                   | Name and field grammar; reserved names; 10-field cap; dimension bounds.                                                                                         |
| `test/unit/record-validation.test.ts`                 | `record-validation.ts`                 | Own-key metadata; undeclared and mistyped keys; caps; batch limits.                                                                                             |
| `test/unit/filter-validation.test.ts`                 | `filter-validation.ts`                 | Every §3.5 refusal; adapter spy never called.                                                                                                                   |
| `test/unit/vector-scope.test.ts`                      | `vector-store-service.ts` (`scopeFor`) | Tenant present; `{ fixed }` ignores the tenant; required without tenant; invalid scope.                                                                         |
| `test/unit/vector-store-service.test.ts`              | `vector-store-service.ts`              | Hostile numerics, zero norm, `topK` 0/51/1.5, `minScore`, short-circuit.                                                                                        |
| `test/unit/memory-vector-store.test.ts`               | memory adapter                         | Ordering and ties, filters, `replaceSource`, `deleteScope`.                                                                                                     |
| `test/unit/pgvector-store.test.ts`                    | pgvector adapter + sql                 | Recording fake: bound values and keys, scope in every statement, `SET LOCAL` through `tx`, inner/outer query, `ensure` modes, load error, fault classification. |
| `test/integration/pgvector-store.real.test.ts`        | pgvector adapter                       | Guarded `PGVECTOR_URL`: ensure, dimension mismatch, extension version, tenant leak, filtered recall.                                                            |
| `test/unit/qdrant-store.test.ts`                      | Qdrant adapter + filter                | Recording fake: scope `must` on every call, UUID ids, payload indexes, number ranges, `wait: true`, fault classification.                                       |
| `test/integration/qdrant-store.real.test.ts`          | Qdrant adapter                         | Guarded `QDRANT_URL`, real client.                                                                                                                              |
| `test/integration/conformance.test.ts`                | all adapters                           | §3.11.                                                                                                                                                          |
| `test/e2e/vector-store-e2e.test.ts`                   | plugin through a kernel app            | A route using `scopeFor` under multi-tenancy returns only its tenant's matches; a filter refusal answers 400.                                                   |
| `cloudflare-plugin/test/unit/vectorize-store.test.ts` | `vectorize-store.ts`                   | Namespace = scope; hashed ids; `describe()` dimension check; two refusals; content cap.                                                                         |
| `apps/semantic-search/smoke.ts`                       | example                                | §3.14.                                                                                                                                                          |

A guarded real-import test covers the pgvector adapter's lazy `drizzle-orm` load; the branch around
it is unit-tested through an injection seam.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m135-vector-store, never main
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test
pnpm run test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run ci:local          # final commit, with PGVECTOR_URL and QDRANT_URL services
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

Plus: the example's live run against `qwen3-embedding-0.6b` and a real pgvector database; the
`--example semantic-search` e2e against packed packages; a fresh-agent **security audit (tenant
isolation)** on the final commit.

## 8. Risks & mitigations

- The Vectorize fake drifts from the real service (no local Vectorize exists) → the fake encodes
  only documented semantics (namespace before filter, implicit AND, index-global ids), each cited in
  the test; the README marks a live Workers run as unverified.
- pgvector's HNSW post-filter returns fewer than `topK` under a selective filter → iterative scan
  `relaxed_order`; the docs state that any adapter may return fewer than `topK`.
- Qdrant `replaceSource` is two calls → upsert-then-delete-stale order; documented; the conformance
  "shrink" row checks the end state.
- Switching CI to `pgvector/pgvector:pg16` changes an image every PostgreSQL suite uses → it is the
  official image built on the same PostgreSQL 16; the first CI run is the proof, and a revert is one
  line per workflow.
- Embedding model drift (vectors from different models are not comparable) → the guide's
  re-embedding procedure: a new collection name, dual write, backfill, switch.

- A Vectorize filter on a field with no metadata index, or on vectors written before the index was
  created, is undocumented → the guide requires the indexes before the first write and says so on
  the Workers page; the adapter cannot check it from a binding.
- 50,000 namespaces per Vectorize index (1,000 on Free) caps tenants per index → documented with the
  sharding advice (one index per tenant group).

## 8a. Design security review

**Flow reviewed:** a request (or a job carrying a tenant id) reaches `IVectorStore` with a scope, a
collection, records or a query; the service validates; an adapter translates to SQL, a Qdrant
request or a Vectorize call.

**Assets:** each tenant's vectors, chunk content and metadata; the integrity of each tenant's index.

**Attackers:** a tenant user trying to read, overwrite or delete another tenant's records; a caller
supplying hostile filters, metadata, ids or vectors; a misconfigured application (no tenant, fixed
scope).

| #   | Obligation                                                                        | Mechanism                                                                                       | Probe (positive and negative control)                                                                                                                                            |
| --- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | A query under scope A never returns scope B's records, on every adapter.          | Scope as a required argument mapped to a native boundary (§3.3).                                | Conformance tenant-leak rows on memory, Vectorize fake, real pgvector, real Qdrant; negative control: an adapter with the scope predicate removed fails the row.                 |
| O2  | A write or delete under scope A never changes scope B's records.                  | Scope in the primary key (pgvector), in every Qdrant filter, in hashed ids (Qdrant, Vectorize). | Same record id written under A and B stays two records; `delete`/`replaceSource`/`deleteScope` under A leave B intact; negative control: Vectorize with unhashed ids overwrites. |
| O3  | A filter is never dropped or widened.                                             | Service validation (§3.5) plus adapter refusals; 64-byte string cap.                            | Each refusal row; an undeclared field throws before I/O (adapter spy).                                                                                                           |
| O4  | No injection through collection names, field names or values.                     | Grammars at registration; bound values and keys in SQL; Qdrant/Vectorize structured bodies.     | pgvector recording fake asserts no field name or value appears in statement text; hostile names refused at registration.                                                         |
| O5  | Tenant-less requests never share a tenant's rows.                                 | `{ fixed }` always returns the fixed scope; `'required'` throws.                                | `scopeFor` rows with and without a tenant under both modes.                                                                                                                      |
| O6  | Hostile input cannot crash a tenant's index or the process.                       | Record validation by own keys; finite non-zero vectors; batch caps.                             | `__proto__`/`constructor` keys, NaN, Infinity, zero vectors, 10,001 ids refused.                                                                                                 |
| O7  | Backend outages are not reported as caller errors and leak no connection details. | `toBackendFault` classification; existing URL-credential masking.                               | Adapter tests with a rejecting client: 503/504 with value-free detail.                                                                                                           |

**Findings at plan time:** the plan review (2026-11-04) found the `{ fixed }` scope mixing (M7),
index-global Vectorize ids (closed by hashing), unvalidated metadata and field names (M3) and the
64-byte Vectorize prefix match (M4); all are closed by the decisions above. The committed-tree audit
on the final commit follows `.roo/skills/security-audit/SKILL.md` in a fresh agent.

## 9. Out of scope

- An embedder port or any AI SDK wrapper — the AI SDK owns embedding (maintainer decision).
- Hybrid search, re-ranking, MMR, sparse vectors, metadata-only queries.
- MongoDB Atlas and Cosmos DB vector search — named follow-ons.
- Dot-product and euclidean metrics.
- Store metrics, diagnostics and a health indicator.
- Document loaders and a chunking library.
