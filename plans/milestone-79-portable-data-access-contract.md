# Milestone 79 — Portable Data-Access Contract (`@setu-ts/common`, `@setu-ts/database-plugin`, `@setu-ts/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m79-portable-data-access-contract`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`IDataSource` and `NormalizedQuery` express a single scalar primary key, a flat field name, and a
row-count offset. Each of those three is a limit the repository has already conceded in source
rather than a shape any backend prefers: `drizzle-adapter.ts:236-238` states that
`findById`/`update`/`delete` are "single-key by contract" and names ordinary join and per-tenant
tables as what that locks out; `FilterComparison.field` is a flat `string` in all four arms, so a
subdocument path works only by accident of a backend's own parsing; and `OFFSET n` makes the server
scan and discard `n` rows on PostgreSQL, MySQL and SQLite alike, so deep pagination is already
`O(n)` on every backend the framework ships today. This milestone grows the three members, plus one
fourth the cursor member cannot function without (§3.9), and implements every one of them across all
**five** shipped adapters — so a document or wide-column backend (M80/M81/M82) becomes an
implementation milestone rather than a contract argument.

- **In scope:** composite keys (§3.1–§3.4), nested field paths (§3.5–§3.6), keyset cursor pagination
  (§3.7–§3.10), and the ordered-comparison `Date` widening the cursor requires (§3.9); each
  implemented across Memory, Prisma, Drizzle, Mongo and D1; the repository and service surfaces that
  carry them; the doc deliverables in §2.
- **NOT this milestone:** TTL, consistency level and secondary-index selection — M78's blocker 3,
  excluded because no two of Mongo, DynamoDB, Cosmos and Bigtable spell any of them alike and none
  has a second consumer today, so each belongs with the adapter that first needs it. Partition
  awareness is excluded for a different reason and is not a gap: it is per-entity _mapping_ rather
  than portable surface, so M80 owns its partition-plus-sort key, M81 its partition key and M82 its
  row key. The DynamoDB, Cosmos and Bigtable adapters themselves are M80, M81 and M82. Removing
  `offset` is out of scope permanently — it is released API and §9.4 governs (§3.10).

## 1. Contracts verified from SOURCE (not names)

Every row below was read at the cited line on this branch's merge-base. The ROADMAP's own citations
for two of them point at the enclosing interface rather than the member; the real member lines are
recorded here and corrected in the ROADMAP as C2.

