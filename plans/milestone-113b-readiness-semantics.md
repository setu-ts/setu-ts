# Milestone 113b — Readiness that does not describe the dependency (`@setu-ts/service-discovery-plugin`, `health-plugin`, `scheduler-plugin`, `cache-plugin`, `session-plugin`, `auth-plugin`, `messaging-plugin`, `realtime-backplane-plugin`, `worker-pool-plugin`, `static-plugin`, `feature-flags-plugin`, `common`, `database-plugin`)

> **Status:** Planning. Branch: `feat/m113b-readiness-semantics`. `develop` and `main` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR
> targeting `develop`.

## 0. Objective & scope

Four `v0.9.0` smoke findings share one shape: a readiness or error signal describes the framework's
own state, or its own bookkeeping, rather than whether the dependency behind it can serve. V9-2
(High) makes every Kubernetes and Consul replica fail `/ready` while discovery works. V9-19 pulls a
replica out of rotation for one parked inbox message. V9-32 reports the scheduler `up` with
`connected: true` through a Redis lock outage that skips every fire. V9-44 answers a Redis outage as
a masked `500` where a database or Vault outage answers `503`. The milestone fixes all four and
settles, once, what `degraded` means — the maintainer's decision (2026-10-16): **the rule stays**.
`/ready` is `200` only when every contributed indicator is `up`, so `degraded` means "take this
replica out of rotation". The indicators whose own comments assume the opposite are corrected to
report `up` with the problem in `data`.

- **In scope:** V9-2, V9-19 (generalised to every indicator whose `degraded` contradicts the rule —
  §3.2), V9-32, V9-44 (plus the missing `commandTimeoutMs` on the rate-limit Redis client, the same
  outage reaching a client as a hang instead of a `503`).
