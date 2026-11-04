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

| Reference                                                    | Source (file:line)                                                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES`                                               | `packages/common/src/tokens.ts:39-313`                                                                                                                                                                                       | No vector, embedding or retrieval token exists. `createCapabilityToken` (`:353`) enforces `^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.…)*$` (`:326-334`); `vector-store` passes.                                                                                                            |
| `FilterExpression` / `FilterOperator`                        | `packages/common/src/services/database.ts:76,83,114`                                                                                                                                                                         | Operators `eq contains gt gte lt lte in` plus `and`/`or`; `field` may be a path array. No `ne`/`not`. The vector filter is a narrower, separate type (§3.5).                                                                                                                    |
| `matchesFilter`                                              | `packages/database-plugin/src/query/query-builder.ts:157`                                                                                                                                                                    | Internal to database-plugin (not in `src/index.ts`; `package.json` exports only `.`). The vector-store memory adapter needs its own evaluator over the narrower filter (§3.5); nothing is shared or re-exported.                                                                |
| `IDatabaseService.query()`                                   | `packages/database-plugin/src/interfaces/index.ts:247`                                                                                                                                                                       | The only registry-reachable SQL route; untyped, applies no tenant scope, refused on memory (`UnsupportedRawQueryError`, `errors.ts:217`). Not used: the pgvector adapter takes the application's Drizzle instance (§3.7).                                                       |
| `getDrizzleDatabase` / `createDrizzleDatabase`               | `packages/database-plugin/src/query/drizzle-query.ts:115`, `drizzle-database.ts:141`                                                                                                                                         | The native Drizzle db is an application-held handle; a plugin cannot obtain it from the registry. Precedent for the adapter taking it as a constructor argument: `D1Adapter(db)` (`cloudflare-plugin/src/database/d1-adapter.ts:170`).                                          |
| Drizzle raw `execute()`                                      | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:515-546`                                                                                                                                                   | Executes a bound `sql` statement; result is `{ rows }` (node-postgres) or an array (postgres-js), normalised as `(result.rows ?? result)`; a db without `execute` is refused. The pgvector adapter reuses this shape.                                                           |
| Drizzle lazy load                                            | `drizzle-adapter.ts:294` (`await import('drizzle-orm')`)                                                                                                                                                                     | The awaited literal import pattern (AI_GUIDELINES §12.2) the pgvector adapter follows.                                                                                                                                                                                          |
| drizzle-orm 0.45.2 vector support                            | `node_modules/drizzle-orm/sql/functions/vector.d.ts:26,70,93`; `pg-core/columns/vector_extension/vector.d.ts:40`                                                                                                             | `cosineDistance`, `l2Distance`, `innerProduct`, `vector(name, { dimensions })` exist. pgvector-node is NOT needed (it has no Drizzle integration because Drizzle ships one).                                                                                                    |
| Tenant in a request                                          | `packages/common/src/http.ts:69`                                                                                                                                                                                             | `ctx.request.tenant?: ITenant` (set by the multi-tenancy middleware).                                                                                                                                                                                                           |
| `IMultiTenancyService`                                       | `packages/common/src/services/tenancy.ts:78,136`                                                                                                                                                                             | `lookupTenant(id): Promise<Option<ITenant>>` validates a job payload's tenant id — the non-request entry point the example's ingest job uses.                                                                                                                                   |
| Tenant scoping precedent outside database-plugin             | `packages/cache-plugin/src/utils/cache-key.ts:42-48`                                                                                                                                                                         | Reads `ctx.request.tenant?.id` and length-prefixes it into the key — the shape `vectorScope(ctx)` follows.                                                                                                                                                                      |
| `IQueue` / `AddJobOptions`                                   | `packages/common/src/services/queue.ts:59-77,131-150`                                                                                                                                                                        | `add(name, data, options?)` returns a queue-assigned id; options are only `delayMs`, `maxAttempts`, `headers`. **No caller job id, no dedup.** A re-run's idempotency must come from the store (`replaceSource`, §3.9), not the queue.                                          |
| Job schematic                                                | `packages/cli/src/schematics/job.ts`; `generate.ts:377`                                                                                                                                                                      | `setu generate job` exists; the example's ingest worker is generated, not hand-written.                                                                                                                                                                                         |
| `ICloudflareBindings.get<T>`                                 | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:77,184`                                                                                                                                                         | Generic accessor for bindings with no facade (doc names Vectorize). No Vectorize code exists.                                                                                                                                                                                   |
| Vectorize binding (`@cloudflare/workers-types` 5.20261104.1) | `index.d.ts:17958-17999, 17816-17825, 17854-17860`                                                                                                                                                                           | `describe()`, `query(vector, { topK, namespace, returnMetadata, filter })`, `upsert`, `deleteByIds`, `getByIds`. Filter ops `$eq $ne $lt $lte $gt $gte $in $nin`, implicit AND. **No delete-by-namespace or delete-by-filter.** Vector ids are index-global, not per namespace. |
| `@qdrant/js-client-rest` 1.20.0                              | `dist/types/qdrant-client.d.ts:222,289,541,604,848,875`; `generated_schema.d.ts:1082,1317`                                                                                                                                   | `upsert`, `delete` (by points or filter), `createCollection`, `createPayloadIndex` (keyword `is_tenant`), `collectionExists`, `query` (`filter`, `limit`, `score_threshold`, `with_payload`). `ExtendedPointId: number                                                          | string` and the server requires an unsigned int or a UUID. |
| AI SDK 7.0.159                                               | `ai/dist/index.d.ts:7922,8076,8977`; `ai/dist/test/index.d.ts:61`                                                                                                                                                            | `embed`, `embedMany`, `cosineSimilarity`; `MockEmbeddingModelV4` in `ai/test`. Only the root and `apps/ai-chat` depend on `ai`; it is not in `EXTERNAL_RANGES`/`CLIENT_RANGES`.                                                                                                 |
| Optional peers                                               | `scripts/node-manifests.ts:20-26,465-470`; `scripts/node-dependency-ranges.ts:26`                                                                                                                                            | Peers are DERIVED from dynamic/type-only imports; each range must exist in `EXTERNAL_RANGES` (`drizzle-orm: '0.45.2'` `:78`).                                                                                                                                                   |
| New-package registries                                       | `scripts/release-packages.ts:7`; `scripts/jsr-metadata.ts:161`; `compat/compat.test.mjs:26`; `packages/cli/src/agents/package-data.ts:18`; `packages/cli/src/devtool/sources.ts:171`; `packages/cli/src/commands/add.ts:166` | `PUBLISHED_PACKAGES`, `PACKAGE_METADATA`, `PENDING_FIRST_PUBLISH`, `PACKAGE_DATA` (tokens must exist and appear in src), `FRAMEWORK_PACKAGES`, `ADDABLE`; `AGENT_CARD.md` required by `scripts/npm-release-gate.ts:48-61`.                                                      |
| CI PostgreSQL                                                | `.github/workflows/ci.yml:149`; `drift.yml:86`; `release.yml:99`; `scripts/lib/local-ci-plan.ts:265`                                                                                                                         | Plain `postgres:16`; pgvector is absent everywhere.                                                                                                                                                                                                                             |
| Weighted quota (for the guide)                               | `packages/auth-plugin/src/quota/quota.ts:46`                                                                                                                                                                                 | `createQuota` / `IQuota.reserve`/`settle` — documented for embedding spend; no code dependency.                                                                                                                                                                                 |
| Local embedding model (live test)                            | probed 2026-11-04: `POST localhost:8081/v1/embeddings`                                                                                                                                                                       | `qwen3-embedding-0.6b`, OpenAI-compatible, 1,024 dimensions, `usage.prompt_tokens` reported.                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                            | Resolution (picked side)                                                                                                      | Doc deliverable (same PR)                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1  | ROADMAP M135 decision 4 plans an embedder port "building on the AI SDK and M134 quota"; M134 shipped no AI package. | No embedder port (maintainer, 2026-11-04). The store takes vectors.                                                           | ROADMAP M135 section rewritten to the shipped scope.  |
| C2  | ROADMAP decision 6: "ingestion as a queue job with an idempotent document id"; the queue has no caller job id.      | Idempotency comes from `replaceSource` keyed by `(scope, sourceId)`; the queue job is the example's, not a framework feature. | ROADMAP M135 section; `docs/retrieval.md`.            |
| C3  | ROADMAP decision 5 lists memory, pgvector, Vectorize; the maintainer added Qdrant.                                  | Four adapters.                                                                                                                | ROADMAP M135 section and Progress Tracking row.       |
| C4  | ROADMAP decision 3 implies every adapter supports every operation; Vectorize cannot delete by namespace or filter.  | The conformance table marks those cells REFUSED, asserted as a named error.                                                   | `docs/retrieval.md` capability matrix; plugin README. |

## 3. Design decisions

### 3.1 Package, token and port placement

- **Decision:** `CAPABILITIES.VECTOR_STORE = 'vector-store'` and the port types in
  `packages/common/src/services/vector-store.ts`; the plugin, service, memory/pgvector/Qdrant
  adapters in `packages/vector-store-plugin`; `VectorizeVectorStore` in `packages/cloudflare-plugin`
  (the `D1Adapter` precedent: platform adapters live with the platform plugin and implement a
  `common` port). No plugin imports another plugin.
- **Why:** AI_GUIDELINES §1.3/§2.2 ports-in-common; ROADMAP decision 1.
- **Test home:** `common/test/unit/vector-store-contract.test.ts`; `test/agent-package-data.test.ts`
  (token appears in src).

### 3.2 Collections are declared at registration

- **Decision:** `VectorStorePlugin({ adapter, collections })` takes every collection's spec
  `{ name, dimensions, filterable }` up front. At application start the plugin calls
  `adapter.open(runtime)` once (adapters hash ids with `runtime.subtle`,
  `common/src/runtime.ts:344`, never a global crypto), then `adapter.ensureCollection(spec)` for
  each, in order; an existing collection with a different dimension or metric fails startup with
  `VectorCollectionMismatchError`. Dimensions are integers from 1 to 4,096 at registration; an
  adapter refuses a spec beyond its own limit in `ensureCollection` with
  `VectorOperationUnsupportedError` (pgvector HNSW 2,000; Vectorize 1,536; Qdrant none below 4,096).
  Port calls name a collection; an undeclared name throws `VectorCollectionUnknownError` before any
  I/O. Collection names match `^[a-z][a-z0-9_]{0,47}$` (safe as a pgvector table suffix, a Qdrant
  collection, and within Vectorize limits), refused at registration otherwise.
- **Why:** Mongo, Vectorize, Qdrant and S3 Vectors need filterable fields declared before insert
  (survey §2); declaring once in the plugin lets ONE validator refuse undeclared fields for every
  adapter.
- **Test home:** `vector-store-plugin.test.ts`, `collection-spec.test.ts`.

### 3.3 Tenant scope is a required argument, never a filter key

- **Decision:** every port method takes `scope: string` as its second argument. The plugin option
  `tenancy` is `'required'` (default) or `{ fixed: string }`. `vectorScope(ctx)` returns
  `ctx.request.tenant.id`; with no tenant it returns the fixed scope when configured, and otherwise
  throws `VectorScopeRequiredError`. Jobs pass a tenant id validated with
  `IMultiTenancyService.lookupTenant` (the example shows it). A scope must be a non-empty,
  well-formed (`isWellFormed()`) string of at most 64 UTF-8 bytes (Vectorize's namespace limit),
  else `VectorScopeInvalidError`. Each adapter maps the scope to its strongest native boundary:
  pgvector a `scope` column in the primary key and every `WHERE`; Qdrant a `scope` keyword payload
  index with `is_tenant: true` plus a `must` condition; Vectorize the namespace; memory a per-scope
  map.
- **Why:** survey §3 pitfall 1 and practitioner guidance — a retriever must be unable to build a
  query without the tenant predicate.
- **Test home:** `vector-scope.test.ts`; the conformance table's tenant-leak rows (§3.11).

### 3.4 Cosine similarity only, one score scale

- **Decision:** M135 supports one metric, cosine. `VectorMatch.score` is cosine SIMILARITY in
  `[-1, 1]`, higher is closer, on every adapter: pgvector returns `1 - (embedding <=> $q)`, Qdrant's
  `Cosine` score is already similarity, Vectorize's cosine score is similarity, memory computes it.
  `minScore` filters on that scale.
- **Why:** every backend supports cosine; scales differ for the other metrics (survey §2 "score
  scale"), and a portable `minScore` needs one scale.
- **Test home:** conformance table (identical ordering and scores within 1e-4 across adapters).

### 3.5 The filter: a narrow, declared, validated type

- **Decision:**
  `VectorFilter = { field, op: 'eq' | 'in' | 'gt' | 'gte' | 'lt' | 'lte', value } | { and: readonly VectorFilter[] }`.
  No `or`, `contains`, `ne`, regex or path arrays. `filterable` maps each field to
  `'string' | 'number' | 'boolean'`. The SERVICE validates every filter before calling the adapter:
  an undeclared field, an operator not allowed for the type (ranges only on `number`), a value of
  the wrong type, a non-finite number, an empty `in`, or nesting deeper than 4 throws
  `VectorFilterError` naming the clause. Each adapter's translator also refuses anything outside the
  type (defence in depth), and values are always bound parameters, never interpolated. Reserved
  field names (`scope`, `id`, `source_id`, `content`) are refused at registration.
- **Why:** survey §6 — every DSL that offered a broad operator set shipped fail-open translator
  bugs; Vectorize has no `or`; Mongo and Vectorize have no substring match. Why not reuse
  `FilterExpression`: it carries `contains`, `or` and path arrays that three of four backends cannot
  honour.
- **Test home:** `filter-validation.test.ts` (each refusal), translator unit tests per adapter.

### 3.6 Records, ids and `replaceSource`

- **Decision:** `VectorRecord = { id, vector, sourceId?, content?, metadata? }`. `metadata` holds
  only declared filterable fields and their typed values; `content` is the chunk text, returned in
  matches but never filterable. Port methods: `upsert(collection, scope, records)`,
  `replaceSource(collection, scope, sourceId, records)`, `query(collection, scope, query)`,
  `delete(collection, scope, ids)`, `deleteScope(collection, scope)`. `replaceSource` writes the new
  records, then deletes that source's records whose ids are not in the new set — so a concurrent
  reader never sees the source empty, and a re-run with the same chunk ids leaves exactly one copy.
  Every record passed to `replaceSource` must carry that `sourceId` (refused otherwise). Ids are
  non-empty, well-formed strings of at most 256 UTF-8 bytes.
- **Why:** ROADMAP gate "a re-run ingestion leaves one copy"; Mastra's `upsert({ deleteFilter })` is
  the precedent (survey §1.3).
- **Test home:** conformance rows "re-run leaves one copy" and "shrinking source removes stale
  chunks".

### 3.7 pgvector adapter: the application's Drizzle instance

- **Decision:** `new PgVectorStore({ db })` takes the application's Drizzle PostgreSQL instance (the
  `D1Adapter(db)` precedent; the same instance the app gives DatabasePlugin). It lazily loads
  `drizzle-orm` (awaited literal import in try/catch, `OptionalDependencyUnavailableError`) for
  `sql` and executes bound statements through `db.execute()`, normalising `{ rows }`/array results
  as the DrizzleAdapter does. Per collection it owns one table
  `vs_<name>(scope text, id text, source_id text, content text, metadata jsonb, embedding vector(<d>), primary key (scope, id))`,
  a B-tree index on `(scope, source_id)`, and an HNSW index `vector_cosine_ops`. `ensureCollection`
  runs `CREATE EXTENSION IF NOT EXISTS vector` only when the option `createExtension: true` is set
  (default false, since it needs superuser), requires extension version ≥ 0.8.0 (named error
  otherwise), and creates or verifies the table. Filtered queries run inside `db.transaction` with
  `SET LOCAL hnsw.iterative_scan = relaxed_order`, so a filter does not collapse recall (survey §3
  pitfalls 4–5). `replaceSource` runs in one transaction.
- **Why:** pgvector via Drizzle is the dominant TS pattern (AI SDK cookbook, Mastra `@mastra/pg`);
  Drizzle 0.45.2 has the types; no pgvector-node dependency.
- **Test home:** `pgvector-store.test.ts` (fake db recording statements and parameters);
  `pgvector-store.real.test.ts` (guarded by `PGVECTOR_URL`).

### 3.8 Qdrant adapter: an injected client

- **Decision:** `new QdrantVectorStore({ client })` takes the application's `QdrantClient`, typed by
  a structural facade declared in the plugin (no import of `@qdrant/js-client-rest` in src, so no
  peer). One Qdrant collection per declared collection (name prefixed `vs_`), vectors
  `{ size, distance: 'Cosine' }`, a `scope` keyword payload index with `is_tenant: true`, and a
  payload index per filterable field. Point ids are a UUID derived from SHA-256 of `(scope, id)`
  (via `IRuntimeServices` crypto), with the original id in the payload, because Qdrant accepts only
  unsigned integers or UUIDs. Every query, delete and `replaceSource` cleanup carries
  `must: [{ key: 'scope', match: { value: scope } }]`. `replaceSource` upserts then deletes by
  filter `(scope, source_id) AND NOT has_id(new ids)`; it is not atomic across the two calls, which
  the guide states.
- **Why:** maintainer decision; Qdrant's documented multitenancy design (`is_tenant` payload index).
- **Test home:** `qdrant-store.test.ts` (recording fake); `qdrant-store.real.test.ts` (guarded by
  `QDRANT_URL`, real client from devDependencies).

### 3.9 Vectorize adapter: namespaces, hashed ids, two refused operations

- **Decision:** `new VectorizeVectorStore({ index })` in cloudflare-plugin takes the
  `VectorizeIndex` binding (structural facade). Scope → namespace. Because Vectorize ids are
  index-global, the stored id is a 64-character hex SHA-256 of `(scope, id)`, with the original id
  in metadata — so two tenants writing the same record id never overwrite each other.
  `ensureCollection` verifies dimensions and metric through `describe()`; an index created from a
  `preset` reports neither (`index.d.ts:17864-17871`), so it is refused with
  `VectorCollectionMismatchError` rather than trusted. Metadata indexes cannot be created from a
  binding, so the README and guide give the `wrangler vectorize create-metadata-index` commands for
  each declared field. `replaceSource` and `deleteScope` throw `VectorOperationUnsupportedError` (no
  delete-by-namespace or by-filter exists). `topK` is capped at 50 (the Vectorize limit with
  metadata), enforced for every adapter by the service so behaviour is uniform.
- **Why:** verified binding surface (§1); a hashed id closes a cross-tenant overwrite.
- **Test home:** `cloudflare-plugin/test/unit/vectorize-store.test.ts` (a fake honouring namespace,
  filter and id semantics per the Cloudflare docs); the conformance table runs it with REFUSED
  cells.

### 3.10 Validation before I/O, in one place

- **Decision:** `VectorStoreService` (the registered `IVectorStore`) validates collection, scope,
  ids, vector length equal to the declared dimensions with every component finite
  (`VectorDimensionError`), `topK` integer 1–50, `minScore` finite in `[-1, 1]`, and filters (§3.5),
  then calls the adapter. Adapters assume validated input but keep their translator refusals.
- **Why:** one implementation, every entry point (CLAUDE.md "one capability, one implementation").
- **Test home:** `vector-store-service.test.ts` with hostile input (NaN, ±Infinity, wrong length,
  `topK` 0/51/1.5, ill-formed scope).

### 3.11 One conformance table, as data

- **Decision:** `test/integration/conformance.test.ts` defines records (two scopes, several sources,
  typed metadata) and cases `{ label, operation, expected }` once; it runs against memory (the
  oracle), the pgvector and Qdrant recording fakes, the Vectorize fake, and — when `PGVECTOR_URL` /
  `QDRANT_URL` are set — the real services. Rows include: top-k ordering; every operator on every
  type; `and`; `minScore`; tenant-leak negative controls (scope B never returns scope A's ids, on
  every adapter); `deleteScope` above a 1,000-record page; `replaceSource` re-run and shrink; every
  refusal (undeclared field, wrong type, unsupported operation on Vectorize).
- **Why:** ROADMAP decision 3 and the repository's `filter-conformance.test.ts` precedent.
- **Test home:** that file.

### 3.12 Embedding stays in the application

- **Decision:** no embedder port. The guide and the example embed with AI SDK `embed`/`embedMany`
  through `@ai-sdk/openai-compatible`, reading the base URL and model from the environment (default
  the local `qwen3-embedding-0.6b`, 1,024 dimensions), and record embedding spend under M134's
  `createQuota`. Tests use `MockEmbeddingModelV4`; a guarded live test (`EMBED_BASE_URL` reachable)
  embeds real text and checks the nearest match is the semantically right one.
- **Why:** maintainer decision; M134 kept the AI SDK unwrapped.
- **Test home:** example smoke; `apps/semantic-search` live case.

### 3.13 `setu add vector-store`

- **Decision:** an `ADDABLE` entry `vector-store` → `vector-store-plugin`, no static peers (the arm
  is the application's choice). The adapters' load errors name the package to install. Not
  zero-config wiring (it needs collections).
- **Why:** adapters take injected clients; only pgvector lazily loads `drizzle-orm`, which a Drizzle
  application already has.
- **Test home:** `packages/cli/test/unit/add-command.test.ts` row.

### 3.14 Example app `apps/semantic-search`, offered via `--example`

- **Decision:** generated with this tree's CLI (`setu new --template rest`,
  `generate module documents --adopt-controllers`, `generate job ingest-document`,
  `generate plugin embeddings`), greeting removed, `setu sync`; CLI-owned files byte-identical;
  `setu check` clean; structure diff limited to retrieval additions (the `apps/mcp-tools` rules).
  `setu add queue`, `setu add multi-tenancy` and `setu add vector-store` run before `generate job`,
  which wires a job only when the queue plugin is installed (`generate.ts:377`). Routes:
  `POST /documents` (validated body, enqueues the ingest job), `GET /search?q=&tag=`. The ingest job
  validates the tenant with `lookupTenant`, chunks with a plain splitter, embeds with `embedMany`,
  and calls `replaceSource`. Tenancy: header resolver with a fixed tenant registry. Store: memory by
  default; pgvector when `PGVECTOR_URL` is set, chosen through the `adapter` factory so
  `setu.config.ts` stays classifiable. Smoke (memory, `MockEmbeddingModelV4`): ingest + search,
  tenant isolation, re-ingest leaves one copy, undeclared filter → 400, dimension mismatch refused;
  guarded cases for pgvector and the live Qwen model.
- **Why:** maintainer decision.
- **Test home:** `apps/semantic-search/smoke.ts`; the CLI examples e2e.

### 3.15 CI backends

- **Decision:** switch every CI and local-CI PostgreSQL from `postgres:16` to
  `pgvector/pgvector:pg16` (a superset image) and add a `qdrant/qdrant` service pinned to an exact
  version; export `PGVECTOR_URL` and `QDRANT_URL` to the package shard.
- **Why:** the gate requires real pgvector and Qdrant runs.
- **Test home:** `test/unit/local-ci-plan.test.ts`; the guarded real suites.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none (new token, new port, new package, one new cloudflare-plugin
export).

| Exported symbol                                                                                                                                                                                        | Kind      | Consumer / real code path that READS it                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------------- |
| `CAPABILITIES.VECTOR_STORE` (common)                                                                                                                                                                   | token     | `VectorStorePlugin` registers under it; the example resolves it.                    |
| `IVectorStore`, `VectorRecord`, `VectorQuery`, `VectorMatch`, `VectorFilter`, `VectorCollectionSpec` (common)                                                                                          | types     | The service implements `IVectorStore`; adapters and the example use the data types. |
| `IVectorStoreAdapter` (common)                                                                                                                                                                         | interface | Implemented by the four adapters; called by `VectorStoreService`.                   |
| `VectorStorePlugin`, `VectorStorePluginOptions`                                                                                                                                                        | fn, type  | The example's `setu.config.ts`.                                                     |
| `vectorScope`                                                                                                                                                                                          | fn        | The example's search controller.                                                    |
| `MemoryVectorStore`, `PgVectorStore`, `QdrantVectorStore`                                                                                                                                              | classes   | The example (memory, pgvector); Qdrant via the guide and its real suite.            |
| `VectorScopeRequiredError`, `VectorScopeInvalidError`, `VectorFilterError`, `VectorDimensionError`, `VectorCollectionUnknownError`, `VectorCollectionMismatchError`, `VectorOperationUnsupportedError` | classes   | Thrown by the service/adapters; the example maps `VectorFilterError` to 400.        |
| `VectorizeVectorStore` (cloudflare-plugin)                                                                                                                                                             | class     | A Worker application; the guide's Workers section.                                  |

### 4.1 Options — every option names its consumer

| Option                            | Consumer              | Behavior (per implementation)                                                                                                                                                                                                                                      |
| --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapter`                         | `VectorStoreService`  | The `IVectorStoreAdapter` every call reaches, or a factory `(runtime) => adapter` called once at registration so an application can pick the adapter from `runtime.env` without top-level code in `setu.config.ts` (which `setu check` cannot classify). Required. |
| `collections`                     | plugin start; service | Declared specs; ensured at start; validation reads `dimensions` and `filterable`.                                                                                                                                                                                  |
| `tenancy`                         | `vectorScope`         | `'required'` (default) throws without a tenant; `{ fixed }` supplies one scope.                                                                                                                                                                                    |
| `PgVectorStore` `db`              | pgvector adapter      | Drizzle PostgreSQL instance with `execute` and `transaction`; refused otherwise.                                                                                                                                                                                   |
| `PgVectorStore` `createExtension` | `ensureCollection`    | `true` runs `CREATE EXTENSION IF NOT EXISTS vector`; default `false` only verifies.                                                                                                                                                                                |
| `QdrantVectorStore` `client`      | Qdrant adapter        | The application's client; structural facade validated at construction.                                                                                                                                                                                             |
| `VectorizeVectorStore` `index`    | Vectorize adapter     | The binding; structural facade validated at construction.                                                                                                                                                                                                          |