| Reference                            | Source (file:line)                                                                               | Verified surface / fact                                                                                                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDataSource.findById`               | `packages/common/src/services/database.ts:168`                                                   | `findById(id: string \| number)` returning `Promise<Record<string, unknown> \| null>` — scalar only                                                                                                |
| `IDataSource.update`                 | `packages/common/src/services/database.ts:186-189`                                               | `update(id: string \| number, data: Partial<Record<string, unknown>>)` — scalar only                                                                                                               |
| `IDataSource.delete`                 | `packages/common/src/services/database.ts:198`                                                   | `delete(id: string \| number): Promise<boolean>` — scalar only                                                                                                                                     |
| `IDataSource` members                | `packages/common/src/services/database.ts:154-207`                                               | Exactly six: `findAll`, `findById`, `create`, `update`, `delete`, `count`. No paging member, no cursor.                                                                                            |
| `FilterComparison.field`             | `packages/common/src/services/database.ts:83, 88, 93, 98`                                        | `readonly field: string` repeated in all four arms — flat, no path form                                                                                                                            |
| `FilterComparison` ordered arm       | `packages/common/src/services/database.ts:91-96`                                                 | `operator: 'gt' \| 'gte' \| 'lt' \| 'lte'` carries `value: string \| number` — **no `Date`**, so a date-range filter is not expressible portably today                                             |
| `NormalizedQuery.offset`             | `packages/common/src/services/database.ts:132`                                                   | `readonly offset: number` — a row count. `where`/`orderBy`/`limit`/`select` at `:124`/`:128`/`:130`/`:134`.                                                                                        |
| `IDataSource` contract note          | `packages/common/src/services/database.ts:140-143`                                               | "the data source owns query evaluation end to end … and the repository above it must not re-apply any of them" — so every `NormalizedQuery` member is a requirement on an adapter                  |
| `common` error classes               | `packages/common/src/` (grep `export class .*Error`)                                             | **Zero.** `common` exports `serializeError` and the responder seam only — no error class. Settles §3.11.                                                                                           |
| `IRepository` type parameter         | `packages/database-plugin/src/interfaces/index.ts:61, 69, 107, 116`                              | `IRepository<Entity, Id = string>` — `Id` is already a free type parameter; `findById(id: Id)`, `update(id: Id, …)`, `delete(id: Id)`, so the repository layer already type-checks a composite key |
| `BaseRepository.coerceId`            | `packages/database-plugin/src/repositories/base-repository.ts:110-112`                           | `coerceId(id: Id)` returns `id as string \| number` — an unchecked cast, so a composite `Id` type-checks and reaches the data source as an object                                                  |
| `BaseRepository.findOne`             | `packages/database-plugin/src/repositories/base-repository.ts:76-79`                             | `findAll({ ...options, limit: 1 })` then `[0] ?? null` — the precedent for a repository method composed from `findAll` rather than a new data-source member                                        |
| `normalizeQuery`                     | `packages/database-plugin/src/query/query-builder.ts:34-43`                                      | Resolves every optional to a concrete default; `filter` is conditionally spread so `exactOptionalPropertyTypes` holds                                                                              |
| `matchesFilter`                      | `packages/database-plugin/src/query/query-builder.ts:79-107`                                     | Reads `entity[filter.field]` — a single flat lookup; `comparableGreaterThan` (`:109-112`) handles `number` and `string` **only**                                                                   |
| `MemoryAdapter` key handling         | `packages/database-plugin/src/adapters/memory/memory-adapter.ts:31-32, 277, 296-299`             | `EntityStore.primaryKey: string`; `createDataSource(entity, primaryKey = 'id')`; matches with `r[store.primaryKey] === id`                                                                         |
| `PrismaAdapter` key handling         | `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:390, 423, 434`                   | `where: { id }` hardcoded in `findById`, `update` and `delete` — the key _name_ is not configurable at all                                                                                         |
| `UnsupportedFilterOperatorError`     | `packages/database-plugin/src/errors.ts:34-62`                                                   | Carries `operator`, `connector` and a `name` discriminant; thrown at translation time from `prisma-adapter.ts:535, 545, 562`. The in-package refuse-by-name precedent.                             |
| `DrizzleAdapter` id precondition     | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:236-241`                       | Comment states the `id` column is "a REPOSITORY precondition, not a registry one" and names composite-key tables as deliberately unblocked at the registry                                         |
| `createDrizzleDataSourceInner`       | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:490-505`                       | `columnFor(drizzleTable, entity, 'id')` — the literal `'id'`, refused by name when absent                                                                                                          |
| `MongoEntityMapping` / `MongoTarget` | `packages/database-plugin/src/adapters/mongo/mongo-mapping.ts:21-52, 66-73, 105-117`             | Public per-entity override bag (`collection?`, `primaryKey?`, `idType?`) collapsed by `resolveMongoTarget` into an internal, unexported target. `primaryKey` is a single `string`.                 |
| `D1EntityMapping` / `D1Target`       | `packages/cloudflare-plugin/src/database/d1-adapter.ts:50-60, 66-83, 237-244`; `d1-sql.ts:45-50` | Same two-layer shape: public `{ table?, primaryKey? }`, internal `D1Target` via `resolveTarget`. `primaryKey` is a single `string`.                                                                |
| `CloudflareUnsupportedError`         | `packages/cloudflare-plugin/src/errors.ts:70-72`                                                 | Carries a `name` discriminant; the refuse-by-name class D1 already uses                                                                                                                            |
| `MongoAdapter` exists                | `packages/database-plugin/src/index.ts:109`; `PUBLIC_API.md:1235`; `README.md:205`               | Shipped in M78 (PR #208) and barrel-exported — so there are **five** shipped adapters, not the four the M79 ROADMAP section names (C1)                                                             |
| `filter-conformance.test.ts`         | `packages/database-plugin/test/unit/filter-conformance.test.ts`                                  | The existing one-query-through-every-adapter suite M70b added — the natural home for cross-adapter conformance of the new members                                                                  |
| §2.2 plugin-import ban               | `AI_GUIDELINES.md` §2.2                                                                          | `cloudflare-plugin` may not import `database-plugin`, so anything both need lives in `common` (the M47 frame-codec precedent)                                                                      |

## 1A. Facts established by LIVE PROBE (measured 2026-08-29, not reasoned)

Every fact below was produced by executing against a real backend on this machine — Prisma 7.10.0
against PostgreSQL 16, and MongoDB 8 as a single-node replica set. §1B records exactly how to bring
both up, so nothing here needs re-deriving. Four of these measurements **changed the design**; two
of them turned a reasoned decision into an evidenced one; and one is a negative control that
reproduces a silent data-loss defect.

| #   | Question the design depended on                                                          | Measured answer                                                                                                                                                                                                                                                           | What it changed                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | Prisma's generated compound-key field for an **unnamed** `@@id([tenantId, userId])`      | `tenantId_userId` — the column names joined by `_`. Executed, not just read off the type: `findUnique({ where: { tenantId_userId: {…} } })` returned the row.                                                                                                             | Confirms §3.4's derived default. The probe the plan deferred to "implementation step 1" is **done**.                                      |
| P2  | Prisma's compound-key field for a **named** `@@id([...], name: "enrollmentKey")`         | `enrollmentKey`. **And the derived `courseId_personId` is REJECTED on that model** — measured `false`.                                                                                                                                                                    | §3.4: the per-entity override is **mandatory** for a named `@@id`, not a convenience. Sharpened.                                          |
| P3  | Does Prisma's compound-key object care about **property order**?                         | **No.** `{ userId, tenantId }` matched the same row as `{ tenantId, userId }`.                                                                                                                                                                                            | Prisma needs no canonical ordering — which is the exact opposite of Mongo (P4), so the adapter cannot share one assumption.               |
| P4  | Does Mongo's **subdocument `_id`** care about field order?                               | **Yes, decisively.** `{tenantId,userId}` matched; `{userId,tenantId}` returned `null` for the same document.                                                                                                                                                              | Confirms §3.3's "no `_id` rename for a compound key" with evidence, and makes the new `'compound'` arm safe only under a canonical order. |
| P5  | Can a compound `_id` be addressed reliably at all?                                       | **Only under a canonical order.** Building the subdocument in the mapping's declared column order matched (`true`); passing the caller's key object through verbatim missed (`false`).                                                                                    | §3.3 gains an `idType: 'compound'` arm whose whole correctness rests on ordering by the mapping, never by the caller.                     |
| P6  | Do Prisma composite `update` and `delete` return the **row**, as `IDataSource` requires? | **Yes** — `update` returned the updated row and `delete` returned the deleted row.                                                                                                                                                                                        | Removes the `updateMany` + `findFirst` fallback from consideration entirely; §3.4's rejection of it is now measured.                      |
| P7  | Prisma's nested JSON path filter shape                                                   | `{ profile: { path: ['address','city'], equals: 'Kolkata' } }` returned the 3 matching rows.                                                                                                                                                                              | Confirms §3.5's claim that Prisma has a native path form to translate onto.                                                               |
| P8  | Mongo's nested path shape                                                                | The native dotted key `"profile.address.city"` returned the 3 matching rows.                                                                                                                                                                                              | Confirms §3.5's "path arrays join to Mongo's native dotted key".                                                                          |
| P9  | Does a `Date` range filter work on both?                                                 | **Yes on both** — Prisma `{ createdAt: { gt: date } }` and Mongo `{ createdAt: { $gt: date } }` each returned the expected count.                                                                                                                                         | Confirms §3.9's fourth member is translatable on the two backends that must carry it.                                                     |
| P10 | Does the §3.8 keyset tree page correctly on a real database?                             | **Yes on both.** `or(lt, and(eq, gt))` over `createdAt desc, userId asc` walked 6 rows in 3 pages with no overlap and no gap, on Prisma/Postgres and on Mongo.                                                                                                            | Confirms §3.8's central claim — the predicate needs only operators the contract already has.                                              |
| P11 | **Is the tiebreaker actually load-bearing?** (negative control)                          | **Yes — dropping it silently loses rows.** With six rows over only two distinct `createdAt` values, the naive `createdAt < cursor` walk returned **4 of 6**; `u2` and `u5` never appeared and the walk reported success. Reproduced identically on Postgres and on Mongo. | Promotes the tiebreaker from a refinement to a **correctness requirement** (§3.8), with a committed regression test.                      |

**P11 is the finding that matters most**, and it is why §3.8 puts the builder in `common` rather
than letting each adapter roll its own: the defect is backend-independent, produces no error, and a
first page of results looks entirely correct. An initial run of the P10 walk was **vacuous** — every
`createdAt` was distinct, so the tiebreaker branch never executed and the test would have passed
against a builder that omitted it. The committed test therefore seeds ties deliberately.

## 1B. Live backend setup — everything needed, no searching

Both backends below are already running on this machine. The commands are recorded so the
implementation, the reviewer and CI-adjacent local runs need no lookup.

**MongoDB 8 — `he-mongo`, already up.** It is a single-node **replica set** (Prisma's MongoDB
connector requires one), and the member host must be `127.0.0.1:27017`, because a client on the host
discovers the topology and dials whatever the member advertises.

```bash
docker run -d --name he-mongo --restart unless-stopped -p 127.0.0.1:27017:27017   -v he-mongo-data:/data/db mongo:8 --replSet rs0 --bind_ip_all
docker exec he-mongo mongosh --quiet --eval   'rs.initiate({_id:"rs0", members:[{_id:0, host:"127.0.0.1:27017"}]})'
```

Connection string (this is the value `MONGO_URL` / `MONGODB_URI` takes):

```
mongodb://127.0.0.1:27017/setu_m79?replicaSet=rs0
```

**PostgreSQL 16 — `m79-postgres`, created for this milestone.** Port **5433** deliberately, because
`web-app-postgres` (an unrelated project) already holds 5432 and must not be touched.

```bash
docker run -d --name m79-postgres --restart unless-stopped   -e POSTGRES_PASSWORD=probe -e POSTGRES_DB=m79probe   -p 127.0.0.1:5433:5432 postgres:16-alpine
```

```
postgresql://postgres:probe@127.0.0.1:5433/m79probe
```

**Prisma 7 prerequisites, confirmed live.** Prisma 7 **removed `url` from the schema file** — a
`datasource` block carrying `url` fails validation with `P1012`. The three requirements M70j
recorded are all real and all necessary:

1. `prisma.config.ts` at the project root carrying `schema`, `migrations.path` and `datasource.url`;
   the schema's `datasource` block keeps only `provider`.
2. A driver adapter passed to the client constructor —
   `new PrismaClient({ adapter: new PrismaPg({ connectionString }) })` from `@prisma/adapter-pg`.
3. Packages: `prisma@^7`, `@prisma/client@^7`, `@prisma/adapter-pg`, `pg`.

```bash
export DATABASE_URL="postgresql://postgres:probe@127.0.0.1:5433/m79probe"
npx prisma db push && npx prisma generate
```

**Before running anything that stops a container**, check `AutoRemove` — M70c's outage suites issue
a real `docker stop`, and a container created with `--rm` is destroyed by it and never returns:

```bash
docker inspect -f '{{.HostConfig.AutoRemove}}' he-mongo m79-postgres   # both must print false
```

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                      |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The M79 ROADMAP section scopes the work to "all four shipped adapters (Memory, Prisma, Drizzle, D1)". `MongoAdapter` shipped in M78 (PR #208) and is barrel-exported at `database-plugin/src/index.ts:109`, so there are **five**. The section was written before M78 merged.                                                           | Five. A widening the newest adapter does not implement is exactly the dead-surface case the section's own rule forbids.                                                                                                                  | Correct the M79 in-scope bullet in `ROADMAP.md` to name Mongo.                                                                                 |
| C2 | The M79 section cites `common/src/services/database.ts:141` for the three scalar-key signatures and `:122` for `offset`. Line 141 is prose inside the `IDataSource` docblock; `:122` is the `NormalizedQuery` interface opening. The members are at `:168`/`:186`/`:198` and `:132`.                                                    | The member lines. A citation that resolves to a docblock cannot be checked by a reader.                                                                                                                                                  | Correct both citations in the M79 ROADMAP section.                                                                                             |
| C3 | `IRepository` documents `Id` as "Primary key type" with no constraint, and `BaseRepository.coerceId` casts it to a scalar unchecked — so a composite `Id` such as `{ tenantId: string; userId: string }` **type-checks today** and fails at runtime inside the adapter. The type parameter promises what the contract does not deliver. | Make the promise true rather than narrow the parameter: `Id` gains an `EntityKey` constraint and `coerceId` stops being a cast. Narrowing `Id` back to a scalar would break released API for no gain.                                    | Correct the `Id` JSDoc at `interfaces/index.ts:61` to state the constraint; note the previously-silent failure in `CHANGELOG.md`.              |
| C4 | `PUBLIC_API.md:1188` ("Custom Adapters (external backends)") prints the `IDataSource` shape an out-of-package backend implements, with the three scalar signatures and six members.                                                                                                                                                     | The printed shape moves with the contract, and the section gains the `findPage` member plus the breaking-for-implementors note.                                                                                                          | Rewrite the `IDataSource` block in that section; add `findPage`, `EntityKey`, `PageResult` and the cursor codec to the `common` exports table. |
| C5 | The M79 ROADMAP section scopes exactly three contract members. This plan ships a fourth — `Date` on the ordered-comparison arm (§3.9) — because without it the cursor member cannot page by `createdAt`, which is its principal consumer.                                                                                               | Ship the fourth, flagged rather than smuggled. It passes the section's own two-consumer rule (§3.9), and its absence would make the headline member non-functional in its commonest use — the "shipped green but unusable" defect class. | Add the fourth member to the M79 ROADMAP in-scope bullet with its justification, so the section and the code agree.                            |

## 3. Design decisions

### 3.1 Composite key representation

- **Decision:** `EntityKey` in `common`, defined as a scalar `string`, a scalar `number`, or a
  `Readonly<Record<string, string | number>>` for the composite case. `IDataSource.findById`,
  `update` and `delete` take `EntityKey`. The scalar arms stay, so every existing call site and
  every existing test compiles unchanged.
- **Why:** A union widening in a **parameter** position is source-compatible for callers and
  breaking for implementors, because the parameter is contravariant — established with `deno check`
  in M47 and again in M69, not assumed. That is the correct direction here: the five in-repo
  adapters must all be updated (§3.3), and an out-of-repo `IDataSource` implementor gets a compile
  error rather than silently receiving an object where it expects a scalar. A record rather than an
  array because a composite key is named columns, and an array would make the caller depend on a
  column order the mapping owns.
- **Test home:** `test/unit/entity-key.test.ts` (the type-level assertions plus the runtime guard),
  and every adapter suite named in §6.

### 3.2 `IRepository` gains a key constraint, and `coerceId` stops casting

- **Decision:** the `Id` type parameter on `IRepository` and `BaseRepository` is constrained to
  `EntityKey`, still defaulting to `string`; `coerceId` returns `EntityKey` and returns `id` with no
  cast.
- **Why:** C3. The parameter already accepted a composite key at the type level and the cast hid the
  runtime failure. Constraining to `EntityKey` — which now _includes_ the composite record — widens
  what actually works while making an `Id` the contract cannot carry (a `Date`, a class instance) a
  compile error at the declaration site instead of a runtime fault inside an adapter. This is
  breaking only for a caller who declared an `Id` outside `EntityKey`, which never worked.
- **Test home:** `test/unit/base-repository.test.ts` (a composite `Id` round-trips), plus a
  `@ts-expect-error` case pinning that an out-of-constraint `Id` is refused.

### 3.3 Composite key mapping — how an adapter learns the key columns

- **Decision:** every adapter's per-entity mapping widens its primary-key field from a single
  `string` to a `string` plus a `readonly string[]` form, following the two-layer
  public-override/internal-target shape D1 and Mongo already ship. Concretely:
  `D1EntityMapping.primaryKey`, `MongoEntityMapping.primaryKey`,
  `MemoryAdapter.createDataSource(entity, primaryKey)` and `EntityStore.primaryKey` all accept the
  widened form; `resolveMongoTarget` and `D1Adapter.resolveTarget` normalise it to a
  `readonly string[]` on the internal target, so every builder reads exactly one shape. Drizzle
  derives its key columns from a new per-entity `primaryKey` override on
  `DrizzleAdapterOptions.entities`, defaulting to `['id']` — which is what
  `columnFor(drizzleTable, entity, 'id')` hardcodes today.
- **Why:** The internal target normalising to an array is the load-bearing half. Leaving the union
  in the target would put a `typeof x === 'string'` branch in every statement builder, which is
  where a composite key would silently degrade to its first column. One shape at the builder means
  the scalar case is the one-element array and cannot diverge.
- **Mongo additionally gains an `idType: 'compound'` arm, and P4/P5 are why it is safe.** A compound
  `_id` subdocument is Mongo's own idiom for a composite key, and M78's scalar mapping cannot
  address such a collection at all. It is admitted here **only** because the probe settled the
  ordering question: a subdocument `_id` match is **field-order sensitive** (P4 — the same document
  matched under `{tenantId,userId}` and missed under `{userId,tenantId}`), so the adapter builds the
  subdocument in the **mapping's declared column order** and never in the caller's key- object order
  (P5 — canonical `true`, caller-order `false`). Passing the caller's object through would make
  `findById` return `null` for an existing row depending on how the caller happened to write the
  literal. The default stays flat top-level fields, which are order-independent and which a unique
  index constrains (measured: a duplicate insert is rejected with code `11000`).
- **The two backends disagree about ordering, which is why neither assumption is shared.** Prisma's
  compound-key object is order-**insensitive** (P3) while Mongo's subdocument `_id` is order-
  **sensitive** (P4). The canonical ordering therefore lives in each adapter's own key builder,
  derived from the resolved target's column array, rather than in `common`.
- **Test home:** `test/unit/mongo-mapping.test.ts`, `test/unit/memory-adapter.test.ts`,
  `test/unit/drizzle-adapter-columns.test.ts`, and `cloudflare-plugin/test/unit/d1-adapter.test.ts`;
  the order-sensitivity guard in `test/integration/real-mongo-adapter.test.ts`, which is the only
  place a real server can show it.

### 3.4 Prisma's compound key — derived name with a per-entity override

- **Decision:** a composite key translates to Prisma's compound-key syntax, a `where` whose single
  property is the compound-key field holding the key columns. That field name defaults to the key
  column names joined by `_` and is overridable per entity through a new `compositeKeyName` on
  `PrismaAdapterOptions.entities`. A scalar key keeps today's `where: { id }` path byte-for-byte.
- **Why:** Prisma's `findUnique`, `update` and `delete` require the compound-key field, not the
  loose columns. The two alternatives are both worse and are rejected here rather than left open:
  routing composite reads through `findFirst` and composite writes through `updateMany` followed by
  `findFirst` costs two round trips and is not atomic, which is precisely the "emulation that
  changes cost and consistency invisibly" the ROADMAP forbids; and refusing composite keys on Prisma
  outright would leave the framework's most-used ORM out of the milestone's headline member.
- **Measured, not assumed (P1, P2, P6) — this probe is complete.** Against a real generated Prisma
  7.10.0 client on live PostgreSQL 16: an unnamed `@@id([tenantId, userId])` generates
  `tenantId_userId` and `findUnique` through it returned the row; composite `update` and `delete`
  each returned the **row**, so both honour `IDataSource`'s return contract natively and the
  `updateMany` + `findFirst` fallback is ruled out by measurement rather than by argument.
- **The override is MANDATORY for a named `@@id`, not a convenience — this is the sharpening P2
  forced.** A model declaring `@@id([...], name: "enrollmentKey")` generates only `enrollmentKey`,
  and the derived `courseId_personId` is **rejected** on that model (measured `false`). So an entity
  whose schema names its compound key cannot work on the derived default at all, and the adapter
  must refuse by name (§3.11) when a composite key is configured for an entity Prisma rejects the
  derived name on, telling the caller to set `compositeKeyName`. Silently falling back to
  `findFirst` there would reintroduce the non-atomic path this decision rejects.
- **Test home:** `test/unit/prisma-adapter.test.ts` (the emitted `where` argument, asserted for the
  derived name and for the override) and `test/integration/real-prisma-adapter.test.ts` (both models
  driven against live PostgreSQL, including the named-key refusal).

### 3.5 Nested path representation

- **Decision:** `FilterComparison.field` widens from `string` to a `string` plus a
  `readonly string[]` form in all four arms. `['address', 'city']` is the path; `'address'` stays a
  plain field. Dotted strings are **not** given path meaning.
- **Why:** Two candidate shapes exist and one of them is silently wrong. An additive
  `path?: readonly string[]` beside `field` lets an adapter that ignores `path` filter on the root
  field and return wrong rows with no diagnostic — the silent-divergence class this repository keeps
  closing. Widening `field` makes every existing `filter.field` read a compile error in all five
  adapters and in any out-of-repo one, which is the loud failure we want. Overloading `'a.b'` with
  path meaning was rejected because a column whose name legitimately contains a dot would change
  behaviour silently on upgrade.
- **Test home:** `test/unit/query-builder.test.ts` (memory evaluation),
  `test/unit/filter-conformance.test.ts` (all five adapters agree with the reference result, and any
  that cannot refuses by name).

### 3.6 An empty path is refused by name

- **Decision:** an empty `field` array is refused at translation time by each adapter's own refusal
  class (§3.11), naming the operator and the offending comparison. It is not treated as "no field"
  and not silently skipped.
- **Why:** `readonly string[]` cannot express non-emptiness without a tuple type, and a
  `readonly [string, ...string[]]` tuple would force callers to write `as const` for every path
  literal, since a plain `string[]` is not assignable to it. Ergonomics win at the type level and
  the guard moves to runtime, where it must be loud: an empty path is a caller bug, and a filter
  that quietly matches everything is a data-exposure defect, not a no-op.
- **Test home:** `test/unit/filter-conformance.test.ts`.

### 3.7 Cursor pagination — the member and its shape

- **Decision:** `NormalizedQuery.cursor?: string` carries the incoming position, and an optional
  `IDataSource.findPage?(query: NormalizedQuery)` returns a `PageResult` carrying `rows` and a
  `nextCursor` that is `null` when no further page exists. The member is **optional on the
  interface** and implemented by all five in-repo adapters.
- **Why:** `findAll` returns a bare row array with nowhere to put a continuation token, so the
  cursor needs a method rather than a return-shape change to a released signature. Optional keeps an
  out-of-repo `IDataSource` implementor compiling, and `BaseRepository.findPage` refuses by name
  when the member is absent — so absence means "this adapter cannot page by cursor" and never "there
  are no more rows", which is the `IWorkerHost.reportsExit?` distinction M70k had to invent a member
  to preserve. It is not dead surface under the §4 rule because all five shipped adapters implement
  it.
- **Test home:** `test/unit/page-result.test.ts`, every adapter suite in §6, and
  `test/integration/database-plugin.test.ts` for the repository surface.

### 3.8 The keyset predicate is a portable `FilterExpression`, built once in `common`

- **Decision:** `common` gains three pure functions — `encodeCursor`, `decodeCursor` (base64url
  JSON) and `keysetPredicate(cursorValues, orderBy, keyColumns)` returning a `FilterExpression`. An
  adapter's `findPage` decodes the incoming cursor, builds the predicate, conjoins it with the
  caller's `where` and `filter`, calls its own `findAll` with one more than the requested limit, and
  mints the next cursor from the last returned row. The cursor payload carries the key values plus a
  stable fingerprint of the resolved sort specification, and a fingerprint mismatch on decode is
  refused by name.
- **Why:** The lexicographic "row after this one" comparison is expressible with the operators the
  contract already has — for a `desc` sort on `createdAt` with an `id` tiebreaker it is
  `or(lt(createdAt), and(eq(createdAt), gt(id)))` — so every adapter that already translates
  `FilterExpression` gets keyset paging with no new translation code, and the five adapters cannot
  drift about what "the next page" means. It lives in `common` because `cloudflare-plugin` needs the
  identical encoding and §2.2 forbids importing `database-plugin` — the M47 frame-codec precedent,
  which deletes a would-be duplicate rather than creating one. The fingerprint is the correctness
  guard: a cursor minted under one sort and presented under another would otherwise return a
  silently wrong page, and this repository has shipped that class of defect before.
- **The primary-key tiebreaker is a correctness requirement, and P11 measured the cost of omitting
  it.** Over six rows carrying only two distinct `createdAt` values, a naive `createdAt < cursor`
  walk returned **4 of 6** — two rows never appeared and the walk reported success, with no error
  raised by Postgres or by Mongo. So `keysetPredicate` always appends the resolved key columns as
  the final sort term, and a caller-supplied `orderBy` that already ends in them is not duplicated.
  P10 confirms the full tree walks 6 rows in 3 pages with no overlap and no gap on both
  Prisma/PostgreSQL and Mongo.
- **Test home:** `packages/common/test/unit/cursor-codec.test.ts` (round trip, malformed token,
  fingerprint mismatch), `test/unit/filter-conformance.test.ts` (the predicate against all five),
  and the live-backend suites in §6, whose fixtures **seed deliberate sort-key ties** — without them
  the walk passes against a builder that omits the tiebreaker entirely (the vacuous first run
  recorded in §1A).

### 3.9 The ordered-comparison arm gains `Date`

- **Decision:** the `gt`/`gte`/`lt`/`lte` arm widens its `value` from a `string` plus `number` union
  to one that also admits `Date`. `matchesFilter`'s `comparableGreaterThan` compares two `Date`s by
  `getTime()`; Prisma, Drizzle and Mongo pass a `Date` to their drivers natively; **D1 refuses a
  `Date` by name**, because SQLite has no date type and the adapter cannot know whether the column
  stores an ISO string or an epoch integer.
- **Why:** This is C5, the fourth member. `createdAt` is the canonical cursor column, and without
  `Date` the keyset predicate for it cannot be constructed at all — the headline member would ship
  green and be unusable in its commonest case. It passes the section's own two-consumer rule
  independently of the cursor: a portable `createdAt > x` range filter is not expressible today at
  all. `comparableGreaterThan` currently handles `number` and `string` only and would answer `false`
  for two `Date`s, so widening the type without fixing that function would make every date
  comparison silently match nothing.
- **Test home:** `test/unit/query-builder.test.ts` (the `Date` branch of `comparableGreaterThan`,
  with a control asserting the pre-fix function returns `false`),
  `test/unit/filter-conformance.test.ts`, and `cloudflare-plugin/test/unit/d1-sql.test.ts` for the
  refusal.

### 3.10 `offset` stays, and a `cursor` beside it is refused

- **Decision:** `offset` is not deprecated and not removed. A query carrying **both** a non-zero
  `offset` and a `cursor` is refused by name at `findPage` before any backend call.
- **Why:** §9.4 governs released API and `offset` has consumers throughout the framework and in
  every scaffolded project. The two members answer the same question from contradictory positions —
  a cursor says "after this row", an offset says "skip this many from the start" — so honouring both
  requires inventing a composition rule that no backend has, and honouring one silently would drop
  the caller's other instruction. Refusing is the only answer that cannot be wrong.
- **Test home:** `test/unit/page-result.test.ts`.

### 3.11 Refusals use each package's own error class, not a new one in `common`

- **Decision:** `database-plugin` refuses with a new `UnsupportedQueryFeatureError` beside
  `UnsupportedFilterOperatorError`, carrying the feature, the adapter and a `name` discriminant;
  `cloudflare-plugin` refuses with its existing `CloudflareUnsupportedError`. No error class is
  added to `common`.
- **Why:** `common` exports **zero** error classes today (§1, verified by grep) — adding one for
  this milestone's convenience would set a precedent for every future contract refusal. Both
  packages already carry a refusal class with a `name` discriminant, and an application configures
  exactly one adapter, so it knows which package's error to branch on. A separate class rather than
  reusing `UnsupportedFilterOperatorError`: that class's `operator` field is meaningless for a
  cursor or key refusal, and a field no code path can populate honestly is the dead-surface case.
- **Test home:** `test/unit/errors.test.ts`, and each refusal's own suite.

### 3.12 Every refusal rejects; none throws synchronously

- **Decision:** every new refusal reachable from a `Promise`-returning method returns a rejected
  promise. Only refusals raised from a constructor or an options resolver throw synchronously.
- **Why:** A synchronous throw from a method typed `Promise<T>` bypasses a caller using `.catch()`.
  This repository has shipped that defect in M52b (`createQueueHandler`), M52c (`D1Adapter`) and
  M70j (the memory-adapter column check), and `query-builder.ts:236-240` documents the rule in as
  many words.
- **Test home:** each refusal is asserted with `await expect(...).rejects.toThrow(...)`, never a
  synchronous `expect(() => ...).toThrow`.

## 4. Exported surface — every symbol names its consumer

### `@setu-ts/common` (`packages/common/src/index.ts`)

| Exported symbol   | Kind     | Consumer / real code path that READS it                                                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `EntityKey`       | type     | `IDataSource.findById`/`update`/`delete` parameter; the `IRepository` and `BaseRepository` key constraint; all five adapters' key resolution |
| `PageResult`      | type     | `IDataSource.findPage` return; `BaseRepository.findPage`; the service's repository wrapper in `database-service.ts`                          |
| `encodeCursor`    | function | Every adapter's `findPage` mints the next cursor with it — `database-plugin` (four adapters) and `cloudflare-plugin` (D1)                    |
| `decodeCursor`    | function | Every adapter's `findPage` reads the incoming `NormalizedQuery.cursor` with it                                                               |
| `keysetPredicate` | function | Every adapter's `findPage` builds its "after this row" filter with it, conjoined with the caller's own                                       |
| `CursorPayload`   | type     | The return type of `decodeCursor`; named so an adapter can annotate the decoded value it branches on                                         |

`FilterComparison`, `NormalizedQuery`, `IDataSource` and `IRepository` are already exported; their
shapes change but no new symbol is introduced for them.

### `@setu-ts/database-plugin` (`packages/database-plugin/src/index.ts`)

| Exported symbol                | Kind  | Consumer / real code path that READS it                                                                        |
| ------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------- |
| `UnsupportedQueryFeatureError` | class | Thrown by all four in-package adapters' refusals; consumers branch on it with `instanceof` (§3.11)             |
| `PageOptions`                  | type  | `IRepository.findPage` parameter — `FindOptions` plus `cursor`; read by `normalizePageQuery`                   |
| `Page`                         | type  | `IRepository.findPage` return — the typed form of `PageResult`; read by every caller of the repository surface |

Re-exported from `common` through this barrel for the same reason `NormalizedQuery` already is (a
backend author reaches the whole contract from one import): `EntityKey`, `PageResult`,
`encodeCursor`, `decodeCursor`, `keysetPredicate`, `CursorPayload`.

### `@setu-ts/cloudflare-plugin` (`packages/cloudflare-plugin/src/index.ts`)

No new symbol. `D1EntityMapping.primaryKey` widens in place; `CloudflareUnsupportedError` is already
exported.

### 4.1 Options — every option names its consumer

| Option                                                         | Consumer                                                        | Behavior (per implementation)                                                                                                                                           |
| -------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `D1EntityMapping.primaryKey` (widened)                         | `D1Adapter.resolveTarget`, normalising to `D1Target.primaryKey` | A scalar name keeps today's behaviour; an array emits a multi-column `WHERE a = ?1 AND b = ?2`. Default `['id']`.                                                       |
| `MongoEntityMapping.primaryKey` (widened)                      | `resolveMongoTarget`, normalising to `MongoTarget.primaryKey`   | A scalar keeps the `_id` rename path unchanged. An array maps each named field and performs **no** `_id` rename, since a compound key is not the driver's `_id`.        |
| `MongoEntityMapping.idType: 'compound'` (new arm)              | The Mongo key builder / `toDriverDocument`                      | Stores the composite key as a subdocument `_id`, built in the mapping's declared column order (P4/P5). Absent, a composite key maps to flat top-level fields.           |
| `DrizzleAdapterOptions.entities[e].primaryKey` (new)           | `createDrizzleDataSourceInner`                                  | Replaces the hardcoded `columnFor(table, entity, 'id')`. Default `['id']`, so an unconfigured entity behaves exactly as today, including its refuse-by-name on absence. |
| `PrismaAdapterOptions.entities[e].compositeKeyName` (new)      | The Prisma composite `where` builder (§3.4)                     | Overrides the derived joined name. Unset with a scalar key: today's `where: { id }` path, unchanged.                                                                    |
| `MemoryAdapter.createDataSource(entity, primaryKey)` (widened) | `EntityStore.primaryKey`                                        | The parameter accepts the widened form; the store normalises to an array. Composite rows match on every named column.                                                   |
| `FindOptions.cursor` / `PageOptions.cursor` (new)              | `normalizePageQuery`, feeding `NormalizedQuery.cursor`          | Absent starts at the first page. Present and well-formed continues after the encoded row. Present with a mismatched sort fingerprint is refused by name (§3.8).         |

No option in this table is write-only: each is read on a real code path named in its own row, and
each has a test in §6.

## 5. Implementation files

| File                                                               | Purpose                                                                                                                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/database.ts`                         | `EntityKey`, `PageResult`; widened `IDataSource` signatures plus the optional `findPage`; widened `FilterComparison.field` and ordered-arm `value`; `NormalizedQuery.cursor` |
| `packages/common/src/services/cursor.ts` **(new)**                 | `CursorPayload`, `encodeCursor`, `decodeCursor`, `keysetPredicate` — pure, no driver, no runtime service                                                                     |
| `packages/common/src/index.ts`                                     | Barrel: the six new symbols                                                                                                                                                  |
| `packages/database-plugin/src/errors.ts`                           | `UnsupportedQueryFeatureError`                                                                                                                                               |
| `packages/database-plugin/src/query/find-options.ts`               | `PageOptions`, `Page`; `FindOptions.cursor`                                                                                                                                  |
| `packages/database-plugin/src/query/query-builder.ts`              | `normalizePageQuery`; `matchesFilter` path resolution; the `comparableGreaterThan` `Date` arm; `unknownColumnError` path awareness                                           |
| `packages/database-plugin/src/query/key-target.ts` **(new)**       | Shared `resolveKeyColumns` and `keyValues` used by all four in-package adapters to normalise a mapping and to project an `EntityKey` onto its columns                        |
| `packages/database-plugin/src/repositories/base-repository.ts`     | The `EntityKey` constraint; `coerceId` without the cast; `findPage`                                                                                                          |
| `packages/database-plugin/src/interfaces/index.ts`                 | `IRepository` constraint plus `findPage`; the two new adapter-option `entities` bags                                                                                         |
| `packages/database-plugin/src/services/database-service.ts`        | The repository wrapper forwards `findPage`                                                                                                                                   |
| `packages/database-plugin/src/adapters/memory/memory-adapter.ts`   | Composite `EntityStore.primaryKey`; composite matching; `findPage`                                                                                                           |
| `packages/database-plugin/src/adapters/prisma/prisma-adapter.ts`   | Compound-key `where` (§3.4); nested-path `where`; `Date` values; `findPage`                                                                                                  |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts` | Configurable key columns; nested-path columns; `findPage`                                                                                                                    |
| `packages/database-plugin/src/adapters/mongo/mongo-mapping.ts`     | `primaryKey` widening normalised to an array target; a compound key skips the `_id` rename                                                                                   |
| `packages/database-plugin/src/adapters/mongo/mongo-query.ts`       | Path arrays join to Mongo's native dotted key; `Date` passes through                                                                                                         |
| `packages/database-plugin/src/adapters/mongo/mongo-data-source.ts` | Composite key lookup; `findPage`                                                                                                                                             |
| `packages/database-plugin/src/index.ts`                            | Barrel: the three new symbols plus the six `common` re-exports                                                                                                               |
| `packages/cloudflare-plugin/src/database/d1-adapter.ts`            | `D1EntityMapping.primaryKey` widening; `resolveTarget` normalises to an array                                                                                                |
| `packages/cloudflare-plugin/src/database/d1-sql.ts`                | `D1Target.primaryKey` as `readonly string[]`; multi-column key predicates; nested-path and `Date` refusals                                                                   |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`        | Composite key on both the committed and deferred-write paths; `findPage`                                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/cursor-codec.test.ts` **(new)**                        | `common/src/services/cursor.ts`                            | `encodeCursor` and `decodeCursor` round-trip against `CursorPayload`; a malformed token decodes to `null` rather than throwing; a fingerprint mismatch is detectable; `keysetPredicate` emits the `or(lt, and(eq, gt))` tree for `desc` and its mirror for `asc`, and appends the key tiebreaker |
| `common/test/unit/database-contract-types.test.ts` **(new)**             | `common/src/services/database.ts` (type level)             | `@ts-expect-error` cases: an `IDataSource` implementor with the old scalar-only signature is refused; a `Date` in the ordered arm is accepted; a `Date` in the `contains` arm is refused; a two-element `field` array type-checks without `as const`                                             |
| `database-plugin/test/unit/entity-key.test.ts` **(new)**                 | `src/query/key-target.ts`                                  | `resolveKeyColumns('id')` yields `['id']`; the array form passes through; `keyValues` refuses a scalar against a two-column target and refuses a record missing a column, each naming the column                                                                                                 |
| `database-plugin/test/unit/page-result.test.ts` **(new)**                | `src/query/query-builder.ts` (`normalizePageQuery`)        | A cursor alongside a non-zero `offset` rejects (§3.10); an absent cursor yields a first page; the one-extra-row probe sets `nextCursor` to `null` on the last page and to a token otherwise                                                                                                      |
| `database-plugin/test/unit/errors.test.ts`                               | `src/errors.ts`                                            | `UnsupportedQueryFeatureError` carries its feature, adapter and `name`, and survives `instanceof`                                                                                                                                                                                                |
| `database-plugin/test/unit/query-builder.test.ts`                        | `src/query/query-builder.ts`                               | `matchesFilter` resolves a two-segment path and returns `false` for a missing intermediate rather than throwing; `comparableGreaterThan` orders two `Date`s (with the control from §3.9); `unknownColumnError` does not reject a path's root field                                               |
| `database-plugin/test/unit/base-repository.test.ts`                      | `src/repositories/base-repository.ts`                      | A composite key round-trips through `findById`, `update` and `delete` against a repository declared with a two-column key type; `findPage` refuses by name when the data source omits `findPage`; a `@ts-expect-error` pins an out-of-constraint key type                                        |
| `database-plugin/test/unit/memory-adapter.test.ts`                       | `src/adapters/memory/memory-adapter.ts`                    | Composite store matching; `findPage` walks a seeded set across three pages with no row repeated and none skipped                                                                                                                                                                                 |
| `database-plugin/test/unit/prisma-adapter.test.ts`                       | `src/adapters/prisma/prisma-adapter.ts`                    | The emitted `where` for a composite key uses the derived compound name, and the override replaces it; a nested path emits Prisma's own path form; a `Date` reaches the delegate unconverted — each asserted on the recorded delegate argument                                                    |
| `database-plugin/test/unit/drizzle-adapter-columns.test.ts`              | `src/adapters/drizzle/drizzle-adapter.ts`                  | Configured key columns replace the hardcoded `'id'`; an unconfigured entity still refuses a missing `id` by name; a composite-key table now yields a repository where it previously threw                                                                                                        |
| `database-plugin/test/unit/mongo-mapping.test.ts`                        | `src/adapters/mongo/mongo-mapping.ts`                      | `resolveMongoTarget` normalises both forms to an array; a compound key performs no `_id` rename; the scalar path stays byte-identical to M78 (a pinned regression case)                                                                                                                          |
| `database-plugin/test/unit/mongo-query.test.ts`                          | `src/adapters/mongo/mongo-query.ts`                        | A two-segment path becomes the dotted key `'address.city'`; an empty path is refused; a `Date` passes through unescaped                                                                                                                                                                          |
| `database-plugin/test/unit/mongo-data-source.test.ts`                    | `src/adapters/mongo/mongo-data-source.ts`                  | Composite `findById`, `update` and `delete` build the multi-field filter; `findPage` pages against the recorded cursor arguments                                                                                                                                                                 |
| `database-plugin/test/unit/filter-conformance.test.ts`                   | all five adapters                                          | One nested-path query, one `Date` range query and one three-page cursor walk run through **every** adapter; each result matches the reference, and any adapter that cannot serve the query refuses with its own named class — extending the existing M70b table rather than adding a second one  |
| `database-plugin/test/unit/barrel-exports.test.ts`                       | `src/index.ts`                                             | The three new symbols and six re-exports are present, asserted against the barrel rather than the concrete modules (the M56 defect class)                                                                                                                                                        |
| `database-plugin/test/integration/database-plugin.test.ts`               | plugin, service and repository                             | Through a real kernel application: a composite-key repository writes and reads back, and a cursor walk over a seeded table returns every row exactly once                                                                                                                                        |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts`          | Drizzle against the real SQL generator                     | The composite-key `WHERE` and the keyset predicate are asserted in the **emitted SQL** and executed against the real `node:sqlite` engine — the M68 precedent, where a string assertion alone missed a live defect                                                                               |
| `database-plugin/test/integration/real-mongo-adapter.test.ts`            | Mongo against a real server (guarded on `MONGO_URL`)       | A compound-`_id` collection round-trips through `findById`, `update` and `delete`; a nested-path filter matches a real subdocument; a cursor walk returns every document once                                                                                                                    |
| `database-plugin/test/integration/real-prisma-adapter.test.ts` **(new)** | Prisma against live PostgreSQL (guarded on `POSTGRES_URL`) | Composite round trip through the repository; the named-`@@id` refusal and its `compositeKeyName` fix; JSONB path; `Date` range; a tied-fixture cursor walk — see §6.1                                                                                                                            |
| `cloudflare-plugin/test/unit/d1-sql.test.ts`                             | `src/database/d1-sql.ts`                                   | Multi-column key predicates bind in column order and respect `D1_MAX_BOUND_PARAMS`; a nested path and a `Date` are each refused with `CloudflareUnsupportedError` naming the cause                                                                                                               |
| `cloudflare-plugin/test/unit/d1-data-source.test.ts`                     | `src/database/d1-data-source.ts`                           | Composite key on the committed path and on the deferred-write transaction path (where `update` and `delete` read first); `findPage` against the real `node:sqlite` engine the M52c suite already drives                                                                                          |
| `cloudflare-plugin/test/unit/d1-adapter.test.ts`                         | `src/database/d1-adapter.ts`                               | `resolveTarget` normalises both `primaryKey` forms; the zero-config default is still `['id']`                                                                                                                                                                                                    |