- **NOT this milestone:**
  - **V9-68** (`/ready` 200 over a missing migration) moves to a new **M113o**, at the maintainer's
    direction (2026-10-16). It needs a migration ledger the generated runner writes plus a
    database-plugin readiness option — a design touching `database-plugin` + `cli`, not a readiness
    fix. The ROADMAP section, table row and Progress row are deliverables of this PR (C4).
  - **Service-discovery's `degraded` on a stale cache.** Every replica shares the discovery backend,
    so a backend blip pulls all of them at once — the correlated-failure shape V8-3 removed from the
    database indicator. That indicator is consistent with the rule, so it is left alone here and
    moves to **M113o** beside V9-68, at the maintainer's direction (2026-10-16): both are readiness
    that answers from the wrong evidence — one too optimistic (no schema check), one too pessimistic
    (a shared-backend blip pulls every replica while a warm cache still serves).
  - Outbox/inbox signal changes beyond their status mapping — M113j.

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                            | Verified surface / fact                                                                                                                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ready` status rule                           | `packages/health-plugin/src/plugin/health-plugin.ts:293-310` (`determineStatusCode`)                          | `checkReady` → `report.status === 'up' ? 200 : 503`; `/health` → 503 only on `down`. Unchanged since M20 (`36f4f2fd`). `/live` always 200.                                                                                                                 |
| `ServiceDiscoveryService.isHealthy`            | `packages/service-discovery-plugin/src/services/service-discovery-service.ts:113-123`                         | `const probe = this.#provider.isHealthy; … await probe();` — a DETACHED call; `this` is `undefined`.                                                                                                                                                       |
| `DiscoveryProvider.isHealthy?`                 | `packages/service-discovery-plugin/src/interfaces/index.ts:73`                                                | Optional `isHealthy?(): Promise<boolean>`.                                                                                                                                                                                                                 |
| Kubernetes / Consul / static providers         | `providers/kubernetes-provider.ts:193`, `providers/consul-provider.ts:152`, `providers/static-provider.ts:46` | Kubernetes and Consul `isHealthy` read `this.#…` private fields, so the detached call throws `TypeError`, the service's `catch` answers `false`, and the indicator reports not-up. Static reads nothing, which is why the static provider never showed it. |
| Discovery indicator                            | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:96-115`                             | `!everResolved && !reachable` → `down`; `degraded \|\| (everResolved && !reachable)` → `degraded`; else `up`.                                                                                                                                              |
| Inbox indicator                                | `packages/messaging-plugin/src/inbox/inbox-health.ts:62-76`                                                   | `parked > 0` → `degraded` with `reasons: ['parked-rows']`; `down` before verification / unreachable; `up` + `reachable: 'unknown'` on timeout.                                                                                                             |
| Outbox indicator                               | `packages/messaging-plugin/src/outbox/outbox-health.ts:142-170`                                               | Six reasons (`oldest-pending-age`, `failed-rows`, `failed-scan-cap`, `blocked-key-cap`, `store-write-failing`, `relay-overlap`), any → `degraded`; `down` before verification, on closing, and when `stats()` does not answer.                             |
| Realtime-backplane indicator                   | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:134-150`                          | `reachable === false` → `degraded`, with the comment "local delivery still works, so /ready keeps serving" — false against `determineStatusCode`.                                                                                                          |
| Worker-pool indicator                          | `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts:104-125`                                        | `available ? 'up' : 'degraded'`, with the comment "`degraded` keeps `/ready` at 200 (`health-plugin.ts:218`)" — false; every Workers deployment registering the plugin answers `/ready` 503 today.                                                         |
| Static-files indicator (no `fs`)               | `packages/static-plugin/src/plugin/static-plugin.ts:50-58`                                                    | Registered as `degraded` on Workers ("Workers degradation").                                                                                                                                                                                               |
| Auth indicator                                 | `packages/auth-plugin/src/plugin/auth-plugin.ts:279-294`                                                      | `degraded` when any issuer key set is not `current`; comment: "never reports `down`, because an identity-provider outage must not restart the application".                                                                                                |
| Feature-flags indicator                        | `packages/feature-flags-plugin/src/plugin/feature-flags-plugin.ts:110-136`                                    | `degraded` whenever the provider's `status().healthy` is false (DatabaseProvider keeps its last good snapshot).                                                                                                                                            |
| Database indicator                             | `packages/database-plugin/src/plugin/database-plugin.ts:240-275`                                              | Relies on the rule: a hung probe is `degraded` "and `/ready` fails with it". Not changed.                                                                                                                                                                  |
| gRPC health bridge                             | `packages/grpc-plugin/src/health/grpc-health-bridge.ts:42-58`                                                 | `degraded → NOT_SERVING`, "the health plugin already withdraws a degraded replica". Consistent with the rule; not changed.                                                                                                                                 |
| Scheduler indicator                            | `packages/scheduler-plugin/src/services/scheduler-service.ts:212-222`                                         | `{ status: connected ? 'up' : 'down', data: { connected } }` — lifecycle only; the lock is never consulted.                                                                                                                                                |
| `IDistributedLock`                             | `packages/scheduler-plugin/src/interfaces/index.ts:25-44`                                                     | `acquire(key, ttlMs)`, `release(key, token)` only. Exported (`distributed-lock.ts:19`).                                                                                                                                                                    |
| `IRedisLockClient`                             | `packages/scheduler-plugin/src/interfaces/index.ts:402-409`                                                   | `set`, `quit`, `eval` — no `ping`. Injected clients are validated against this shape.                                                                                                                                                                      |
| `RedisLock`                                    | `packages/scheduler-plugin/src/lock/redis-lock.ts:166-280`                                                    | Builds its client with `commandTimeout` (M101a V8-24); `connect`/`disconnect`/`acquire`/`release`.                                                                                                                                                         |
| `MemoryLock`                                   | `packages/scheduler-plugin/src/lock/memory-lock.ts:29`                                                        | In-process `IDistributedLock`.                                                                                                                                                                                                                             |
| Cache `RedisStore` data path                   | `packages/cache-plugin/src/stores/redis-store.ts:251-300`                                                     | `get`/`set`/`delete`/`has`/`clear` await the client with no `catch`: an ioredis rejection propagates raw, unbranded → masked 500.                                                                                                                          |
| `CacheSessionStore`                            | `packages/session-plugin/src/stores/cache-session-store.ts:55-67`                                             | `read`/`write`/`destroy` delegate to `ICacheService` with no translation — a Redis outage reaches the session middleware as the cache store's error. Fixing the cache store fixes the session path; session-plugin changes no `src` (test only).           |
| `RedisRateLimitStore`                          | `packages/auth-plugin/src/stores/redis-rate-limit-store.ts:58-80, 172-195`                                    | `new RedisCtor(url)` — NO `commandTimeout`; `increment`/`reset` await `incr`/`pexpire`/`pttl`/`del` raw. A stopped Redis → raw error → 500; a paused Redis → the request waits on ioredis's retry budget.                                                  |
| `withHttpStatusHint` / M90f wrapping precedent | `packages/common/src/errors/status-hint.ts:141`; `packages/database-plugin/src/errors.ts:565-583`             | A package-owned error class that brands ITSELF with a `503` hint in its constructor and carries the driver error as `cause`; wrapping beats branding because `withHttpStatusHint` throws on a frozen error.                                                |
| Errno set                                      | `packages/database-plugin/src/errors/classify.ts:96-115` (`UNAVAILABLE_ERRNOS`)                               | Eight node/net errno strings meaning "temporarily unreachable", measured in M90f. Module-private.                                                                                                                                                          |
| `createCachedProbe`                            | `packages/common/src/health/probe.ts:121-137`                                                                 | The cached, time-bounded probe helper (M70c) — 5 s TTL, 2 s bound defaults, runtime clock + timers.                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                | Resolution (picked side)                                        | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `PUBLIC_API.md:4150` (realtime-backplane: "`degraded` — local delivery still works, so `/ready` keeps serving") and `:8614`/`:8635` (`/ready` 503 on `degraded`) contradict each other. | `:8614` — the code's rule, kept by the maintainer.              | Backplane section rewritten to the new `up` + `data.reachable: false` mapping; worker-pool, static-files, auth, feature-flags, inbox and outbox PUBLIC_API sections updated the same way (§3.2 table).                                                                                                                                                                                                                                         |
| C2  | Six source comments (§1) claim `degraded` keeps `/ready` at 200.                                                                                                                        | The rule.                                                       | Every one rewritten to state the corrected mapping and cite `determineStatusCode`.                                                                                                                                                                                                                                                                                                                                                             |
| C3  | `packages/health-plugin/README.md` never states the readiness rule or what `degraded` is for.                                                                                           | State it.                                                       | README gains a "What `degraded` means" section: `/ready` fails on anything not `up`; an indicator reports `degraded` only for "this replica should not take traffic", and a problem every replica shares belongs in `data`. Mirrored in PUBLIC_API's health section.                                                                                                                                                                           |
| C4  | ROADMAP M113b lists V9-68 and `cli`; the table row lists `database`, `cli`.                                                                                                             | V9-68 and the service-discovery stale-cache case move to M113o. | ROADMAP: M113b section + table row package list corrected (§5 list), a new `### Milestone 113o` section carrying V9-68 AND the service-discovery stale-cache readiness case (packages `database-plugin`, `cli`, `service-discovery-plugin`; its plan decides whether a warm-cache backend outage is `up` with `data.degraded: true`), a table row and a Progress row `113o`, and the Deliverables "plan per design letter" bullet gains M113o. |

