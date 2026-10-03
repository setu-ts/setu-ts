# Milestone 101a — health that reports healthy, and calls that hang, when a dependency fails

> **Status:** Complete. Branch: `feat/m101a-bounded-health`. `develop` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR. **Sequence:**
> first of the M101 letters (ROADMAP "Sequence") — it holds the release's only regression. M101b
> rebases on this branch's `messaging-plugin` health changes and reuses the outage-suite shape §3.2
> establishes.

## 0. Objective & scope

Six rows from the `v0.8.0` run (`smoke/DEFECTS.md` V8-1, V8-3, V8-4, V8-5, V8-23, V8-24) are one
reasoning error in six packages: an unbounded wait, or a bound that loses a race, read as "fine".
V8-1, V8-23 and V8-24 report healthy over a failure; V8-3 reports a failure over health; V8-4 and
V8-5 hang the caller while health is correct. The letter ships one rule — **every backend call is
bounded, and a bound that fires is a recorded failure** — and applies it per package through the
seam each package already has, with one outage test per package driven through `/health` and
`/ready` on a real kernel application.

- **In scope:** `ServiceBusBroker.reachability()` answering a retained negative outcome at once
  (V8-1); the Drizzle probe and the `database` indicator telling pool saturation from an outage
  (V8-3); a bounded Vault `fetch` with a `503`-branded outage error (V8-4); `commandTimeoutMs` on
  the cache and queue Redis arms (V8-5); an unread queue depth row no longer presented as a complete
  zero (V8-23); a bounded scheduler lock acquire recorded as `lock-failed`, plus `commandTimeoutMs`
  on the Redis lock (V8-24); the `withDeadline` helper in `common` that the two non-client-native
  bounds share (§3.1); one real-backend outage test per package through `/health` and `/ready`.