**Negative controls to run and revert, each observed failing before it is trusted:**

1. Drop the sort fingerprint from the cursor payload — the cross-sort test must serve a silently
   wrong page.
2. Make `keyValues` accept a scalar against a two-column target — the composite adapter tests must
   report the wrong row rather than refusing.
3. Revert `comparableGreaterThan` to its `number`-and-`string` form — every `Date` filter must match
   nothing (§3.9's stated failure).
4. Restore a `path?: readonly string[]` field beside `field` in one adapter and ignore it — the
   nested-path conformance row must return root-field rows instead of failing to compile.
5. Have one adapter's `findPage` page with the bare limit instead of one extra row — the last page
   must report a `nextCursor` that yields an empty page.
6. Make one refusal throw synchronously instead of rejecting — its `.rejects.toThrow` assertion must
   fail (§3.12).

### 6.1 Behavioural tests against a LIVE database (required, not optional)

Every probe in §1A is committed as a behavioural test, because a probe run once in a scratch
directory proves the design and guards nothing. Each suite is **guarded on its connection
environment variable and skips via `ignore` rather than by returning early inside the test body** —
the M70c trap, where a suite reported _passed_ while asserting nothing, and where the ignored count
is the only tell. §1B carries the container commands and connection strings.

**`real-prisma-adapter.test.ts`** — guarded on `POSTGRES_URL`, against PostgreSQL 16. The schema it
pushes carries **both** compound-key models, because the two behave differently (P2):

1. A composite `findById`/`update`/`delete` round trip through the **repository** surface on the
   unnamed-`@@id` model, asserting `update` returns the updated row and `delete` reports `true`.
2. The named-`@@id` model refuses by name without `compositeKeyName`, and succeeds with it — the
   assertion that P2 exists at all.
3. A nested-path filter matches real JSONB rows (P7).
4. A `Date` range filter returns the expected rows (P9).
5. A three-page cursor walk over a fixture **seeded with deliberate sort-key ties** returns every
   row exactly once (P10/P11).

**`real-mongo-adapter.test.ts`** — guarded on `MONGO_URL`, against MongoDB 8 (replica set):

1. A flat composite key round-trips through `findById`/`update`/`delete`, and matches regardless of
   the caller's key-object property order.
2. A compound-`_id` collection under `idType: 'compound'` round-trips — and the **order-sensitivity
   guard**: the same key written in the reverse property order still matches, which only holds
   because the adapter imposes the mapping's order (P4/P5). This assertion is the reason the arm is
   safe to ship, and no fake can produce it.
3. A dotted nested-path filter matches a real subdocument (P8).
4. A `Date` range filter (P9), and the tied-fixture cursor walk (P10/P11).

**Both suites carry the P11 negative control as a committed test**, not merely as a manual step: a
cursor walk built **without** the key tiebreaker over the tied fixture must lose rows. It is
asserted as a loss so the guard fails if a future change makes the naive walk correct by accident.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m79-portable-data-access-contract, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus, because this milestone changes three packages' published surface:

```bash
deno task publish:check          # on a COMMITTED tree
deno task release:verify <version>
```

And the guarded real-backend suites (§6.1), which the fake-only path cannot substitute for. Bring
the containers up with §1B, then run with **both** variables set — a missing one skips that suite,
and the **ignored count in the summary is the only tell**:

```bash
MONGO_URL='mongodb://127.0.0.1:27017/setu_m79?replicaSet=rs0' \
POSTGRES_URL='postgresql://postgres:probe@127.0.0.1:5433/m79probe' \
  deno task test
```

Confirm the run was not vacuous: the summary must report **0 ignored** for these two suites. Both
packages' `deno.json` `test.permissions.net` allowlists need `127.0.0.1:27017` and `127.0.0.1:5433`
— a CLI `--allow-net` **replaces** that block rather than unioning with it (M53), so the grant
belongs in the manifest and stays endpoint-scoped.

## 8. Risks & mitigations

- **The milestone is large: four contract members across five adapters and three packages.** Land it
  in the §3 order — key representation, then mapping, then paths, then cursor — with the gates green
  at each step, so a regression is attributable to one member rather than to the whole diff.
- **Breaking for implementors, three times over** (the `IDataSource` parameter widening, the
  `FilterComparison.field` widening, the `IRepository` key constraint). Every in-repo implementor is
  updated here; an out-of-repo one gets a compile error, never a silent behaviour change. Mitigation
  is the CHANGELOG migration text, written as part of the PR and not after it — the M69 finding,
  where a breaking change was filed under "Added" with no migration note.
- **A test double that accepts what a real driver refuses.** This repository's single most recurring
  root cause (M37b ioredis, M53 `zrangebyscore`, M55 `Deno.FsFile.read`, M70l RabbitMQ). Mitigation:
  the Drizzle and D1 cursor and composite-key paths are exercised against the real `node:sqlite`
  engine, and Mongo against a real server, not only against recording fakes.
- **~~The Prisma compound-key name is an external fact.~~ Retired — measured (P1, P2, P6).** The
  derived name, the named-key rejection and the row-returning `update`/`delete` are all confirmed
  against a real generated Prisma 7.10.0 client on live PostgreSQL 16.
- **A live-backend suite that skips while reporting green.** The M70c trap. Mitigation: both suites
  in §6.1 guard with `ignore` rather than an early return, and §7 requires reading the ignored count
  rather than the pass count.
- **A cursor test that passes vacuously.** Measured during planning: the first P10 walk used
  distinct sort values, so the tiebreaker branch never executed and would have passed against a
  builder that omitted it entirely. Mitigation: every committed cursor fixture seeds deliberate
  ties, and the P11 negative control is committed alongside as a test that must observe a loss.
- **Cursor pagination over a non-unique sort with no usable tiebreaker.** An entity whose key
  columns are absent from a projection cannot mint a cursor. Mitigation: `findPage` adds the key
  columns to `select` when a projection is present and strips them from the returned rows, and a
  test pins that the caller's projection is what comes back.
- **Coverage regression in the files being widened.** Every file in §5 already sits at or above the
  bar; adding branches without tests drops it silently, since the coverage task exits 0 under the
  bar. Mitigation: read the ANSI-stripped per-file table after each of the four steps, not once at
  the end.

## 9. Out of scope

- **TTL, consistency level, secondary-index selection** — M78's blocker 3. No two candidate backends
  spell any of them alike and none has a second consumer today, so each ships with the adapter that
  first needs it.
- **Partition awareness as portable surface** — per-entity mapping rather than contract. M80 owns
  the DynamoDB partition-plus-sort key, M81 the Cosmos partition key, M82 the Bigtable row key.
- **The DynamoDB, Cosmos DB and Bigtable adapters** — M80, M81 and M82 respectively, all gated on
  this milestone.
- **Removing or deprecating `offset`** — released API under §9.4, and the cursor is additive beside
  it (§3.10).
- **Nested paths in `where`, `orderBy` and `select`** — this milestone gives `FilterComparison` a
  path form only. `NormalizedQuery.where` stays a flat record, and sorting or projecting a
  subdocument field stays unexpressible. Named rather than absorbed: the three other members have no
  second consumer yet (the ROADMAP's own `poolSize` rule), and `select` in particular would need
  every adapter to reshape returned rows rather than pass a projection through. The milestone that
  first needs one of them owns all three.
- **A shared refusal error class in `common`** — declined in §3.11 with cause, not deferred.