## 3. Design decisions

### 3.1 V9-2 — call the provider probe as a method

- **Decision:** `ServiceDiscoveryService.isHealthy()` calls `this.#provider.isHealthy?.()` (a method
  call on the provider), keeping the absent-member → `true` and throw → `false` arms. No provider
  changes.
- **Why:** the detached call loses `this`; Kubernetes and Consul read private fields. One line fixes
  both providers and any custom provider written as a class.
- **Test home:** `service-discovery-service.test.ts` drives the service over REAL
  `KubernetesProvider` and `ConsulProvider` instances (with their `IDiscoveryHttp` seam faked to
  answer the probe) and asserts `isHealthy() === true`; plus an integration test through a kernel
  app asserting `/ready` 200 with the Kubernetes provider. Both must fail against the detached form
  (negative control). The existing plain-object provider doubles are why this shipped; at least one
  must be replaced by a class whose method reads `this`.

### 3.2 V9-19 — `degraded` means "out of rotation"; indicators that meant "visible but ready" report `up`

- **Decision:** `determineStatusCode` is unchanged. Each indicator below changes its mapping; the
  condition stays visible in `data` (existing `reasons` arrays kept, a boolean added where none
  exists):

  | Indicator                                       | Today                                     | After                                                                                                                                                                                                                                                                         |
  | ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | inbox (`inboxToken`, `messaging-plugin.ts:853`) | `parked > 0` → `degraded`                 | `up`, `data.parked` and `data.reasons: ['parked-rows']` unchanged                                                                                                                                                                                                             |
  | outbox                                          | any of six reasons → `degraded`           | `up`, `data.reasons` unchanged. A relay problem is shared by every replica and does not stop this replica serving; the request-path write is covered by the database indicator. `down` arms unchanged.                                                                        |
  | `realtime-backplane`                            | `reachable === false` → `degraded`        | `up`, `data.reachable: false` (field already present)                                                                                                                                                                                                                         |
  | `worker-pool`                                   | `available === false` → `degraded`        | `up`, `data.available: false` (field already present)                                                                                                                                                                                                                         |
  | `static-files` (no fs)                          | `degraded`, top-level `detail`            | `up`, `data: { fs: false, detail: 'no file system on this runtime' }`. `HealthCheckResult` is `{ status, data? }` only (`common/src/services/health.ts:13-18`), and the M70c projection drops undeclared fields, so today's top-level `detail` never reaches `/health` at all |
  | `auth`                                          | any issuer not `current` → `degraded`     | `up`, `data.issuers` unchanged, plus `data.current: boolean`                                                                                                                                                                                                                  |
  | `feature-flags`                                 | `status().healthy === false` → `degraded` | `up`, `data.healthy: false` and `data.detail` when present                                                                                                                                                                                                                    |

  Indicators NOT changed, because their `degraded` means what the rule says: database (hung probe),
  service-discovery, gRPC bridge, health-plugin internals, and cloudflare. Off-platform, every store
  method of this replica is about to fail (`cloudflare-plugin/src/health/indicator.ts:40-60`), so
  the misconfigured replica should not take traffic.