- **NOT this milestone:** the three Pub/Sub, NATS and Kafka transport defects (M101b); a
  reachability member on `IDistributedLock` (named in §9); `503` classification of a timed-out cache
  or queue command on the request path (§9); SDK-level timeouts for the AWS, GCP and Azure secrets
  providers (§9); the cache source `started` counter the V8-5 note offers as optional (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                             | Source (file:line)                                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCachedProbe` / `CachedProbeOptions`            | `packages/common/src/health/probe.ts:35-96,139-194`                                                                                 | caches for `ttlMs` (default 5000), bounds each probe with `timeoutMs` (default 2000) via `Promise.race`, resolves `fallback` (default `false`; `undefined` allowed through the widened overload) on timeout or rejection. It is a PROBE helper: it never rejects and never surfaces the timeout to the caller — the wrong shape for a request-path call whose timeout must be a recorded failure                                                                                     |
| `ProbeTiming` / `resolveProbeTiming`                  | `packages/common/src/health/probe.ts:202-249`                                                                                       | `{ hrtime, setTimer, clearTimer }` bound to an `IRuntimeServices`; exported from the barrel at `packages/common/src/index.ts:44-45`                                                                                                                                                                                                                                                                                                                                                  |
| No general bounded-call helper exists in `common`     | `grep -rn "AbortSignal.timeout\|withTimeout\|runWithTimeout\|withDeadline" packages/common/src`                                     | only `probe.ts` and two unrelated `timeoutMs` option fields (`services/worker-pool.ts:24`, `services/messaging.ts:61`). `resilience-plugin/src/patterns/timeout.ts` has one, but §2.2 forbids a plugin importing a plugin                                                                                                                                                                                                                                                            |
| Runtime-timer fetch bound precedent                   | `packages/auth-plugin/src/sign-in/routes.ts:101-125`                                                                                | `attempt(runtime, timeoutMs, body(signal))`: `AbortController` + `runtime.setTimeout`, raced "rather than trusted" because an injected seam may ignore the signal; maps every throw to `null` — a DIFFERENT contract from a recorded failure, so not a duplicate of §3.1                                                                                                                                                                                                             |
| `ServiceBusBroker.reachability()`                     | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:832-848`                                                               | reads `#dataPlaneEvidence()`; `true` returns at once; `false` FALLS THROUGH to `await this.#probe()` and returns `false` only after the probe settles (clearing on a `true` probe)                                                                                                                                                                                                                                                                                                   |
| `#recordDataPlaneOutcome(false)` rebuilds the probe   | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:902-910`                                                               | `this.#probe = this.#createManagementProbe()` — the cache is discarded, so the next read runs a cold probe                                                                                                                                                                                                                                                                                                                                                                           |
| Broker probe bound                                    | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:47,857-866`                                                            | `PROBE_TIMEOUT_MS = 2000`, `fallback: undefined`, `PROBE_TTL_MS = 5000`                                                                                                                                                                                                                                                                                                                                                                                                              |
| Indicator probe bound — EQUAL to the broker's         | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:57,60,447-456`                                                            | `INDICATOR_PROBE_TTL_MS = 5000`, `INDICATOR_PROBE_TIMEOUT_MS = 2000`, `fallback: undefined` around `broker.reachability()`; `undefined` → `{ status: 'up', reachable: 'unknown' }` at `:466-467`. Two equal 2 s bounds race; the outer one wins and caches `up` for 5 s — the V8-1 mechanism, re-cited against the working tree                                                                                                                                                      |
| `dataPlaneEvidenceMs` semantics (M99a)                | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:213-229,878-896`                                                       | bounds a POSITIVE outcome; a negative outcome is retained until a successful publish or a positive management probe contradicts it. §3.2 keeps both rules                                                                                                                                                                                                                                                                                                                            |
| Existing Service Bus outage gate                      | `packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts:63-80,89-126`                                           | constructs the BROKER directly and asserts `broker.reachability()`; no kernel app, no indicator, no `/health` — which is why two equal bounds racing was invisible                                                                                                                                                                                                                                                                                                                   |
| `DrizzleAdapter.#probeWithRawQuery`                   | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:336-342,367-374`                                                  | installed only when the instance has `execute()`; runs `rawQuery('SELECT 1')` through the pool; ANY rejection → `false`                                                                                                                                                                                                                                                                                                                                                              |
| `poolStats` seam                                      | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:208-212,239-241`                                                  | `[DATABASE_POOL_CAPACITY]?: () => DatabasePoolCapacity`, set from `DrizzleAdapterOptions.poolStats` (`interfaces/index.ts:789`); read by `readPoolCapacity(adapter)` (`health/database-capacity.ts:75-82`)                                                                                                                                                                                                                                                                           |
| `DatabasePoolCapacity`                                | `packages/database-plugin/src/interfaces/index.ts:686-693`                                                                          | `{ total, idle, waiting }` — "saturation is data before policy"                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DatabaseService.reachability()`                      | `packages/database-plugin/src/services/database-service.ts:310-339`                                                                 | tri-state: a probe REJECTION settles `undefined`, a `true` settles `true`, anything else `false`, bounded by `REACHABILITY_TIMEOUT_MS`. §3.3 relies on "rejection → `undefined`"                                                                                                                                                                                                                                                                                                     |
| `database` indicator mapping                          | `packages/database-plugin/src/plugin/database-plugin.ts:183-236`                                                                    | reads `readPoolCapacity(adapter)` into `data.capacity` (`:184-188`); `reachable === undefined` → `degraded`/`'unknown'` (`:232-234`); `false` → `down`                                                                                                                                                                                                                                                                                                                               |
| `/ready` fails on `degraded`                          | `packages/health-plugin/src/plugin/health-plugin.ts:297-316`                                                                        | `checkReady`: `report.status === 'up' ? 200 : 503`; `/health`: 503 only on `down`. No `health-plugin` change is needed for V8-3 — the mapping decision is the database indicator's                                                                                                                                                                                                                                                                                                   |
| pg pool-exhaustion anchor                             | `packages/database-plugin/src/errors/classify.ts:85-90,243-247`                                                                     | `PG_POOL_TIMEOUT_ANCHOR = 'timeout exceeded when trying to connect'` — the message node-postgres rejects with when `connectionTimeoutMillis` elapses; carries no `code`. `classifyDriverError` folds it into `'unavailable'` beside `ECONNREFUSED`, so a narrower predicate is needed to tell saturation from outage (§3.3)                                                                                                                                                          |
| `HashiCorpVaultProvider.get/set/isHealthy`            | `packages/secrets-plugin/src/providers/vault.ts:59,89-93,112-120,137-152`                                                           | `#http` defaults to `(url, init) => fetch(url, init)`; `get` and `set` pass no `signal`; `isHealthy` is bounded only by the plugin's `createCachedProbe` wrapper                                                                                                                                                                                                                                                                                                                     |
| `IVaultHttp`                                          | `packages/secrets-plugin/src/interfaces/index.ts:124`                                                                               | `(url: string, init?: RequestInit) => Promise<Response>` — `RequestInit.signal` already fits; no type change                                                                                                                                                                                                                                                                                                                                                                         |
| `createProvider('vault', …)`                          | `packages/secrets-plugin/src/plugin/secrets-plugin.ts:52-85,126`                                                                    | constructs the provider from `options.{address,token,mount,http}`; called with `ctx.runtime.env`, so `ctx.runtime` is in hand at the call site. Not barrel-exported (`src/index.ts:17-89`)                                                                                                                                                                                                                                                                                           |
| `ReadOnlySecretProviderError` (status-hint precedent) | `packages/secrets-plugin/src/errors.ts:46-67`                                                                                       | `withHttpStatusHint(this, { status, title, detail })` from `common`; `detail` is a fixed sentence, never driver text                                                                                                                                                                                                                                                                                                                                                                 |
| `withHttpStatusHint` / `HttpStatusHint`               | `packages/common/src/errors/status-hint.ts:89,141`                                                                                  | brands an `Error` with `{ status, title, detail }`; `errorHandler` serves it (M89b)                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cache Redis client construction                       | `packages/cache-plugin/src/stores/redis-store.ts:20-31,81-86`                                                                       | `createLazyRedisClient(RedisCtor, url)` → `new RedisCtor(url, { lazyConnect: true })`; no `commandTimeout`. `CacheStoreOptions` (`interfaces/index.ts:17-28`) has `url`/`client`/`prefix`/`defaultTtl`/`maxSize` — no timeout member                                                                                                                                                                                                                                                 |
| Cache collector counts a rejection as `failed`        | `packages/cache-plugin/src/diagnostics/cache-observations.ts:17,276-279`                                                            | "rejection is recorded as `failed` without the error ever being read" — so a timed-out command that REJECTS is already a recorded failure; the defect is only that it never rejects                                                                                                                                                                                                                                                                                                  |
| Queue Redis client construction                       | `packages/queue-plugin/src/adapters/redis-queue.ts:33-44`; `plugin/queue-plugin.ts:167-175`                                         | identical `createLazyRedisClient` shape; `RedisQueueOptions` (`interfaces/index.ts:405-416`) has `url`/`client`/`deadLetterTtlMs`; the plugin bag `QueuePluginOptions` (`:195-210`) carries `url`/`client` shared with RabbitMQ                                                                                                                                                                                                                                                      |
| Queue depth retention                                 | `packages/queue-plugin/src/diagnostics/queue-observation-collector.ts:426-432,780-791,636-655`                                      | a cycle writes only `fresh` rows (`:783-789`); rows a cycle did not refresh keep the `coverage` of the cycle that captured them and are re-emitted with a growing `ageMs` (`:640-651`) — the V8-23 mechanism. Row coverage is `QueueDepthCycleCoverage = 'complete' \| 'partial'` (`packages/common/src/services/diagnostics.ts:659`); SOURCE coverage is `QueueDepthCoverage` incl. `'unavailable'` (`:672`)                                                                        |
| Scheduler lock acquire sites                          | `packages/scheduler-plugin/src/services/scheduler-service.ts:259,420-423,487-493,608-626`                                           | three `await this.#lock.acquire(...)` sites — delay-slot claim at REGISTRATION, fire-slot claim and handler mutex in the fire path. A rejection is already caught and settled as `'lock-failed'` (`:493`, `:626`); a HUNG acquire blocks the re-arm that follows (`:627-640`), which is why "fires stop" (V8-24)                                                                                                                                                                     |
| `fireSettled(…, 'lock-failed')`                       | `packages/scheduler-plugin/src/diagnostics/scheduler-observations.ts:380-412`                                                       | bumps `record.lockFailed`; `SchedulerFireOutcome = 'dispatched' \| 'contended' \| 'lock-failed'` (`:201`)                                                                                                                                                                                                                                                                                                                                                                            |
| `IDistributedLock.acquire`                            | `packages/scheduler-plugin/src/interfaces/index.ts:25-33`                                                                           | `acquire(key, ttlMs): Promise<string \| null>` — a package-local port; the lock may be a caller's own implementation (`DistributedLockOptions.lock`, `:259-262`), so a client-native timeout cannot be the only bound                                                                                                                                                                                                                                                                |
| `RedisLock` client construction                       | `packages/scheduler-plugin/src/lock/redis-lock.ts:70-77,135-147`                                                                    | `new RedisCtor(url)` — eager connect, no `commandTimeout`; `acquire` is one `SET key token NX PX ttl`. `RedisLockOptions` (`interfaces/index.ts:381-395`) has `url`/`client`/`connectionErrorReporter`                                                                                                                                                                                                                                                                               |
| `resolveLock`                                         | `packages/scheduler-plugin/src/lock/distributed-lock.ts:40-67`                                                                      | injected `lock` > `storage: 'redis'` → `new RedisLock({ url, client?, connectionErrorReporter? })` > `MemoryLock`                                                                                                                                                                                                                                                                                                                                                                    |
| Scheduler health indicator                            | `packages/scheduler-plugin/src/services/scheduler-service.ts:129-139`                                                               | lifecycle only: `{ status: connected ? 'up' : 'down', data: { connected } }` — no lock reachability; see §9                                                                                                                                                                                                                                                                                                                                                                          |
| M98l `commandTimeoutMs` precedent                     | `packages/realtime-backplane-plugin/src/interfaces/index.ts:207-229,246-252`; `transports/redis-backplane.ts:10-17,108-124,188-190` | ioredis `commandTimeout`; default `DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000` ("above the roughly 10 s `ioredis` spends retrying a disconnected server"); `0` disables; `RangeError` outside `0`–`2147483647` (timer overflow); ignored for an injected client. This plan copies the constant and the validation per package — `cache-plugin`, `queue-plugin` and `scheduler-plugin` may not import `realtime-backplane-plugin` (§2.2), and the backplane's value is not in `common` |
| ioredis `commandTimeout`                              | `~/.cache/deno/npm/registry.npmjs.org/ioredis/5.11.1/built/redis/RedisOptions.d.ts:14`; `built/Command.js:195`                      | `commandTimeout?: number`; a command past it rejects with `new Error("Command timed out")`                                                                                                                                                                                                                                                                                                                                                                                           |
| Database outage-gate shape                            | `packages/database-plugin/test/integration/outage-real.test.ts:1-60`                                                                | real `createApplication` + `RuntimePlugin` + `HealthPlugin` + the plugin, `docker stop`/`start` via `docker ps --filter publish=<port>`, `ignore:` on the env var — the shape every outage test in this plan copies                                                                                                                                                                                                                                                                  |
| Live-Postgres guard precedent                         | `packages/database-plugin/test/integration/real-drizzle-adapter.test.ts:808-823,895`                                                | `POSTGRES_URL`, `ignore:` never an early return; already drives an exhausted pool                                                                                                                                                                                                                                                                                                                                                                                                    |
| CI backend inventory                                  | `.github/workflows/ci.yml:49-82,83-170,210-330`                                                                                     | env + services/steps: Redis 7, ElasticMQ, RabbitMQ 4, Mailpit, MongoDB 8, DynamoDB Local, Keycloak, Bigtable emulator, NATS, Kafka, MinIO. **No Postgres, no Vault, no Service Bus emulator, no Pub/Sub emulator.** `test/apps-gate.test.ts:348-366` records the Service Bus suite as deliberately local-only                                                                                                                                                                        |

**Measured, not inferred (from the run).** Health was already correctly bounded for V8-4, V8-5 and
V8-24 (`down` in ~2 s with `createCachedProbe`); only the CALL paths hung, and only under
`docker pause` — every outage suite in the repository uses `docker stop`, where ioredis and `fetch`
fail fast. The new outage tests therefore pause.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                     | Doc deliverable (same PR)                                                                                                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `service-bus-broker.ts:805-831` JSDoc says "the evidence is consulted FIRST" and that a negative outcome "answers directly"; the code at `:836-847` awaits the management probe before returning `false`                                 | The JSDoc describes the intended behaviour; the code is wrong. Change the code (§3.2), tighten the JSDoc to say the probe runs in the background to CLEAR a negative outcome | JSDoc block rewritten; messaging README "Health" (`README.md:599-611`) and `PUBLIC_API.md` messaging health note gain one sentence on background clearing                                             |
| C2 | `packages/database-plugin/README.md:770-775` and `PUBLIC_API.md` state the `reachable` table as "the whole decision": `'unknown'` → `degraded` → 503, with no saturation row                                                             | §3.3 adds a row: `'unknown'` with a saturated `capacity` snapshot → `up`/200. The table is extended, not contradicted                                                        | README table + prose gain the saturation row and the sentence that it needs `poolStats`; `PUBLIC_API.md` `DrizzleAdapterOptions.poolStats` note (`:1368`) says it now also drives this row            |
| C3 | `packages/queue-plugin/README.md:196-197` and `docs/diagnostics-protocol.md:379` promise depths are "`unavailable`, never zero" while a retained row answers `ready: 0`, `coverage: 'complete'` through an outage                        | The promise is right; the retention is wrong (§3.6)                                                                                                                          | `docs/diagnostics-protocol.md` queue section gains the rule "a row the latest cycle did not refresh is absent"; queue README depth paragraph (`:161-176`) likewise                                    |
| C4 | `scheduler-plugin/README.md:100-116` describes the lock as "only one replica executes each firing" with no statement of what a HUNG lock backend does; `scheduler-service.ts:478-480` JSDoc says a rejecting acquire is "skip-this-fire" | Extend the documented contract: a lock acquire past `acquireTimeoutMs` is a skipped fire counted as `lock-failed` (§3.7)                                                     | README "Distributed locking" gains the two new options and the bounded-acquire sentence; `PUBLIC_API.md` scheduler options rows                                                                       |
| C5 | `secrets-plugin/README.md:51-60` documents the Vault arm with no timeout and no failure class; `vault.ts:87` JSDoc says `@throws {Error} On a non-404 HTTP error` and nothing about a network failure                                    | Add the option and the error class (§3.4)                                                                                                                                    | README Vault section + options table gain `requestTimeoutMs` and `SecretProviderUnavailableError`; `PUBLIC_API.md` secrets section likewise; `vault.ts` JSDoc `@throws` rewritten                     |
| C6 | `CHANGELOG.md` `0.8.0` describes the M98l backplane `commandTimeoutMs` as closing "a connection that stays open while the server stops answering" for the backplane only; cache and queue carry the same hang with no entry              | Not a contradiction, a gap: new `Unreleased` entries name the three new `commandTimeoutMs` options and the behaviour change                                                  | `CHANGELOG.md` `Unreleased` → `Changed` (bounded commands, Vault error, drizzle mapping, depth rows, lock bound) and `Added` (`withDeadline`, the options); `docs/upgrading.md` `## Unreleased` entry |

## 3. Design decisions

### 3.1 Where the "every backend call is bounded" mechanism lives

- **Decision:** ONE rule, two implementation routes, chosen per call by whether the client owns a
  timeout. (a) A client with a native per-command timeout gets it: ioredis `commandTimeout`, set
  from a new `commandTimeoutMs` option on the cache store, the queue Redis arm and the scheduler
  Redis lock (the M98l precedent, same default `15_000`, same `0`-disables arm, same `RangeError`
  range check, same "ignored for an injected client" rule). (b) A call that is a bare promise with
  no client-side bound — the Vault `fetch` and `IDistributedLock.acquire` — goes through a new pure
  helper in `common`, `withDeadline(run, options)` in `packages/common/src/health/deadline.ts`:
  `run: (signal: AbortSignal) => Promise<T>`,
  `options: { timeoutMs, timing: ProbeTiming, onTimeout: () => Error }`. It arms `timing.setTimer`,
  races the call against the deadline (never trusting the signal alone — the `routes.ts:109-110`
  reasoning), aborts the controller and REJECTS with `onTimeout()` when the bound fires, clears the
  timer in `finally`, and refuses a non-finite, negative, or over-`2^31-1` `timeoutMs` with
  `RangeError` at call time. `timeoutMs: 0` means unbounded and arms nothing. It never swallows the
  call's own rejection.
- **Why:** `createCachedProbe` is the HEALTH-side helper — it caches, coalesces and resolves a
  fallback, which is exactly what a request-path call must not do (a swallowed timeout is V8-5's
  "parked calls later counted as succeeded"). A general bound has two in-repo consumers in two
  plugins that may not import each other, which is §11.1's condition for a `common` home; placing it
  beside `probe.ts` lets it share `ProbeTiming`, so a plugin passes
  `resolveProbeTiming(ctx.runtime)` to both. ioredis's own `commandTimeout` is preferred where it
  exists because it also stops the PARKED command from completing later — a `withDeadline` around a
  Redis call would reject the caller while the `SET NX` still landed on the server (which matters
  for §3.7's lock keys). `auth-plugin`'s private `attempt` is left alone: its contract maps every
  outcome to `null`, which is not a recorded failure; consolidating it is a later change with its
  own blast radius.
- **Test home:** `packages/common/test/unit/deadline.test.ts` (fake `ProbeTiming`: resolves before
  the bound → value; bound fires → rejects with the caller's error, signal aborted, timer cleared;
  call rejects → its own error, timer cleared; `0` arms no timer; `NaN`/negative/over-range →
  `RangeError`; a `run` that ignores the signal is still rejected at the bound).

### 3.2 V8-1 — a retained negative outcome answers at once

- **Decision:** `ServiceBusBroker.reachability()` returns `false` synchronously-fast when
  `#dataPlaneEvidence()` is `false`, and schedules the management probe in the BACKGROUND: the probe
  promise is started (not awaited) and its settlement, when `true`, clears `#evidence` so the NEXT
  read answers through the probe as before. At most one background clear is in flight at a time (the
  probe is already coalesced by `createCachedProbe`). A `false` or `undefined` probe outcome leaves
  the negative outcome in place. The positive-outcome ageing and the successful-publish clearing
  (M99a) are unchanged. The indicator's own `createCachedProbe` is untouched; its 5 s cache means a
  publish failure that lands INSIDE a cached `up` window is reported at the next poll after the TTL,
  which is stated in the README rather than hidden. The preference-ordered alternative in the
  ROADMAP (make the indicator's bound strictly larger) is NOT taken: it keeps a 2 s wait on every
  poll during an outage and leaves the race in place with a different winner.
- **Why:** the thing reported on is the data plane, and the data plane has already answered. Waiting
  for a management probe that cannot reach the namespace to confirm what a failed publish proved is
  the race V8-1 lost. Clearing in the background keeps M99a's recovery path for an
  idle-but-recovered deployment without putting it in front of the answer.
- **Test home:** `test/unit/service-bus-reachability.test.ts` (new cases: with a never-settling
  probe, `reachability()` after a recorded failure resolves `false` before any timer fires; a probe
  that later resolves `true` clears the outcome on the NEXT read, not the current one; `undefined`
  does not clear). `test/integration/service-bus-outage-real.test.ts` is REWRITTEN to drive a kernel
  application (`createApplication` + `RuntimePlugin` + `HealthPlugin` +
  `MessagingPlugin({ broker: 'service-bus', retryOptions: { maxRetries: 0 } })`): publish → `/ready`
  200; `docker stop` → one rejected publish → `/health` 503 with the messaging indicator `down`,
  `reachable: false`, and `/ready` 503 at samples +0 s, +3 s and +7 s (past the indicator's 5 s TTL,
  the window in which `0.8.0` answered `up`); restart → publish → `/ready` 200. **Local-only,
  guarded `ignore:` on `SERVICEBUS_CONNECTION_STRING`** — no Service Bus emulator in CI (`ci.yml`,
  `apps-gate.test.ts:348-366` pins the absence as deliberate). Negative control: with the background
  change reverted, the +3 s sample answers `/ready` 200 (verified against the emulator, where the
  management probe always resolves `undefined`).

### 3.3 V8-3 — pool saturation is data, not an outage

- **Decision:** two changes, one in the adapter and one in the indicator, both gated on information
  the application already supplies. In `DrizzleAdapter.#probeWithRawQuery`: (i) when `poolStats` is
  configured and the snapshot reports `idle === 0 && waiting > 0`, the probe does NOT queue a
  `SELECT 1` behind the saturated pool (a queued probe is one more waiter) and REJECTS with an
  internal `PoolSaturatedProbeSkipped` error; (ii) a probe rejection whose error matches the pg
  pool-exhaustion anchor — a new internal predicate `isPoolExhaustion(error)` in
  `errors/classify.ts`, reusing `PG_POOL_TIMEOUT_ANCHOR` — is RETHROWN rather than mapped to
  `false`. `DatabaseService.reachability()` already maps a rejection to `undefined`, so no change
  there. In the `database` indicator: `reachable === undefined` AND a `capacity` snapshot with
  `idle === 0 && waiting > 0` → `{ status: 'up', data: { …, reachable: 'unknown', capacity } }`;
  every other `undefined` keeps `degraded`. Without `poolStats`, a pool-timeout rejection now yields
  `undefined`/`degraded` (was `down`), and a hung probe stays `degraded` — both still fail `/ready`,
  which the README states plainly beside the instruction to configure `poolStats`. The "dedicated
  connection" alternative is not available: the adapter holds only the opaque
  `DrizzleDatabaseIdentity` and no driver handle.
- **Why:** M90b decided saturation is data before policy; a probe that queues behind the pool turns
  that data into a `503` and pulls every saturated replica — the cascading-failure shape. The
  `poolStats` seam is the only place the adapter can SEE saturation, so it is the gate; a `true`
  would claim the database answered when it did not, which is why the saturated answer is
  `'unknown'` with the capacity attached.
- **Test home:** `test/unit/drizzle-adapter-probe-saturation.test.ts` (fake instance whose `execute`
  blocks until released / rejects with the anchor; with saturated `poolStats` → rejection without
  calling `execute`; with idle capacity → `SELECT 1` runs; anchor rejection → rethrown; an
  `ECONNREFUSED` rejection → `false` unchanged). `test/integration/pool-saturation-health.test.ts` —
  a real Drizzle instance over the `pg-proxy` driver (the `real-drizzle-adapter.test.ts` precedent:
  the real SQL generator, a controllable transport, no server) whose callback blocks while a
  saturated `poolStats` is reported, through a kernel app: `/health` 200 with the `database`
  indicator `up`, `reachable: 'unknown'`, `capacity.waiting > 0`, `/ready` 200; the same app without
  `poolStats` → `degraded`/503 (the documented limit, pinned so it is a decision). A fourth cell in
  `real-drizzle-adapter.test.ts`'s live block (`POSTGRES_URL`, **local-only**: CI has no Postgres)
  saturates a real `max: 3` pool with holders and asserts `/ready` 200 through the plugin. Negative
  control: revert the indicator rule → the saturated cell answers 503 while the no-`poolStats` cell
  still passes, proving the rule and not the fixture decides.

### 3.4 V8-4 — the Vault read is bounded and its outage is `503`

- **Decision:** `HashiCorpVaultProviderOptions.requestTimeoutMs` (default `5000`; `0` disables;
  validated as in §3.1) and an internal `timing?: ProbeTiming` the plugin supplies from
  `resolveProbeTiming(ctx.runtime)` (direct construction without it falls back to the ambient
  `setTimeout`/`clearTimeout`, the `createCachedProbe` default for a caller with no runtime). `get`,
  `set` and the `isHealthy` request each run through `withDeadline`, passing the signal as
  `init.signal` to `#http`. A fetch that rejects (network failure, `TypeError: fetch failed`) or a
  bound that fires throws a new exported `SecretProviderUnavailableError(provider, cause)` branded
  `withHttpStatusHint({ status: 503, title: 'Service Unavailable', detail: 'The secrets provider is temporarily unreachable.' })`
  — `cause` carries the driver error for the log, the body never does (the M89b rule). HTTP statuses
  keep today's handling (`404` → `null`, other non-2xx → `Error`); `isHealthy` keeps its boolean
  contract (`false` on the new error). `createProvider` gains the `timing` parameter;
  `SecretsProviderOptions.requestTimeoutMs` carries the option through the plugin bag.
- **Why:** the finding is two defects — an unbounded read and a masked `500` — and one fix that
  leaves the other turns a 60 s hang into a 5 s masked `500`. M90f's `503` classification covers
  database drivers only (`classify.ts`), so the secrets outage needs its own class; the package's
  error vocabulary already has one M90f-shaped member to sit beside.
- **Test home:** `test/unit/vault.test.ts` (injected `http` that never settles → rejects with
  `SecretProviderUnavailableError` when the fake timer fires, `init.signal` aborted; `http` that
  rejects → same class with `cause`; `0` → no timer armed; 404/500 unchanged).
  `test/integration/
  secrets-integration.test.ts` gains a kernel-app case: a route reading a
  secret through `CAPABILITIES.SECRETS` with `cacheTtlSeconds: 0` and a hanging `http` answers `503`
  Problem Details within the bound. `test/integration/vault-outage-real.test.ts` — a real Vault dev
  container, **local-only** (no Vault in CI), guarded `ignore:` on `VAULT_ADDR` + `VAULT_TOKEN`:
  `docker pause` → the route answers `503` inside `requestTimeoutMs`, `/health` 503 with `secrets`
  `down`; unpause → `200`. Negative control: revert the deadline → the paused read is still pending
  when the test's own 3× budget elapses.

### 3.5 V8-5 — Redis commands in cache and queue reject instead of hanging

- **Decision:** `CacheStoreOptions.commandTimeoutMs` (read by `RedisStore` only) and
  `RedisQueueOptions.commandTimeoutMs` + `QueuePluginOptions.commandTimeoutMs` (the bag, forwarded
  by the plugin for the `'redis'` arm; ignored for `'rabbitmq'`, documented), both defaulting to a
  package-local `DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000`, `0` disables, `RangeError` outside
  `0`–`2147483647` at construction, applied as ioredis `commandTimeout` in each
  `createLazyRedisClient(RedisCtor, url, { commandTimeout })`, never to an injected client. The
  recorded failure needs no new code: a rejected `get` is already counted `failed` by the cache
  collector and a rejected `add` already rejects the caller; the tests pin both.
- **Why:** the two arms are byte-for-byte the backplane's defect
  (`grep commandTimeout
  packages/{cache,queue}-plugin/src` is empty) and the backplane's fix,
  default and reasoning transfer unchanged: a `docker stop` is already covered by
  `maxRetriesPerRequest` (~10 s), so a default above it bounds only the open-but-silent connection
  and keeps a short partition buffered. A shorter default was considered and rejected for the same
  reason M98l gave — it would reject commands a reconnect was about to deliver.
- **Test home:** `test/unit/redis-client-factory.test.ts` in both packages (the option reaches the
  constructor as `commandTimeout`; default; `0` omits it; range refusal; injected client untouched).
  `test/unit/cache-observations.test.ts` gains "a rejected call is `failed`" driven by a timeout
  rejection. New `packages/cache-plugin/test/integration/outage-real.test.ts` and an extension of
  `packages/queue-plugin/test/integration/outage-real.test.ts`, both through a kernel app with
  `HealthPlugin` and `diagnostics` enabled, `commandTimeoutMs: 1000`, `docker pause` on the Redis
  container found by `publish=6379`: a cache route rejects within 1 s and answers (the kernel 500 —
  status classification is §9), the cache source counts one `failed`, `/health` 503 with the cache
  indicator `down`; `queue.add` rejects within 1 s; unpause → both succeed. **In CI** — Redis is a
  `services:` container (`ci.yml:94-101`) and the M70c suites already stop it, so pausing it is
  within the established precedent; guarded `ignore:` on `REDIS_URL`. Negative control: revert the
  option → the paused `cache.get` is still pending at 5 s and the source shows no `failed`.

### 3.6 V8-23 — an unread depth row is absent, never a retained zero

- **Decision:** the collector's count cycle REPLACES the retained map with the cycle's `fresh` rows:
  a name the cycle did not read — timed out, failed, unreached because every slot was held — has no
  row in the next snapshot, while the source-level `failure` (`depth-read-timed-out` /
  `depth-read-failed`) and `depthCoverage: 'partial'` say why. `QueueDepthCycleCoverage` is NOT
  widened (no `common` change, no connector-validator change, no devtool change): a row's `coverage`
  keeps meaning "the cycle that produced this row". The alternative — a `'stale'` row coverage — was
  rejected because it widens a wire vocabulary three consumers validate for a signal the source
  already carries.
- **Why:** M98f's own rule for a depth that cannot be read is `unavailable`, never zero; a retained
  `ready: 0, coverage: 'complete'` with `ageMs` climbing to 29 s is a zero presented as current.
  Absence with a named source failure is the honest form of "unavailable" at row level.
- **Test home:** `test/unit/queue-observation-collector.test.ts` (a cycle whose reader times out for
  name B leaves only A's row and sets `failure: 'depth-read-timed-out'`; the next complete cycle
  restores B; a wholly failed cycle leaves no rows while `state` stays `ready`). The queue
  outage-real extension in §3.5 asserts `depths` is `[]` with `failure: 'depth-read-timed-out'`
  while paused. Negative control: revert to the merge-write → the paused snapshot still carries
  `ready: 0, coverage: 'complete'`.

### 3.7 V8-24 — a hung lock acquire is a counted `lock-failed`

- **Decision:** `DistributedLockOptions.acquireTimeoutMs` (default `5000`; `0` disables; validated
  as §3.1; must be below the job's interval, documented) wraps all three `#lock.acquire` sites in
  `SchedulerService` through `withDeadline` with `ProbeTiming` from the plugin's runtime; the
  deadline's rejection takes the EXISTING catch arm, so it is logged and settled `'lock-failed'` and
  the re-arm that follows the fire path runs — fires continue at the next slot instead of stopping.
  `IDistributedLock.acquire` takes no cancellation signal (it is a port an application may
  implement, so adding one is a contract change this letter does not make), so a deadline cannot
  stop the acquire — it only abandons it. An abandoned acquire that later RESOLVES to a token would
  hold the lock nobody will release: at the handler-mutex site every later fire is skipped as
  contended until the TTL expires, and at the two slot sites the fire it claimed runs nowhere. So
  each `withDeadline` site, when the bound fires, attaches a continuation to the abandoned promise
  that releases a late non-null token (`release(key, token)`, best-effort, a failure logged once and
  swallowed) and ignores a late `null` or rejection. That continuation is the correctness guarantee
  for EVERY lock implementation. `DistributedLockOptions.commandTimeoutMs` is additionally forwarded
  to `RedisLock` on the lazy path so the `SET NX` command promise is bounded on the client — a
  `SET NX` already sent to Redis can still apply, which the recovery below handles — and it must not
  outlast the call it bounds: when unset it DEFAULTS to the resolved `acquireTimeoutMs` (and to the
  M98l `15_000` only when `acquireTimeoutMs` is `0`), and a configured `commandTimeoutMs` greater
  than a non-zero `acquireTimeoutMs` is refused with a `RangeError` at construction naming both
  values. A client-side timeout rejects the command PROMISE; it does not recall a `SET NX` already
  written to the socket, which can still apply on the server after the rejection — and the
  scheduler's continuation ignores a rejection, because a rejection carries no token. So
  `RedisLock.acquire` owns that recovery: the token is minted client-side before the `SET`, so when
  the `SET` rejects, `acquire` issues the existing token-checked release `EVAL` for that exact key
  and token (best-effort, a failure swallowed), then rethrows the original error. The `EVAL` is
  written to the same connection after the `SET`, so Redis applies it after the `SET` if the `SET`
  applied at all: an applied `SET` is deleted, an unapplied one leaves nothing to match, and the
  token check means a lock another holder took in between is never touched. If the connection is
  dead for long enough that the `EVAL` also cannot run, the key is held no longer than the TTL it
  was set with — the bound that exists today. `MemoryLock` is unaffected (synchronous map). The
  scheduler health indicator is unchanged in this letter (§9).
- **Why:** the lock is a port a caller may implement, so the bound has to sit on the CALL, not on
  one backend; the Redis-side bound is the §3.1 reasoning about parked commands. Five seconds is
  below every realistic `every` interval and above the ~2 s a healthy Redis round trip never
  approaches; the option exists because a WAN lock may need more.
- **Test home:** `test/unit/scheduler-service.test.ts` (a lock whose `acquire` never settles: with
  fake timers the fire settles `'lock-failed'` when the bound fires, the logger receives one line,
  and the next slot is armed; `0` waits; the delay-slot claim at registration is bounded too; an
  `acquire` that resolves to a token AFTER the bound is released with that exact key and token, at
  each of the three sites, and the next fire's mutex acquire is not contended; a late `null` and a
  late rejection call no `release`). `test/unit/redis-lock.test.ts` + `distributed-lock.test.ts`
  (the option reaches the constructor; unset, it defaults to `acquireTimeoutMs`; `commandTimeoutMs`
  above a non-zero `acquireTimeoutMs` throws `RangeError`; injected client untouched; a fake client
  whose `set` records the write as applied and then rejects with ioredis's `Command timed out`:
  `acquire` rejects with that error, `eval` was called once with the same key and the token passed
  to `set`, and the fake's key is gone — not held until its TTL; an `eval` that also rejects does
  not replace the original rejection). New
  `packages/scheduler-plugin/test/integration/outage-real.test.ts` through a kernel app with
  `diagnostics`, an `every` job on a 1 s grid,
  `distributedLock: { enabled: true, storage: 'redis', acquireTimeoutMs: 500 }` (strictly below the
  interval, the documented configuration; `commandTimeoutMs` takes its derived `500`),
  `docker pause` on Redis: within 3 s the scheduler source's `lockFailed` increments and keeps
  incrementing; unpause → `dispatched` resumes. **In CI** (Redis), guarded `ignore:` on `REDIS_URL`.
  Negative control: revert the deadline → `count` freezes and `lockFailed` stays `0` for the whole
  paused window. Remove the late-token release → the unit case's next fire reports `'contended'`
  against its own abandoned token. Remove the release-on-rejection in `RedisLock.acquire` → the
  timed-out-but-applied case finds the key still held with the abandoned token.

### 3.8 One outage test per package, through the endpoints

- **Decision:** every real-backend test in this letter boots `createApplication` with
  `RuntimePlugin`, `HealthPlugin` and the plugin under test, and asserts through `app.fetch` on
  `/health` and `/ready` (plus the diagnostics source where the row is about one), never through a
  broker or adapter method. Guards are `ignore:` on the env var, never an early return. Each file
  states whether CI runs it.
- **Why:** V8-1 shipped because the outage test asserted `reachability()` directly and the race
  lived one layer up. The M70c trap is the other half: an early return reports a pass that exercised
  nothing.
- **Test home:** the five files named in §3.2–§3.7; `test/apps-gate.test.ts` gains the pins that the
  three CI-run files' env vars and service remain wired, and records the two local-only files
  (Service Bus, Vault) and the Postgres cell as deliberate.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                             | Kind     | Consumer / real code path that READS it                                                                                        |
| ------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `withDeadline` (`common`)                                                                   | function | `secrets-plugin/src/providers/vault.ts` (three fetches), `scheduler-plugin/src/services/scheduler-service.ts` (three acquires) |
| `DeadlineOptions` (`common`)                                                                | type     | the two callers above type their options with it                                                                               |
| `SecretProviderUnavailableError` (`secrets`)                                                | class    | thrown by `vault.ts`; read by `errorHandler` through its status hint; `instanceof` for a caller's retry policy                 |
| `CacheStoreOptions.commandTimeoutMs`                                                        | option   | `redis-store.ts` → `createLazyRedisClient`                                                                                     |
| `QueuePluginOptions.commandTimeoutMs`, `RedisQueueOptions.commandTimeoutMs`                 | option   | `queue-plugin.ts:167` → `redis-queue.ts` → `createLazyRedisClient`                                                             |
| `DistributedLockOptions.acquireTimeoutMs`                                                   | option   | `scheduler-plugin.ts` → `SchedulerService` constructor → the three `withDeadline` sites                                        |
| `DistributedLockOptions.commandTimeoutMs`, `RedisLockOptions.commandTimeoutMs`              | option   | `resolveLock` → `RedisLock.connect` → `new RedisCtor(url, { commandTimeout })`                                                 |
| `HashiCorpVaultProviderOptions.requestTimeoutMs`, `SecretsProviderOptions.requestTimeoutMs` | option   | `createProvider` → `HashiCorpVaultProvider` → `withDeadline`                                                                   |

No other barrel changes. `src/index.ts` of `messaging-plugin`, `database-plugin`, `cache-plugin`,
`queue-plugin` and `scheduler-plugin` is unchanged except for the type exports listed; each
package's existing `barrel-exports.test.ts` is extended (cache has none and gains one — the M56
class). `PoolSaturatedProbeSkipped` and `isPoolExhaustion` stay internal (pinned by the database
barrel test).

### 4.1 Options — every option names its consumer

| Option                                                        | Consumer                                      | Behavior (per implementation)                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commandTimeoutMs` (cache store, queue Redis arm, Redis lock) | `createLazyRedisClient` / `RedisLock.connect` | lazy path: ioredis `commandTimeout`; `0` omits it; injected client: ignored and documented; out of range: `RangeError` at construction; Redis lock: unset → the resolved `acquireTimeoutMs`, above it → `RangeError` |
| `acquireTimeoutMs` (scheduler)                                | `SchedulerService` acquire sites              | `withDeadline` around every acquire; expiry → the catch arm → `lock-failed`, and a late token is released; `0` unbounded                                                                                             |
| `requestTimeoutMs` (Vault)                                    | `HashiCorpVaultProvider`                      | `withDeadline` + `init.signal` on every fetch; expiry/network failure → `SecretProviderUnavailableError` (503); `0` unbounded                                                                                        |
| `poolStats` (existing)                                        | `#probeWithRawQuery`, `database` indicator    | NEW reader: skips the queued probe when saturated; the indicator maps `'unknown'` + saturated capacity to `up`                                                                                                       |
| `dataPlaneEvidenceMs` (existing)                              | `ServiceBusBroker`                            | unchanged meaning; the negative outcome it retains is now answered without awaiting the probe                                                                                                                        |

## 5. Implementation files

| File                                                                                                 | Purpose                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/health/deadline.ts`                                                             | `withDeadline`, `DeadlineOptions` (§3.1)                                                                     |
| `packages/common/src/index.ts`                                                                       | exports the two symbols                                                                                      |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`                                        | background clearing of a negative outcome (§3.2); JSDoc (C1)                                                 |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                   | saturation-aware probe (§3.3)                                                                                |
| `packages/database-plugin/src/errors/classify.ts`                                                    | `isPoolExhaustion` (internal)                                                                                |
| `packages/database-plugin/src/plugin/database-plugin.ts`                                             | saturated-`'unknown'` → `up` mapping (§3.3)                                                                  |
| `packages/secrets-plugin/src/errors.ts`                                                              | `SecretProviderUnavailableError` (§3.4)                                                                      |
| `packages/secrets-plugin/src/providers/vault.ts`                                                     | bounded fetches, `requestTimeoutMs`, `timing` (§3.4)                                                         |
| `packages/secrets-plugin/src/interfaces/index.ts`                                                    | `SecretsProviderOptions.requestTimeoutMs`                                                                    |
| `packages/secrets-plugin/src/plugin/secrets-plugin.ts`                                               | `createProvider` passes `resolveProbeTiming(ctx.runtime)` and the option                                     |
| `packages/secrets-plugin/src/index.ts`                                                               | exports the error class                                                                                      |
| `packages/cache-plugin/src/interfaces/index.ts`, `stores/redis-store.ts`, `plugin/cache-plugin.ts`   | `commandTimeoutMs` (§3.5)                                                                                    |
| `packages/queue-plugin/src/interfaces/index.ts`, `adapters/redis-queue.ts`, `plugin/queue-plugin.ts` | `commandTimeoutMs` (§3.5)                                                                                    |
| `packages/queue-plugin/src/diagnostics/queue-observation-collector.ts`                               | replace-not-merge depth retention (§3.6)                                                                     |
| `packages/scheduler-plugin/src/interfaces/index.ts`                                                  | `acquireTimeoutMs`, `commandTimeoutMs` on `DistributedLockOptions`; `commandTimeoutMs` on `RedisLockOptions` |
| `packages/scheduler-plugin/src/services/scheduler-service.ts`                                        | `withDeadline` around the three acquires (§3.7)                                                              |
| `packages/scheduler-plugin/src/lock/redis-lock.ts`, `lock/distributed-lock.ts`                       | forward `commandTimeout` on the lazy path                                                                    |
| `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`                                           | threads `acquireTimeoutMs` + timing into the service                                                         |

`health-plugin` has NO `src` change: `/ready` failing on `degraded` is by design and the V8-3
decision belongs to the database indicator. The ROADMAP's package list for this letter names it; see
§8.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                     | src covered                                                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/deadline.test.ts`                                                  | `health/deadline.ts`                                                    | the §3.1 cases against `withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, options: DeadlineOptions): Promise<T>`; timer handle cleared on every path; `RangeError` table as data                              |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                   | `index.ts`                                                              | the two new names are exported; nothing else moved                                                                                                                                                                    |
| `packages/messaging-plugin/test/unit/service-bus-reachability.test.ts` (extend)               | `brokers/service-bus-broker.ts`                                         | §3.2 unit cases; the existing M99a retention/ageing/refusal cases unchanged                                                                                                                                           |
| `packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts` (rewrite)        | `brokers/service-bus-broker.ts`, `plugin/messaging-plugin.ts`           | kernel app, `/health`+`/ready` at +0/+3/+7 s stopped → 503 and `down`; restart → 200. **Local-only**, `ignore:` on `SERVICEBUS_CONNECTION_STRING`                                                                     |
| `packages/database-plugin/test/unit/drizzle-adapter-probe-saturation.test.ts`                 | `adapters/drizzle/drizzle-adapter.ts`, `errors/classify.ts`             | §3.3 adapter cases; `isPoolExhaustion` table (anchor message → `true`; `ECONNREFUSED`, SQLSTATE `08`, a plain `Error` → `false`)                                                                                      |
| `packages/database-plugin/test/unit/plugin.test.ts` (extend)                                  | `plugin/database-plugin.ts`                                             | indicator mapping table: `undefined` + saturated capacity → `up`; `undefined` + idle capacity → `degraded`; `undefined` + no capacity → `degraded`; `false` + saturated → `down` (a refused probe is still a refusal) |
| `packages/database-plugin/test/integration/pool-saturation-health.test.ts`                    | `plugin/database-plugin.ts`, `adapters/drizzle/drizzle-adapter.ts`      | real Drizzle over `pg-proxy` with a blocking callback; both cells of §3.3 through `/health` and `/ready`                                                                                                              |
| `packages/database-plugin/test/integration/real-drizzle-adapter.test.ts` (extend)             | same                                                                    | live Postgres saturation cell → `/ready` 200. **Local-only**, `ignore:` on `POSTGRES_URL`                                                                                                                             |
| `packages/database-plugin/test/unit/barrel-exports.test.ts` (extend)                          | `index.ts`                                                              | `isPoolExhaustion`/`PoolSaturatedProbeSkipped` NOT exported                                                                                                                                                           |
| `packages/secrets-plugin/test/unit/vault.test.ts` (extend)                                    | `providers/vault.ts`, `errors.ts`                                       | §3.4 cases against `new HashiCorpVaultProvider({ address, token, http, requestTimeoutMs, timing })`; the status hint read back with `httpStatusHintOf` is `{ status: 503 }` and its `detail` contains no driver text  |
| `packages/secrets-plugin/test/unit/secrets-plugin.test.ts` (extend)                           | `plugin/secrets-plugin.ts`, `interfaces/index.ts`                       | the vault arm forwards `requestTimeoutMs` and a runtime-bound timing                                                                                                                                                  |
| `packages/secrets-plugin/test/integration/secrets-integration.test.ts` (extend)               | all secrets `src` touched                                               | kernel app: hung `http` → route `503` Problem Details within the bound; `detail` fixed sentence; `message` absent (the M56 field-by-field rule)                                                                       |
| `packages/secrets-plugin/test/integration/vault-outage-real.test.ts`                          | `providers/vault.ts`                                                    | real Vault, `docker pause`/`unpause`, through `/health` and the route. **Local-only**, `ignore:` on `VAULT_ADDR`+`VAULT_TOKEN`                                                                                        |
| `packages/secrets-plugin/test/unit/barrel-exports.test.ts` (extend)                           | `index.ts`                                                              | the error class is exported                                                                                                                                                                                           |
| `packages/cache-plugin/test/unit/redis-client-factory.test.ts` (extend)                       | `stores/redis-store.ts`                                                 | `createLazyRedisClient(RedisCtor, url, { commandTimeout? })` receives the option; default/zero/range/injected cases                                                                                                   |
| `packages/cache-plugin/test/unit/cache-plugin.test.ts` (extend)                               | `plugin/cache-plugin.ts`, `interfaces/index.ts`                         | `CachePlugin({ store: 'redis', options: { commandTimeoutMs } })` reaches the store                                                                                                                                    |
| `packages/cache-plugin/test/unit/cache-observations.test.ts` (extend)                         | `diagnostics/cache-observations.ts`                                     | a timeout rejection counts `failed`                                                                                                                                                                                   |
| `packages/cache-plugin/test/unit/barrel-exports.test.ts` (new)                                | `index.ts`                                                              | the published surface is unchanged (M56 class)                                                                                                                                                                        |
| `packages/cache-plugin/test/integration/outage-real.test.ts` (new)                            | `stores/redis-store.ts`, `plugin/cache-plugin.ts`                       | §3.5 pause cell through `/health` and a cache route + source. **CI**, `ignore:` on `REDIS_URL`                                                                                                                        |
| `packages/queue-plugin/test/unit/redis-client-factory.test.ts` (extend)                       | `adapters/redis-queue.ts`                                               | as cache                                                                                                                                                                                                              |
| `packages/queue-plugin/test/unit/queue-plugin.test.ts` (extend)                               | `plugin/queue-plugin.ts`, `interfaces/index.ts`                         | the bag option reaches the Redis arm; the RabbitMQ arm ignores it                                                                                                                                                     |
| `packages/queue-plugin/test/unit/queue-observation-collector.test.ts` (extend)                | `diagnostics/queue-observation-collector.ts`                            | §3.6 cases                                                                                                                                                                                                            |
| `packages/queue-plugin/test/integration/outage-real.test.ts` (extend)                         | `adapters/redis-queue.ts`, `diagnostics/queue-observation-collector.ts` | pause cell: `add` rejects within the bound; `depths: []` + `failure: 'depth-read-timed-out'`; recovery. **CI**, `ignore:` on `REDIS_URL`                                                                              |
| `packages/scheduler-plugin/test/unit/scheduler-service.test.ts` (extend)                      | `services/scheduler-service.ts`                                         | §3.7 fake-timer cases at all three acquire sites                                                                                                                                                                      |
| `packages/scheduler-plugin/test/unit/redis-lock.test.ts`, `distributed-lock.test.ts` (extend) | `lock/redis-lock.ts`, `lock/distributed-lock.ts`, `interfaces/index.ts` | `commandTimeout` reaches `new RedisCtor(url, …)` on the lazy path only; range refusal                                                                                                                                 |
| `packages/scheduler-plugin/test/unit/scheduler-plugin.test.ts` (extend)                       | `plugin/scheduler-plugin.ts`                                            | `acquireTimeoutMs` threads to the service with the runtime's timing                                                                                                                                                   |
| `packages/scheduler-plugin/test/integration/outage-real.test.ts` (new)                        | `services/scheduler-service.ts`, `lock/redis-lock.ts`                   | §3.7 pause cell through the scheduler source and `/health`. **CI**, `ignore:` on `REDIS_URL`                                                                                                                          |
| `test/apps-gate.test.ts` (extend)                                                             | —                                                                       | pins the three CI-run outage files' guard variables and the Redis service; records the Service Bus, Vault and Postgres cells as local-only                                                                            |

Per-file numbers are read from the ANSI-stripped table of `deno task test:coverage:pkg` on `main`
before the first edit and again after each change; a touched file that regresses is fixed before
hand-off, and the new files land at 100%.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101a-bounded-health, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # the README/PUBLIC_API/protocol edits of §2
deno task publish:check     # on the committed tree
deno task release:verify 0.8.0
```

Plus the negative controls, each observed failing and reverted: §3.2 (the +3 s sample), §3.3 (the
saturated cell), §3.4 (the pending read), §3.5 (the pending `get` and the absent `failed`), §3.6
(the retained zero), §3.7 (the frozen `count`). The real-backend ones are run against the live
container, with Redis both running and paused, so each suite is known to discriminate rather than
pass vacuously.

## 8. Risks & mitigations

- **Sequence.** M101b shares `messaging-plugin` and rebases on this branch; §3.2 touches only
  `service-bus-broker.ts` and the outage test, so the rebase is additive for the Pub/Sub, NATS and
  Kafka files.
- **ROADMAP package list.** It names `health-plugin`; no `health-plugin` `src` changes (§5).
  Reported rather than edited here.
- **`docker pause` on a shared CI service.** Other suites in the same job share the Redis container;
  the existing `docker stop` suites set the precedent, but a paused Redis during a parallel suite's
  run would read as that suite's flake → each pause cell unpauses in `finally`, keeps the paused
  window under 5 s, and the apps-gate pin documents the shared container.
- **The 15 s default is long for a request path.** It is M98l's measured trade-off (below it, a
  reconnecting server's buffered commands are rejected) → documented per option with the tuning
  advice; the request-path status (`503` versus the kernel `500`) is a separate decision (§9).
- **A background probe outliving the broker.** §3.2's unawaited probe could settle after
  `disconnect()` → the clear checks `#probe !== null` and `#evidence` identity before writing, and
  `disconnect()` already nulls both (`service-bus-broker.ts:794-800`).
- **`poolStats` is application-owned and optional.** Without it V8-3's saturated pool still fails
  `/ready` (as `degraded`) → stated in three doc sites with the configuration, and the
  no-`poolStats` cell is a test so the limit is a decision rather than a surprise.
- **Vault's `isHealthy` already bounded by the plugin wrapper.** Adding `withDeadline` inside it
  double-bounds → the inner bound is the SAME `requestTimeoutMs`, so a direct construction without
  the plugin is bounded too; the outer `createCachedProbe` keeps its 2 s.
- **Breaking behaviour.** Six behaviour changes (bounded commands reject, Vault outage class and
  `503`, drizzle mapping, depth rows, lock bound, immediate `false`) → each a CHANGELOG `Changed`
  entry; `docs/upgrading.md` `## Unreleased` names the two a reader must act on (a test asserting a
  Vault `500`; a dashboard reading a depth row's absence).

## 9. Out of scope

- A reachability member on `IDistributedLock` and a `scheduler` indicator that reports the lock
  backend — a port widening for a later row; V8-24's named fix is the bound and the count.
- `503` classification of a timed-out cache or queue command on the request path (the M90f class for
  `database-plugin`); the row names the hang, and a bounded rejection is what makes a later
  classification possible.
- SDK-side timeouts for `AwsKmsProvider`, `GcpSecretManagerProvider`, `AzureKeyVaultProvider` — each
  SDK carries its own retry/timeout configuration and none was measured hanging.
- A `started` counter on the cache diagnostics source (the V8-5 note's "optional") — a `common` DTO
  widening with devtool consequences, owned by whichever letter next widens that DTO.
- Consolidating `auth-plugin`'s private `attempt` onto `withDeadline` (different contract, §3.1).
- Every transport-level broker defect: M101b.

## 10. Corrections recorded during implementation

Each is a place the shipped code or tests differ from the text above; the text is left as written.

- **§3.1 `withDeadline` timing is optional.** `DeadlineOptions.timing?` defaults to the ambient
  `setTimeout`/`clearTimeout`, the `createCachedProbe` default, so a caller with no runtime to hand
  can use it; every plugin call site still passes `resolveProbeTiming(ctx.runtime)`.
- **§3.1 / §4 `deadlineRangeError` is exported** from `common` beside `withDeadline`, so an option
  holder refuses a bad bound at construction with the same rule and message the call applies.
- **§3.2 / §8 the background clear checks probe identity only.** It clears `#evidence` when the
  probe answers `true` and is still the current one. Every newly recorded failure rebuilds the probe
  and `disconnect()` drops it, so the identity check alone stops a late `true` erasing a newer
  failure; the separate `#evidence` identity check was dropped as redundant.
- **§3.4 the secrets option is `cacheTtl`**, not `cacheTtlSeconds`. The `503` status test lives in a
  new `test/integration/vault-unavailable-status.test.ts` rather than an extension of
  `secrets-plugin.test.ts`, and `requestTimeoutMs` is validated in the provider constructor, which
  runs inside `register()`.
- **§3.5 validation moved to the factory.** `CachePlugin(...)` and `QueuePlugin(...)` refuse an
  out-of-range `commandTimeoutMs` for the Redis arm when called, not at construction of the store;
  `cache-plugin` threads the option through its existing store-options builder.
- **§3.5 / §3.6 the queue outage assertions** were written against what the real paused Redis
  produces, recorded in the test rather than the plan's exact `failure` string.
- **§3.7 test home.** The fake-timer cases live in a new `test/unit/scheduler-lock-bound.test.ts`,
  not an extension of `scheduler-service.test.ts`. The `RangeError` for a `commandTimeoutMs` above
  `acquireTimeoutMs` names both values. The real-backend file adds a second case driving `RedisLock`
  directly, proving a timed-out `SET` leaves no key held after unpause, and the kernel case asserts
  "dispatched resumes" as handler runs resuming rather than a counter.
- **A flake fixed in passing.** `scheduler-observations.test.ts`'s hostile-then case waited a fixed
  150 ms and failed under coverage load; it now polls until the expected runs have happened.
- **`DOC_LINT_BASELINE` under `RUST_BACKTRACE=1`.** With that variable set, `deno doc --lint` prints
  a stack backtrace that `generate-api-docs.ts` classifies as a fatal child error; the count itself
  is at the 496 baseline. Not changed here.