## 5. Implementation files

| File                                                          | Purpose                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/common/src/services/vector-store.ts`                | Port and data types.                                           |
| `packages/common/src/tokens.ts`, `src/index.ts`               | `VECTOR_STORE` token; barrel.                                  |
| `packages/vector-store-plugin/src/index.ts`                   | Barrel exports.                                                |
| `src/plugin/vector-store-plugin.ts`                           | Plugin: option validation, registration, start-time ensure.    |
| `src/services/vector-store-service.ts`                        | Validation (§3.10) and delegation.                             |
| `src/services/collection-spec.ts`                             | Spec and name validation.                                      |
| `src/services/filter-validation.ts`                           | §3.5 validator.                                                |
| `src/scope.ts`                                                | `vectorScope`, scope validation.                               |
| `src/errors.ts`                                               | Named errors.                                                  |
| `src/adapters/memory/memory-vector-store.ts`                  | Brute-force oracle with its own filter evaluator.              |
| `src/adapters/pgvector/pgvector-store.ts`, `pgvector-sql.ts`  | Adapter and SQL/filter translation.                            |
| `src/adapters/qdrant/qdrant-store.ts`, `qdrant-filter.ts`     | Adapter and filter translation.                                |
| `src/adapters/shared/record-id.ts`                            | `(scope, id)` hashing used by Qdrant and Vectorize.            |
| `packages/cloudflare-plugin/src/vectorize/vectorize-store.ts` | Vectorize adapter.                                             |
| `packages/cli/src/commands/add.ts`, agent/registry files      | `setu add vector-store`; `PACKAGE_DATA`; `FRAMEWORK_PACKAGES`. |
| `apps/semantic-search/**`                                     | Generated example (§3.14).                                     |
| `docs/retrieval.md`, plugin `README.md`, `AGENT_CARD.md`      | Guide and references.                                          |

### 5.1 Registries a new package, example and guide must touch

Every one of these failed a gate on M134 or #554 when missed:

| File                                                                                                 | Change                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/release-packages.ts`, `scripts/jsr-metadata.ts`                                             | `packages/vector-store-plugin` in `PUBLISHED_PACKAGES`; its `PACKAGE_METADATA` description.                                      |
| `compat/compat.test.mjs`                                                                             | `@setu-ts/vector-store-plugin` in `PENDING_FIRST_PUBLISH` until its first publish.                                               |
| `packages/cli/src/agents/package-data.ts`, `packages/cli/src/devtool/sources.ts`                     | `PACKAGE_DATA` entry (token `VECTOR_STORE`); `FRAMEWORK_PACKAGES` member.                                                        |
| `packages/vector-store-plugin/AGENT_CARD.md`                                                         | Required by the release gate.                                                                                                    |
| `scripts/node-dependency-ranges.ts`                                                                  | `@qdrant/js-client-rest` exact range (devDependency for the real suite); `@cloudflare/workers-types` already present is checked. |
| `scripts/node-manifests.ts`                                                                          | Root devDependencies the guide's fences need.                                                                                    |
| `packages/cli/src/examples/catalog.ts`, `manifest.ts`                                                | Offer `semantic-search`; regenerate with `pnpm run examples:manifest`.                                                           |
| `scripts/check-deploy.ts`                                                                            | Exclusion entry for the example (same shape as `rest-api`).                                                                      |
| `website/src/lib/docs-nav.ts`, `docs/README.md`, `docs/cli.md`, `docs/examples.md`, `apps/README.md` | Guide navigation; example listings.                                                                                              |
| `website/test/repository.test.ts`                                                                    | `APPS` count + 1 (`ci:local` does not run website tests).                                                                        |
| `test/guide-fence-compiler.test.ts`, fence fixtures                                                  | `docs/retrieval.md` fence counts.                                                                                                |
| `.github/workflows/{ci,drift,release}.yml`, `scripts/lib/local-ci-plan.ts`                           | §3.15 images and env.                                                                                                            |
| `CHANGELOG.md`, `PUBLIC_API.md`, `ROADMAP.md`, `CLAUDE.md`                                           | Entries naming the PR; ROADMAP §2 corrections and the Progress row; status line.                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                            | Key assertions                                                                                                  |
| ----------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/vector-store-contract.test.ts`      | `vector-store.ts`, token               | Token value and grammar; type shapes compile against §4.                                                        |
| `test/unit/vector-store-plugin.test.ts`               | `vector-store-plugin.ts`               | Registers under the token; ensures each collection at start; mismatch fails startup; option refusals.           |
| `test/unit/collection-spec.test.ts`                   | `collection-spec.ts`                   | Name grammar; reserved fields; dimension bounds.                                                                |
| `test/unit/filter-validation.test.ts`                 | `filter-validation.ts`                 | Every refusal of §3.5, by name, before any adapter call (spy asserts zero calls).                               |
| `test/unit/vector-scope.test.ts`                      | `scope.ts`                             | Tenant present; fixed scope; required without tenant; ill-formed and over-length scope.                         |
| `test/unit/vector-store-service.test.ts`              | `vector-store-service.ts`, `errors.ts` | Hostile numerics, topK bounds, id rules; short-circuit: a refused call never reaches the adapter.               |
| `test/unit/memory-vector-store.test.ts`               | memory adapter                         | Ordering, scores, filters, replaceSource, deleteScope.                                                          |
| `test/unit/pgvector-store.test.ts`                    | pgvector adapter + sql                 | Bound parameters only; scope in every statement; iterative scan set; transaction for replaceSource; load error. |
| `test/integration/pgvector-store.real.test.ts`        | pgvector adapter                       | Guarded `PGVECTOR_URL`: ensure, upsert, query, tenant leak, extension version refusal.                          |
| `test/unit/qdrant-store.test.ts`                      | Qdrant adapter + filter                | Scope `must` on every call; UUID ids; payload indexes incl. `is_tenant`.                                        |
| `test/integration/qdrant-store.real.test.ts`          | Qdrant adapter                         | Guarded `QDRANT_URL`, real client.                                                                              |
| `test/unit/record-id.test.ts`                         | `record-id.ts`                         | Deterministic; scope-separated; UUID/hex formats.                                                               |
| `test/integration/conformance.test.ts`                | all adapters                           | §3.11 table, including tenant-leak controls and REFUSED cells.                                                  |
| `cloudflare-plugin/test/unit/vectorize-store.test.ts` | `vectorize-store.ts`                   | Namespace = scope; hashed ids; describe() mismatch; two refusals; topK cap.                                     |
| `test/e2e/vector-store-e2e.test.ts`                   | plugin through a kernel app            | A route using `vectorScope` under multi-tenancy returns only its tenant's matches.                              |
| `apps/semantic-search/smoke.ts`                       | example                                | §3.14 cases; guarded pgvector and live-Qwen cases.                                                              |

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

## 9. Out of scope

- An embedder port or any AI SDK wrapper — the AI SDK owns embedding (maintainer decision).
- Hybrid search, re-ranking, MMR, sparse vectors, metadata-only queries.
- MongoDB Atlas and Cosmos DB vector search — named follow-ons.
- Dot-product and euclidean metrics.
- Store metrics, diagnostics and a health indicator.
- Document loaders and a chunking library.