- **Why:** the maintainer's decision. Every changed indicator says in its own comment that it meant
  `/ready` to stay 200, or else describes a condition every replica shares, where failing readiness
  pulls all replicas at once (the V8-3 lesson). The cost, stated in C3: these conditions no longer
  change `/health`'s status, so alerting must read `data`.
- **Test home:** each package's existing indicator test is updated to assert `up` plus the `data`
  field; one integration test per changed package drives a real kernel app with `HealthPlugin` and
  asserts `/ready` 200 with the condition present in the body (inbox: a parked row through the
  memory store). A health-plugin test pins the unchanged rule: `degraded` → `/ready` 503,
  `/health` 200.

### 3.3 V9-32 — the scheduler indicator probes its lock backend; status stays lifecycle

- **Decision:**
  - `IDistributedLock` gains an OPTIONAL `isHealthy?(): Promise<boolean>`.
  - `IRedisLockClient` gains an OPTIONAL `ping?(): Promise<unknown>`.
  - `RedisLock.isHealthy()` answers `false` before `connect()` and after `disconnect()`. Otherwise
    it answers `true` iff `ping` resolves and `false` if it rejects, bounded by the client's own
    `commandTimeout`. An injected client without `ping` gets no `isHealthy` result: `RedisLock`
    exposes the member, and returns `undefined` through a tri-state internal helper.
  - `MemoryLock.isHealthy()` answers `true`.
  - `SchedulerService.createHealthIndicator()` reads the lock through `createCachedProbe` (5 s TTL,
    2 s bound, runtime clock/timers). It reports
    `{ status: connected ? 'up' : 'down', data: { connected, lock: { reachable: true | false | 'unknown' } } }`,
    where `'unknown'` covers a lock without `isHealthy`, a client without `ping`, or a probe that
    timed out.
