# @setu-ts/idempotency-plugin

A repeated HTTP request, queue job or broker message is recognised by its key: a repeat of completed
work is **answered from its record or skipped** instead of running again. One core state machine —
`claim(key, fingerprint, lease)` → `claimed` with a token, then `complete(token, record)` or
`release(token)` — sits behind one store port in `@setu-ts/common`, with an in-process store and two
cross-replica stores (Redis and a Cloudflare Durable Object). Two entry points reach it: a
route-level `idempotent(options)` middleware plus an `@Idempotent()` decorator for HTTP, and an
ingress behaviour `idempotentIngress(options)` for queue jobs and broker messages.

The guarantee this package delivers is **no duplicate processing within the limits of the store** —
it is not, and does not claim to be, a single-execution guarantee. It is the first of three
guarantees; the other two are out of scope here:

1. **No duplicate processing.** A second arrival of a key whose work completed is answered from the
   record (HTTP) or skipped (ingress); a concurrent second arrival is refused (`409` on HTTP, a
   retryable rejection on ingress).
2. **The work and its record committed together** — writing the record inside the business
   transaction is a later milestone.
3. **External side effects once** — achievable only by forwarding a derived key (see
   [`derivedIdempotencyKey`](#forwarding-a-key-to-a-provider)) to a provider that de-duplicates.

## Installation

```bash
deno add jsr:@setu-ts/idempotency-plugin
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { IdempotencyPlugin, idempotent } from '@setu-ts/idempotency-plugin';

const app = createApplication({
  plugins: [RuntimePlugin(), IdempotencyPlugin({ store: { type: 'memory' } })],
});

app.router.post('/payments', {
  middleware: [idempotent()],
  handler: (ctx) => ctx.response.status(201).json({ id: 'pay-1' }),
});

await app.start({ port: 3000 });
```

## Placement

**List `idempotent()` LAST in the route's `middleware` array — after guards and validation.** An
unkeyed or invalid request that never reaches the store must not consume a key, and a request that
fails validation must be retryable with the same key. `@Idempotent()` is appended last by the
decorator plugin for the same reason.

## The HTTP check order

The middleware runs these steps in this order:

1. **Safe method** — `GET`, `HEAD`, `OPTIONS` pass through with no store call.
2. **Key extraction** — from the configured header (default `Idempotency-Key`), a body field, or a
   function.
3. **Missing key with `required: false`** passes through, before any principal check.
4. **Principal** — `principal: 'required'` (the default) answers `401` when no principal is present.
   With `principal: 'optional'`, every anonymous request shares one scope, so an anonymous caller
   who sends another anonymous caller's key is served that caller's stored response. Pair it with
   `response: 'status'` unless the response is safe to show any anonymous caller.
5. **Missing key with `required: true`** answers `400`; an invalid key answers `400`.
6. **Fingerprint** — by default a SHA-256 over the method, path, raw query, content-type and body
   bytes.
7. **Scope and key derivation**, then **claim**.
8. **Outcome** — replay, or an error status.

| Condition                      | Status |
| ------------------------------ | ------ |
| no principal (`required`)      | `401`  |
| key missing (`required: true`) | `400`  |
| key invalid                    | `400`  |
| fingerprint mismatch           | `422`  |
| claim in progress              | `409`  |
| capacity exceeded              | `429`  |
| claim failed / bad record      | `503`  |

## Failure classification

After a claim, the middleware runs the handler and then:

- a **thrown** error — including a thrown 4xx — releases the claim and rethrows the original error;
- a **returned** `2xx`/`4xx` (except `408`, `425`, `429`) is recorded;
- a returned `5xx`, `408`, `425`, `429`, or any status below `200` is released, not recorded. This
  is a deliberate departure from providers that replay `500`s.

The caller sees the response the handler produced, even if `complete` or `release` failed. After a
failed `complete` the record stays in-progress: a retry inside the lease gets `409`, a retry after
it re-executes.

## Replay rules

A replay writes the stored status and headers, adds `Idempotent-Replayed: true`, and sends the
stored body. Only an ALLOW list of headers is stored and replayed; a fixed DENY list (`Set-Cookie`,
`Content-Language`, `RateLimit-*`, `Retry-After`, `X-Request-Id`, `traceparent`, `Date`,
`Content-Length`, …) is never stored and is refused in `replayHeaders`. The stored record is
re-validated on every replay (status `200`–`499`, current allow/deny lists, body size), so a
tampered record answers `503` instead of being replayed.

**Query order matters.** The default fingerprint hashes the raw query exactly as received, so
`?a=1&b=2` and `?b=2&a=1` fingerprint differently.

## Ingress: the allow-list and the consumer identity

`idempotentIngress(options)` acts only on an explicit `topics` (broker) and/or `jobNames` (queue)
allow-list. Everything else — including every `scheduler` and `websocket` envelope, and the realtime
backplane's topic — passes through untouched, with no store call.

The key includes the **consumer** identity (`IngressContext.consumer`), so two subscribers on one
topic each run once rather than one being skipped as a "duplicate". On a listed topic, **pass
`queue` to `subscribe` for competing-consumer subscriptions**; a queue-less subscription's consumer
id is per process, so a redelivery to another replica is not de-duplicated.

On a listed topic or job with no key, the behaviour throws a named refusal: a queue job dead-letters
after its attempts, and a broker redelivers per its own policy.

## Store guarantees

| Tier | Store                    | Claim atomicity                      | Across replicas | Crash mid-work                                | Clock               |
| ---- | ------------------------ | ------------------------------------ | --------------- | --------------------------------------------- | ------------------- |
| A    | memory                   | one event-loop turn                  | No              | the record dies with the process              | `runtime.hrtime()`  |
| B    | Redis (Lua)              | one `EVAL`                           | Yes             | the record survives; takeover after the lease | Redis server `TIME` |
| B    | Durable Object           | one object per key; input gate       | Yes             | the record survives; takeover after the lease | DO `now()`          |
| C    | the application database | one transaction, claim created first | Yes             | the record and the work commit together       | `runtime.now()`     |

Tier A on Cloudflare Workers is per isolate — use the Durable Object store there. The ingress entry
point is not available on Workers in this release.

### Tier C: the work and its record commit together

`within(options, fn)` is tier C, for a handler that owns a database transaction. It opens ONE
transaction, creates a claim row in it FIRST, runs `fn` with that transaction's unit of work,
creates a result row holding `fn`'s JSON result, and commits — so the work and its idempotency
record are all-or-nothing. A repeated key whose record is committed returns the stored result
without running `fn` (`replayed: true`); a concurrent duplicate loses the race on the claim's
primary key and its business writes roll back with it, then it replays the winner's result — or,
where it failed before the winner committed, rejects with a retryable `409` (which `@setu-ts/sdk`'s
keyed client retries).

On both the first call and a replay, `value` is the JSON round trip of what `fn` returned: a `Date`
becomes an ISO string, `undefined` object members are absent, and nested `toJSON()` methods
determine their stored representation. A `void` result remains `undefined`.

`scope` is REQUIRED and must be built ONLY from authenticated identity (typically
`` `${tenantId}:${principalId}` ``); `''` declares the record global on purpose. The raw key, scope
and namespace are never stored — only their derived hashes.

Configure it with `IdempotencyPlugin({ transactional: { store } })`, where `store` is
`createDatabaseIdempotencyStore()` from `@setu-ts/database-plugin` (or any
`ITransactionalIdempotencyStore`). The store is resolved and `verify()`d at `onInit`.

| Backend                         | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| memory                          | Supported, single process.                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| PostgreSQL (Drizzle)            | Supported; a loser's claim insert blocks on the primary key until the winner commits, then replays. Each blocked loser holds a pooled connection for the length of `fn`.                                                                                                                                                                                                                                                                                                 |
| PostgreSQL (Prisma)             | As Drizzle, but a loser waiting past Prisma's interactive-transaction timeout rejects `'conflict'`.                                                                                                                                                                                                                                                                                                                                                                      |
| SQLite (Drizzle, `node:sqlite`) | Supported; one writer at a time.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D1                              | Supported through `DatabasePlugin({ type: 'custom', adapter: D1Adapter })`; writes are deferred to one batch at commit, so `fn` runs before a concurrent duplicate is refused — its outside effects run for both.                                                                                                                                                                                                                                                        |
| MongoDB replica set             | Supported; a loser is an immediate write conflict.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| MongoDB standalone              | Refused, `'mongodb-standalone'`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| DynamoDB                        | Supported (deferred, `TransactWriteItems`); a concurrent loser replays the winner's result, or rejects `'conflict'` when service transactions overlap. The `TransactionConflictException` outcome is documented-unverified on DynamoDB Local (M90f). Writes are deferred, so `fn` runs for both calls: database writes commit once, outside effects run twice. Reads are eventually consistent, so a sequential repeat inside the consistency window can run `fn` again. |
| Cosmos DB                       | Refused, `'cosmos-unsupported'`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Bigtable                        | Refused, `'bigtable-unsupported'`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Expiry and retention.** A record is authoritative from commit until the scheduled purge deletes
it; `expiresAt` (from `within`'s `ttlMs`, default 86,400,000 ms) only makes it ELIGIBLE. The purge
deletes up to `purge.batch` (default 100) eligible records every `purge.intervalMs` (default
60,000), so **the table stays bounded only while inflow stays below that rate**. A key reused after
`ttlMs` replays until the purge runs. On Workers, set `purge: { schedule: false }` and call
`service.purgeTransactional()` from a Cron Trigger.

### Memory store capacity

The memory store caps each scope at `maxEntriesPerScope` (default 1,000) and the whole store at its
global entry and byte caps. A scope is the tenant and principal a key is derived for. A caller over
its scope's cap gets `429` while callers in other scopes still claim, but only until the GLOBAL cap
fills, after which every new claim gets `503`. One principal can occupy several scopes when the
tenant is chosen by the client (for example a tenant read from a request header), so the per-scope
cap alone does not stop one caller filling the store. Rate-limit upstream, or resolve the tenant
from a verified source.

### Redis durability caveat and version floor

A completed Redis record survives only under `maxmemory-policy noeviction` **and** persistence that
does not drop acknowledged writes on failover. Under any eviction policy, or when an asynchronous
replica is promoted after a primary dies, a completed record can vanish and the next duplicate
executes. The store warns at connect time when `maxmemory-policy` is not `noeviction`. Redis **≥ 5**
is required: `TIME` inside a script is safe only under script-effects replication, the default from
Redis 5.

### The queue retry span versus the lease

A lease held by a crashed holder blocks redeliveries of its key until it lapses; each redelivery
inside the lease is refused `in-progress`, which consumes a queue attempt. The retry span (the sum
of `computeBackoffMs(2..maxAttempts)`) must EXCEED the lease: with the default backoff and the
default 30 s ingress lease that means `defaultMaxAttempts ≥ 6`. The queue's retry configuration is
not readable from this plugin, so this is documented, not checked.

## Principal identity

A principal's identity is its `IPrincipal.id` alone — the type carries no issuer or strategy member.
An application authenticating through more than one issuer MUST ensure principal ids are unique
across them (for example by prefixing them in the strategy); otherwise two issuers' identical
subjects share a scope.

## Multi-replica deployments

Use the Redis or Durable Object store, each with a **required, per-application `namespace`** so two
applications sharing a backend never read each other's records.

## Retention and personal data

Completed records live for `ttlMs` (default 24 h). A stored response may hold personal data and
secrets at rest for that time, so retention counts toward the data inventory and erasure timelines.
Use `response: 'status'` and/or `redaction` where a body must not be stored. Note that in status
mode the **fingerprint** — an unsalted SHA-256 of the request body — is still stored, so a
low-entropy body (a short code, a PIN) can be confirmed by brute force from it.

## Forwarding a key to a provider

```typescript
import { derivedIdempotencyKey, idempotent } from '@setu-ts/idempotency-plugin';

app.router.post('/charges', {
  middleware: [idempotent()],
  handler: (ctx) => {
    // `key` is stable per principal + namespace + client key; forward it to a
    // provider that de-duplicates.
    const key = derivedIdempotencyKey(ctx) ?? '';
    return ctx.response.status(201).json({ forwardedKey: key });
  },
});
```

## What this mechanism is not

- It is **not** a substitute for a business uniqueness constraint ("one payroll run per company and
  period") — that is a unique index, not an idempotency key.
- It does **not** de-duplicate scheduler ticks; those are already slot-locked.
- It does **not** make an outbound call happen once, unless the provider de-duplicates on the key
  you forward.

## The IETF draft

The `Idempotency-Key` header and the status codes follow
[draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
**draft-07, expired**. It is cited for the header field and the `400`/`409`/`422` semantics this
package implements.

## Exports

| Export                                 | Kind      |
| -------------------------------------- | --------- |
| `IdempotencyVerifyTimeoutError`        | class     |
| `IdempotencyWithinError`               | class     |
| `IdempotencyWithinErrorReason`         | type      |
| `TransactionalIdempotencyOptions`      | interface |
| `TransactionalIdempotencyPurgeOptions` | interface |
| `derivedIdempotencyKey`                | function  |
| `IdempotencyPlugin`                    | function  |
| `idempotent`                           | function  |
| `idempotentIngress`                    | function  |
| `IdempotencyConfigurationError`        | class     |
| `IdempotencyRefusedError`              | class     |
| `IDEMPOTENCY_KEY_HEADER`               | const     |
| `IDEMPOTENT_REPLAYED_HEADER`           | const     |
| `IdempotencyPluginOptions`             | interface |
| `IRedisIdempotencyClient`              | interface |
| `IdempotencyRefusalReason`             | type      |
| `IdempotencyStoreConfig`               | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#idempotencyplugin-setu-tsidempotency-plugin).