- **Why:** the finding is visibility. Status stays lifecycle because the lock is shared by every
  replica: `degraded` would pull them all for an outage that stops cron fires, not request serving
  (§3.2's rule). Both new members are optional, so no implementor breaks; the M90b cache precedent
  made `ping` REQUIRED, but there is no reason to break an injected lock client here.
- **Test home:** `redis-lock.test.ts` (ping resolve / reject / absent / before connect / after
  disconnect); `memory-lock.test.ts`; `scheduler-service.test.ts` for the indicator (all three
  `reachable` values, cache honoured, bound honoured with a never-settling probe); the existing real
  Redis suite gains a `docker pause`/stop case asserting `reachable: false` then `true` after
  recovery, guarded on `REDIS_URL` like the existing suites.

### 3.4 V9-44 — Redis outages answer 503 through package-owned wrapped errors

- **Decision:**
  - **`common` gains `isConnectionFault(error: unknown): boolean`.** It walks the `cause` chain
    (bounded, cycle-safe) and reports `true` for an `errno`/`code` in the eight-string set
    `database-plugin` measured, or for ioredis's outage shapes. Those shapes are to be MEASURED, not
    assumed: against a real Redis 7 that is stopped, paused (with `commandTimeout`), and refusing
    connections, record every error's `name`/`message`/`code` that ioredis 5 surfaces — expected
    candidates are `MaxRetriesPerRequestError`, `Command timed out`, `Connection is closed.`, and
    the offline-queue refusal — and put the measured list in the implementation report.
  - `database-plugin`'s `UNAVAILABLE_ERRNOS` membership test delegates to the common set (exported
    as `CONNECTION_FAULT_CODES`), so one list exists. Its classifier tests are the guard and must
    pass unchanged.
  - `cache-plugin` gains `CacheStoreUnavailableError` (503 hint, value-free detail
    `'The cache is temporarily unavailable.'`, original as `cause`). `RedisStore`'s
    `get`/`set`/`delete`/`has`/`clear` catch a rejection and rethrow it wrapped iff
    `isConnectionFault`; any other error (`WRONGTYPE`, a programming error) propagates unchanged.
  - `auth-plugin` gains `RateLimitStoreUnavailableError` (same shape, detail
    `'Rate limiting is temporarily unavailable.'`), applied in `RedisRateLimitStore.increment` and
    `reset`.
  - `RedisRateLimitStoreOptions.commandTimeoutMs`: default 15 000 and range `0`–`2147483647`,
    identical to cache-plugin's `DEFAULT_REDIS_COMMAND_TIMEOUT_MS` (`redis-store.ts:33`, M101a),
    refused out of range at construction, `0` omits it, and passed to the client it builds. It is
    ignored for an injected client, as cache-plugin's is.
  - No fail-open option: whether a limiter outage should admit traffic is policy, and is §9.
- **Why:** M89b/M90f decided that a dependency outage is a `503` carrying the original as `cause`.
  The cache store is the one `CacheSessionStore` reaches, so the session path is fixed with it. A
  paused Redis without `commandTimeout` never produces an error to wrap.
- **Test home:**
  - `common`: `connection-fault.test.ts` (each code; nested cause; cycle; non-object; a frozen error
    — must not throw).
  - `cache-plugin`: `redis-store.test.ts` (wrap on fault, pass-through otherwise, `cause` identity).
  - `auth-plugin`: `redis-rate-limit-store.test.ts` (wrap, `commandTimeoutMs` forwarded / refused /
    `0` omitted / ignored when injected).
  - **Real paused/stopped Redis, through a kernel app with `errorHandler({ format: 'rfc9457' })`:**
    - a cached route → 503;
    - a session-carrying route (`SessionPlugin({ store: 'cache' })` over the Redis cache) → 503;
    - a rate-limited route → 503;
    - each body asserted field by field, the Redis message ABSENT;
    - guarded on `REDIS_URL`, and run here.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `none`. Every new interface member is optional. Breaking BEHAVIOUR,
CHANGELOG'd under Changed with migration text, ships in minor 0.10.0:

- Seven indicators stop reporting `degraded` (§3.2), so `/ready` answers 200 where it answered 503
  and `/health`'s status no longer reflects those conditions.
- A Redis outage now answers 503 instead of 500.
- The rate-limit client now has a 15 s `commandTimeout` by default.

| Exported symbol                                                 | Kind      | Consumer / real code path that READS it                                                          |
| --------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------ |
| `isConnectionFault` (`@setu-ts/common`)                         | fn        | `RedisStore` (cache-plugin) and `RedisRateLimitStore` (auth-plugin) catch blocks                 |
| `CONNECTION_FAULT_CODES` (`@setu-ts/common`)                    | const set | `isConnectionFault`; `database-plugin` `classify.ts` errno membership                            |
| `CacheStoreUnavailableError` (`@setu-ts/cache-plugin`)          | class     | thrown by `RedisStore`; read by `errorHandler` through the status hint; `instanceof` for callers |
| `RateLimitStoreUnavailableError` (`@setu-ts/auth-plugin`)       | class     | thrown by `RedisRateLimitStore`; same readers                                                    |
| `IDistributedLock.isHealthy?` (scheduler-plugin, existing type) | member    | `SchedulerService.createHealthIndicator`                                                         |
| `IRedisLockClient.ping?` (scheduler-plugin, existing type)      | member    | `RedisLock.isHealthy`                                                                            |

### 4.1 Options — every option names its consumer

| Option                                        | Consumer                                       | Behavior (per implementation)                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisRateLimitStoreOptions.commandTimeoutMs` | `resolveClient` in `redis-rate-limit-store.ts` | Forwarded as ioredis `commandTimeout` to a built client; `0` omits it; ignored for an injected client; out of range (incl. `NaN`) → `RangeError` at construction |

## 5. Implementation files

| File                                                                                                                                                          | Purpose                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `packages/common/src/errors/connection-fault.ts` (+ `src/index.ts` export)                                                                                    | `isConnectionFault`, `CONNECTION_FAULT_CODES` |
| `packages/database-plugin/src/errors/classify.ts`                                                                                                             | delegate errno membership                     |
| `packages/service-discovery-plugin/src/services/service-discovery-service.ts`                                                                                 | §3.1                                          |
| `packages/messaging-plugin/src/inbox/inbox-health.ts`, `src/outbox/outbox-health.ts`                                                                          | §3.2                                          |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`                                                                                  | §3.2                                          |
| `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts`                                                                                                | §3.2                                          |
| `packages/static-plugin/src/plugin/static-plugin.ts`                                                                                                          | §3.2                                          |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                                                                                                              | §3.2                                          |
| `packages/feature-flags-plugin/src/plugin/feature-flags-plugin.ts`                                                                                            | §3.2                                          |
| `packages/scheduler-plugin/src/interfaces/index.ts`, `src/lock/redis-lock.ts`, `src/lock/memory-lock.ts`, `src/services/scheduler-service.ts`                 | §3.3                                          |
| `packages/cache-plugin/src/errors.ts` (or existing errors module) + `src/stores/redis-store.ts` + `src/index.ts`                                              | §3.4                                          |
| `packages/auth-plugin/src/stores/redis-rate-limit-store.ts`, `src/errors…` + `src/index.ts`                                                                   | §3.4                                          |
| `packages/health-plugin/README.md`, each changed package README, `PUBLIC_API.md`, `CHANGELOG.md` (Unreleased), `docs/upgrading.md` (Unreleased), `ROADMAP.md` | C1–C4                                         |

Package list for the ROADMAP row (C4): `service-discovery`, `health` (docs + one pin test),
`scheduler`, `cache`, `session` (test only), `auth`, `messaging`, `realtime-backplane`,
`worker-pool`, `static`, `feature-flags`, `common`, `database` (one-line delegation).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                            | src covered                           | Key assertions                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/common/test/unit/connection-fault.test.ts`                                                                                 | `connection-fault.ts`                 | §3.4 cases; `isConnectionFault(error: unknown): boolean`                             |
| `packages/database-plugin/test/unit/classify*.test.ts` (existing)                                                                    | `classify.ts`                         | unchanged — must pass as-is                                                          |
| `packages/service-discovery-plugin/test/unit/service-discovery-service.test.ts` + an integration test                                | `service-discovery-service.ts`        | §3.1, real provider classes; `/ready` 200 through a kernel app                       |
| inbox/outbox health tests (existing, updated) + one integration                                                                      | `inbox-health.ts`, `outbox-health.ts` | `up` + `reasons`; `down` arms unchanged; parked row → `/ready` 200                   |
| realtime-backplane, worker-pool, static, auth, feature-flags indicator tests (existing, updated) + one kernel-app `/ready` test each | their plugin files                    | §3.2 table, field by field                                                           |
| `packages/health-plugin/test/…` (one new case)                                                                                       | `health-plugin.ts`                    | rule pin: `degraded` → `/ready` 503, `/health` 200                                   |
| `packages/scheduler-plugin/test/unit/{redis-lock,memory-lock,scheduler-service}.test.ts` + real Redis case                           | §3.3 files                            | §3.3                                                                                 |
| `packages/cache-plugin/test/unit/redis-store.test.ts` + barrel test                                                                  | `redis-store.ts`, errors              | §3.4                                                                                 |
| `packages/auth-plugin/test/unit/redis-rate-limit-store.test.ts` + barrel test                                                        | store, errors                         | §3.4                                                                                 |
| one real-Redis e2e (cache, session, rate-limit routes; scheduler lock reachability)                                                  | —                                     | §3.3/§3.4 real-backend assertions; guarded on `REDIS_URL`, not in any skip allowlist |

Negative controls (each observed failing, then reverted): detached probe restored (§3.1 tests fail);
inbox mapping restored to `degraded` (`/ready` integration fails); `isConnectionFault` returning
`false` (all three 503 e2e cases fail); `commandTimeoutMs` not forwarded (forwarding test fails);
scheduler indicator ignoring the lock (real-Redis `reachable: false` case fails).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113b-readiness-semantics
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:deno-lane
pnpm run check:docs
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Real backends: a throwaway Redis 7 container (never the shared `he-*`/`smoke-*` ones), `REDIS_URL`
pointed at it, paused/stopped by the tests.

## 8. Risks & mitigations

- An application alerting on `/health` 200→`degraded` for one of the seven changed conditions loses
  that signal → the CHANGELOG and `docs/upgrading.md` name each condition and the `data` field that
  now carries it.
- The ioredis outage error shapes differ from the expected candidates → measured against a real
  Redis before `isConnectionFault` is written (§3.4); the measured list goes in the report.
- Rewrapping a cache error hides an `instanceof` check a caller made on the raw ioredis error → the
  original stays reachable as `cause`, as with M90f.

## 9. Out of scope

- V9-68 migration ledger and schema-aware readiness — **M113o**.
- Service-discovery's stale-cache `degraded` pulling every replica on a shared-backend blip —
  **M113o**.
- A fail-open rate-limit policy on store outage — no letter; would need its own decision.
- A per-indicator readiness option on `IHealthApi` — rejected by the maintainer in favour of §3.2.
- Outbox/inbox signal content beyond the status mapping — M113j.
