# Milestone 139f — Health and failure signals that mislead the operator (`service-discovery-plugin` + `database-plugin` + `realtime-backplane-plugin` + `queue-plugin` + `scheduler-plugin` docs)

> **Status:** Complete. Branch: `feat/m139f-health-signals`. `develop` and `main` are protected, so
> all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

Six rows from the `0.12.0` regression run (`smoke/V0120-REGRESSION.md`). Each one passed its earlier
fix's own check and still tells the operator the wrong thing: a readiness failure with no log line,
a busy pool read as trouble, a delivery promise the transport breaks, an outage logged at the wrong
level with no recovery, a dropped connection logged as a timeout, and alerting advice for a field
the default `/health` body omits.

- **X10-3:** a Kubernetes provider failing only its readiness probe logs nothing, and a cold resolve
  says "could not resolve … nothing cached" without the cause.
- **V8-3:** with `connectionTimeoutMillis` under the 2-second probe bound, a saturated pg pool shows
  `waiting = 0`, so `isSaturated` never fires and `/ready` answers 503 while Postgres is up.
- **X3-3:** a short Redis partition is documented as "delivered late", but the reconnect race drops
  every frame in 3 of 8 runs while publish resolves without error.
- **X88-9:** the queue's outage line is logged at `error` and recovery is silent.
- **V12-50:** a connection dropped under a statement is logged as "did not answer within the driver
  call bound", though no bound fired.
- **V12-49:** READMEs say to alert on `data.<field>` without naming
  `HealthPlugin({ details: true })`.

- **In scope:** the six rows, their README and `PUBLIC_API.md` text, CHANGELOG entries, tests.
- **NOT this milestone:** the Kubernetes watch loop's silent `catch` (§9); MySQL/MariaDB pool
  saturation (§9); the rest of the documentation batch (M139e).

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KubernetesProvider.isHealthy`  | `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts:210-227`                        | `limit=1` LIST, 2 s abort; `catch { return false }` discards every cause; a non-2xx returns `response.ok`                                                                                                                                                                                     |
| `KubernetesProvider.resolve`    | `kubernetes-provider.ts:192-202`                                                                        | a fetch rejection propagates raw; non-2xx throws `Error('Kubernetes EndpointSlice list … failed with HTTP <status>')`                                                                                                                                                                         |
| `DiscoveryProvider.isHealthy?`  | `packages/service-discovery-plugin/src/interfaces/index.ts:60-73`                                       | `Promise<boolean>`, `@since 0.2.0`; doc says nothing about rejection                                                                                                                                                                                                                          |
| Service probe wrapper           | `packages/service-discovery-plugin/src/services/service-discovery-service.ts:73-84`                     | `createCachedProbe({ probe: try { isHealthy?.() ?? true } catch { false }, ttlMs: 5000, timeoutMs: 2000 })`; keeps no reason, no logger                                                                                                                                                       |
| Cold-resolve message            | `service-discovery-service.ts:240-250`                                                                  | `DiscoveryUnavailableError("Service discovery could not resolve '<name>' and has nothing cached", { cause })` with a fixed 503 public detail                                                                                                                                                  |
| `ServiceDiscoveryService` ctor  | `service-discovery-service.ts:62-66`; built at `src/plugin/service-discovery-plugin.ts:76`              | `(provider, runtime, options)`; not exported from the barrel                                                                                                                                                                                                                                  |
| Plugin logger                   | `service-discovery-plugin.ts:64,128-141`                                                                | `optionalDependencies: ['logger']`; uses `ctx.logger?.warn`                                                                                                                                                                                                                                   |
| `createConnectionErrorReporter` | `packages/common/src/health/connection-errors.ts:42-175`; barrel `packages/common/src/index.ts:102-111` | `{ source, logger: () => logger \| undefined }` → `{ report(error), recovered() }`; first distinct error `warn`, repeats `debug` with a count, `recovered()` logs `info` "connection recovered after N error(s)" only after an error; never throws; `@since 0.8.0`                            |
| `describeError`                 | `packages/common/src/errors/describe-error.ts:51`; barrel `index.ts:40`                                 | one line, ≤ 8192 code points, URL userinfo masked, controls normalised; `@since 0.11.0`                                                                                                                                                                                                       |
| `isSaturated`                   | `packages/database-plugin/src/health/database-capacity.ts:103-105`                                      | `idle === 0 && waiting > 0`; internal                                                                                                                                                                                                                                                         |
| `PoolSaturatedProbeSkipped`     | `database-capacity.ts:112-118`                                                                          | internal rejection; any probe rejection maps to `undefined`                                                                                                                                                                                                                                   |
| Drizzle probe                   | `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:428-442`                              | skips when `isSaturated`; `SELECT 1`; `isUnansweredConnect(error)` → rethrow, else `false`                                                                                                                                                                                                    |
| `DatabaseService.reachability`  | `packages/database-plugin/src/services/database-service.ts:437-467`                                     | 2 s bound (`REACHABILITY_TIMEOUT_MS`, line 52); rejection or bound → `undefined`                                                                                                                                                                                                              |
| Indicator saturation branch     | `packages/database-plugin/src/plugin/database-plugin.ts:271-298`                                        | on `undefined`: `up` + `reachable: 'unknown'` when `isSaturated(current)` and progress observed or unobservable; else `degraded` (fails `/ready`)                                                                                                                                             |
| pg-pool acquire timeout         | `node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:200-231`                     | `'timeout exceeded when trying to connect'` is raised ONLY on the full-or-idle checkout branch, and the timer removes the waiter from `_pendingQueue` first (so `waitingCount` drops); a new-connection timeout raises `'Connection terminated due to connection timeout'` (line 276) instead |
| pg anchors                      | `packages/database-plugin/src/errors/classify.ts:107-111,158,383-404`                                   | `PG_POOL_TIMEOUT_ANCHOR`, `PG_NEW_CONNECTION_TIMEOUT_ANCHOR` → `'unavailable'`; `PG_TERMINATED_ANCHOR` → `'timeout'`; `PG_QUERY_TIMEOUT_ANCHOR` → `'timeout'`; text anchors authoritative only on a chain without string codes                                                                |
| MySQL/MariaDB loss              | `classify.ts:135,146,492-499`                                                                           | `PROTOCOL_CONNECTION_LOST` and MariaDB `45009` → `'timeout'`                                                                                                                                                                                                                                  |
| Timeout message                 | `database-service.ts:93-120`                                                                            | every `'timeout'` becomes `DatabaseTimeoutError('The database did not answer within the driver call bound.', { cause })`                                                                                                                                                                      |
| `DatabaseTimeoutError`          | `packages/database-plugin/src/errors.ts:621-639`; barrel `src/index.ts:113`                             | `(message, { cause? })`; 504 hint, public detail "The database did not answer in time."; `@since 0.10.0`                                                                                                                                                                                      |
| Backplane clients               | `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts:226-246`                          | owned pair from `module.create(url, { commandTimeout? })`; `enableOfflineQueue`/`maxRetriesPerRequest` never set                                                                                                                                                                              |
| Backplane open                  | `redis-backplane.ts:254-288`                                                                            | awaits `subscriber.subscribe(topic)` only; nothing waits for the publisher                                                                                                                                                                                                                    |
| Backplane publish               | `redis-backplane.ts:384-401`                                                                            | reply discarded; a rejection goes through `toBackendFault`                                                                                                                                                                                                                                    |
| `IRedisModule.create`           | `packages/realtime-backplane-plugin/src/interfaces/index.ts:101-114`                                    | `create(url, options?: { readonly commandTimeout?: number })`; exported                                                                                                                                                                                                                       |
| `IRedisBackplaneClient`         | `interfaces/index.ts:23-60+`                                                                            | `publish`, `subscribe`, `unsubscribe`, `on`, `off`, `quit`, optional `ping`/`status`                                                                                                                                                                                                          |
| Offline-queue refusal class     | `packages/common/src/errors/backend-fault.ts:229`                                                       | "Stream isn't writeable and enableOfflineQueue options is false" → `'unavailable'`                                                                                                                                                                                                            |
| `resolveLogger`                 | `packages/queue-plugin/src/plugin/queue-plugin.ts:501-507`                                              | returns `{ error }` only                                                                                                                                                                                                                                                                      |
| `QueueLogger`                   | `packages/queue-plugin/src/services/queue-service.ts:49-56`; barrel `src/index.ts:34`                   | `error` plus optional `warn?`/`info?`                                                                                                                                                                                                                                                         |
| Loop state change               | `queue-service.ts:181-218`                                                                              | `#loopFailed` uses `logger.warn ?? logger.error`; `#loopRecovered` returns early without `info`                                                                                                                                                                                               |
| `HealthPlugin({ details })`     | `packages/health-plugin/src/interfaces/index.ts:169-175`; `src/plugin/health-plugin.ts:315-323`         | default `false`; the body then keeps only each check's `status`                                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                                                           | Resolution (picked side)                                                                                          | Doc deliverable (same PR)                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The backplane README (lines 154-166) and `PUBLIC_API.md` (5130-5139) promise a short partition is "buffered and delivered LATE, not dropped"; the 0.12.0 run dropped every frame in 3 of 8 short partitions                                                                                                                        | §3.3 makes the code drop deterministically; the docs say frames published while disconnected are lost, never late | Backplane README "Limitations"; the `commandTimeoutMs` JSDoc (`interfaces/index.ts:229-233`); `PUBLIC_API.md` backplane section                                   |
| C2  | `DriverErrorClass` JSDoc (`classify.ts:46`) says `'timeout'` means "the driver call bound elapsed"; the classifier also returns it for a connection lost mid-statement                                                                                                                                                             | Code stays; the JSDoc names both                                                                                  | `classify.ts` JSDoc (internal) and the database README's 504 paragraph (1415-1418, 1486-1494)                                                                     |
| C3  | Database README 1541-1543 says a pool connection timeout reports `degraded`                                                                                                                                                                                                                                                        | §3.2 reports a pg acquire timeout with progressing queries as `up` (`reachable: 'unknown'`)                       | Database README saturation paragraph                                                                                                                              |
| C5  | `docs/health-indicators.md` pins `database-plugin.ts:306`, `service-discovery-plugin.ts:122`, `queue-plugin.ts:350` and `realtime-backplane-plugin.ts:157`, checked by `test/health-indicator-audit.test.ts`; the database row says a pool connection timeout is `degraded`, and the discovery row says nothing of the probe's log | Line numbers follow the code; the database row names §3.2, the discovery row names §3.1's `warn`/`info`           | `docs/health-indicators.md` rows 6 and 11, and every pinned line that moves                                                                                       |
| C6  | `PUBLIC_API.md:1896` repeats C3, and `PUBLIC_API.md:5130-5139` repeats C1                                                                                                                                                                                                                                                          | Same sides as C1 and C3                                                                                           | `PUBLIC_API.md`: the database saturation paragraph, the backplane partition paragraph and `IRedisModule.create`, and the `DiscoveryProvider.isHealthy?` rejection |
| C4  | Seven READMEs say to alert on `data.<field>`; the default `/health` body has no `data`                                                                                                                                                                                                                                             | §3.6                                                                                                              | Each README sentence                                                                                                                                              |

## 3. Design decisions

### 3.1 X10-3: the discovery probe logs its reason, and the cold-resolve error names its cause

- **Decision:**
  1. `KubernetesProvider.isHealthy` stops swallowing. It resolves `true` on 2xx. On a non-2xx it
     rejects with `Error('Kubernetes EndpointSlice probe failed with HTTP <status>')`. A fetch
     rejection or the 2 s abort rejects with the original error. The `finally` still clears the
     timer.
  2. `ServiceDiscoveryService`'s constructor takes a fourth parameter,
     `reporter: ConnectionErrorReporter`. The cached probe becomes:
     - resolves `true`: `reporter.recovered()`, returns `true`;
     - resolves `false`:
       `reporter.report(new Error('<kind> discovery backend reported unreachable'))`, returns
       `false`;
     - rejects: `reporter.report(error)`, returns `false`;
     - `isHealthy` absent: unchanged (`true`, nothing reported).
  3. The plugin builds
     `createConnectionErrorReporter({ source: 'service-discovery-plugin: <provider.kind>', logger: () => ctx.logger })`
     and passes it. The first failure logs one `warn` naming the cause (`UnknownIssuer` through
     `describeError`), repeats log `debug`, and recovery logs one `info`.
  4. The cold-resolve message (`service-discovery-service.ts:242`) becomes
     `` `Service discovery could not resolve '${serviceName}' and has nothing cached: ${describeError(error)}` ``.
     The public 503 detail is unchanged.
  5. The `DiscoveryProvider.isHealthy?` JSDoc says a provider may reject with the reason, which the
     service logs and counts as unreachable.
- **Why:** the reporter in `common` already does warn-once, debug repeats and info on recovery, with
  masking. Rejecting with the reason is the only way the cause leaves the provider. The interface
  type does not change.
- **Test home:** `test/unit/providers/kubernetes-health.test.ts` (2xx true; 403 rejects with the
  status message; `UnknownIssuer` rejects with the original; abort rejects);
  `test/unit/service-discovery-service.test.ts` (true → `recovered`, false → `report`, reject →
  `report` with the cause, absent → nothing; the cold message ends with the `describeError`
  rendering of the cause and the 503 detail is unchanged); `test/integration/readiness.test.ts` (a
  recording logger sees exactly one `warn` across three failing probes, its message containing the
  cause, then one `info` after recovery).

### 3.2 V8-3: a pg acquire timeout is saturation evidence

- **Decision:**
  1. `classify.ts` gains an internal `isPoolAcquireTimeout(error): boolean`. It is true when the
     cause chain carries no string code and a member's message is exactly `PG_POOL_TIMEOUT_ANCHOR`.
     The new-connection anchor does not count.
  2. `database-capacity.ts` gains an internal symbol `DATABASE_PROBE_ACQUIRE_TIMEOUT` and a reader
     `probeHitAcquireTimeout(adapter): boolean`. It returns `false` when the adapter has no reader
     or the reader throws.
  3. `DrizzleAdapter` keeps a private `#probeAcquireTimedOut`:
     - cleared to `false` at the start of each `#probeWithRawQuery`;
     - set to `true` when the caught error passes `isPoolAcquireTimeout`, before the existing
       rethrow;
     - exposed through the symbol.
  4. The indicator's `undefined` branch counts both forms of saturation evidence:
     `(current !== undefined && isSaturated(current)) || probeHitAcquireTimeout(adapter)`. The
     existing progress condition still applies. With progress, it reports `up` +
     `reachable: 'unknown'`. A hung database (no progress) still reports `degraded`.
  5. The flag's seam is attached **only with `poolStats`**, beside the capacity and progress seams
     (`drizzle-adapter.ts:264-271`). The progress count, which tells a saturated pool from a hung
     database, exists only there. Without `poolStats`, an acquire timeout keeps the documented
     `degraded`.
- **Why:** pg-pool raises that exact message only when a checkout waited for a busy pool and timed
  out (§1), and it removes the waiter before rejecting. So `waiting` is 0 by the time anything reads
  it. The message itself is the saturation proof. When `connectionTimeoutMillis` is 2 s or more, the
  reachability bound fires first while the probe still waits, so `waiting > 0` and the existing rule
  already holds. This decision covers the sub-2 s case the row measured (1000 ms).
- **Test home:**
  - `test/unit/classify-driver-error.test.ts`: the pool anchor is true, the new-connection anchor
    and the query-read anchor are false, and the pool anchor under a string code is false.
  - `test/unit/database-pool-capacity.test.ts`: the reader is absent, throws, or returns true.
  - `test/unit/drizzle-adapter-probe-saturation.test.ts`: a fake pool rejecting with the pool anchor
    sets the flag and rethrows; a later successful probe clears it.
  - `test/integration/pool-saturation-health.test.ts`: `waiting: 0`, an acquire-timeout probe and
    progressing queries give `up`/`'unknown'`; the same with no progress gives `degraded`; a
    new-connection timeout gives `degraded`; with no `poolStats`, an acquire timeout gives
    `degraded`.
  - A guarded real-pg row in `test/integration/real-drizzle-adapter.test.ts` (guard `POSTGRES_URL`,
    line 821, skipped when absent) runs `max: 1`, `connectionTimeoutMillis: 500`, one held
    connection plus progressing queries, and expects `up`.

### 3.3 X3-3: the owned publisher drops while disconnected

- **Decision:**
  1. The transport creates its **owned publisher** with `enableOfflineQueue: false`. The subscriber
     keeps the defaults: it must queue `subscribe` until ready, and ioredis resubscribes it on
     reconnect.
  2. `IRedisModule.create`'s options type widens to
     `{ readonly commandTimeout?: number; readonly enableOfflineQueue?: boolean }`, documented the
     same way as `commandTimeout`: a module that ignores the field still type-checks, but its
     publisher then queues. `adaptRedisModule` passes the options through unchanged.
  3. `#open` waits for the owned publisher to be ready before it records the pair:
     - it waits only while the publisher is on its way to ready (ioredis `connecting`, `connect` or
       `reconnecting`); any other status resolves at once — `ready`, no `status` (a custom module's
       client cannot be observed, and a `commandTimeoutMs: 0` open would hang), `wait` (never ready
       unless something calls `connect()`) and a closed client;
     - while connecting it waits for one `'ready'` event (through `on`/`off`), after
       `subscriber.subscribe` has resolved, so a failed subscribe never leaves a ready-listener
       behind;
     - the wait is bounded by `commandTimeoutMs` when non-zero, and rejects with
       `BackendUnavailableError('realtime-backplane-plugin: redis transport')` when the bound
       passes. The bound uses `common`'s `withDeadline`, whose ambient-timer default exists for a
       caller with no runtime, which the transport is;
     - a rejection runs the existing cleanup path (discard both, detach). An injected pair is not
       waited on.
  4. A publish while the publisher is disconnected now rejects at once with the
     offline-queue-refusal error. `toBackendFault` already classifies that as `'unavailable'`, so
     the consumers' existing per-frame `warn` fires immediately instead of at the ~11 s cliff.
  5. The docs (C1):
     - frames published while the publisher or a peer's subscriber is down, including around a
       reconnect, are lost and never delivered late;
     - each lost publish logs a `warn` in the consuming plugin;
     - an injected ioredis pair should set `enableOfflineQueue: false` on its publisher;
     - a node-redis pair should set `disableOfflineQueue: true` on its client.
- **Why:** the ROADMAP leaves two options, and only the second can actually be delivered:
  - **Make late delivery survive the reconnect race.** This would need the publisher to know how
    many peers have resubscribed. The PUBLISH reply counts the sender's own subscriber, and the
    plugin does not know the peer count, so there is no sound way to hold the flush.
  - **Honest at-most-once.** Dropping frames deterministically turns three outcomes (late, lost to
    the race, dropped at the cliff) into one, and it matches the "missed, never replayed" text the
    plugin shipped with. For a realtime bus, a frame that arrives about 11 s stale is worse than no
    frame (X3-FINDINGS).
- **Test home:**
  - `test/unit/redis-backplane.test.ts`: `create` receives `enableOfflineQueue: false` for the
    publisher and not for the subscriber; open resolves at once when the status is `ready`, `wait`,
    `end` or `undefined`, waits for `'ready'` otherwise, and rejects at the `commandTimeoutMs` bound
    with cleanup; an injected pair is not waited on.
  - `test/unit/redis-module.test.ts`: options pass through.
  - Guarded real Redis, `test/integration/outage-real.test.ts`: frames published during a pause
    shorter than 11 s are not delivered after recovery, and each publish rejects within 1 s. This
    replaces any assertion of late delivery.

### 3.4 X88-9: the queue logs an outage at `warn` and its recovery at `info`

- **Decision:** `resolveLogger` returns `{ error, warn, info }`, each forwarding to the registered
  `ILogger`. Nothing else changes. `#loopFailed` already prefers `warn`, and `#loopRecovered`
  already logs when `info` exists.
- **Why:** the state machine shipped in M131a. Only the wiring was missing.
- **Test home:** `test/integration/queue-plugin-logger-ordering.test.ts`: with a registered
  recording logger, a failing recurring loop logs one `warn`, repeats stay silent, and the first
  success logs one `info`; the queue logs nothing at `error` for that loop. Drive it through the
  plugin, not the service, so `resolveLogger` is on the path.

### 3.5 V12-50: a connection lost mid-call has its own message

- **Decision:**
  1. `classify.ts` gains an internal
     `isConnectionLostMidCall(error: unknown, adapterType?: DatabaseAdapterType): boolean`, with the
     same signature as `classifyDriverError` (`classify.ts:193-196`). It is true for the chain
     members that make `'timeout'` a connection loss: `PG_TERMINATED_ANCHOR` (no string code),
     `PROTOCOL_CONNECTION_LOST`, and MariaDB `45009`. The `45009` case counts only where
     `classifyStructured` would see the `mysql-adapter` namespace, which is derived from
     `adapterType` (`classify.ts:276,454-499`). It reuses the existing constants, the chain walk and
     that namespace derivation; it does not copy them.
  2. In `classifiedOrOriginal`, the `'timeout'` branch picks the message:
     - connection lost (`isConnectionLostMidCall(error, adapterType)`):
       `'The database connection closed before the call completed; the outcome is unknown.'`;
     - otherwise: the existing bound sentence. The class (`DatabaseTimeoutError`), the 504 hint and
       the public detail are unchanged.
  3. The `DriverErrorClass` JSDoc (C2) names both sources.
- **Why:** both cases mean "outcome unknown" (504), so the class is right. Only the message lied.
  Keeping the class keeps every caller's `instanceof` and status.
- **Test home:** `test/unit/classify-driver-error.test.ts` (the three sources are true; the
  query-read anchor and an unknown error are false); `test/unit/database-service.test.ts` (a
  terminated pg error gives the new message as `DatabaseTimeoutError` with 504; a query-read timeout
  keeps the bound message).

### 3.6 V12-49: alerting advice names `details: true`

- **Decision:** each README sentence that tells the reader to alert on or monitor `data.<field>`
  gains the condition: the field is in the `/health` body only with
  `HealthPlugin({ details: true })`, and the default body has only each check's `status`. Files:
  - `packages/scheduler-plugin/README.md:174-175`
  - `packages/service-discovery-plugin/README.md:251,317-318`
  - `packages/feature-flags-plugin/README.md:167`
  - `packages/worker-pool-plugin/README.md:245`
  - `packages/messaging-plugin/README.md:2011-2012`
  - `packages/static-plugin/README.md:169`
  - `packages/realtime-backplane-plugin/README.md:205`

  `packages/health-plugin/README.md:151` already sits beside the `details` section, so it gets a
  link to that section.

- **Why:** this is the documented default (`health-plugin.ts:315-323`).
- **Test home:** none. These are documentation only, checked by `check:docs`.

### 3.7 CHANGELOG entries

- **Decision:** under Unreleased:
  - **Changed:** X3-3. Frames published while disconnected are dropped, never delivered late. An
    injected ioredis pair should set `enableOfflineQueue: false` on its publisher, and a node-redis
    pair should set `disableOfflineQueue: true`.
  - **Changed:** `KubernetesProvider.isHealthy()` (an exported class) rejects with the reason
    instead of resolving `false`.
  - **Fixed:** X10-3, V8-3, X88-9, V12-50 and V12-49, one entry each, citing the row and "M139f, PR
    pending".
  - Neither Changed entry is BREAKING, because no type changes. `docs/upgrading.md` has no `0.13.0`
    section yet; M139e writes it from these entries.
- **Why:** both are behaviour changes a caller can observe, so they belong under Changed with their
  upgrade step.
- **Test home:** `check:docs` (changelog coverage).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IRedisModule.create` gains an optional option field, which
both existing modules and callers still satisfy. `DiscoveryProvider.isHealthy?` keeps its type; only
its documentation changes. Ships in minor `0.13.0`.

| Exported symbol                                         | Kind             | Consumer / real code path that READS it                                     |
| ------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `IRedisModule` (`create` options `enableOfflineQueue?`) | interface member | `RedisBackplane.#open` passes it; `adaptRedisModule` forwards it to ioredis |
| `DiscoveryProvider.isHealthy?` (doc only)               | interface member | `ServiceDiscoveryService` probe                                             |

Internal (not exported): `isPoolAcquireTimeout`, `isConnectionLostMidCall`,
`DATABASE_PROBE_ACQUIRE_TIMEOUT`, `probeHitAcquireTimeout`, and the `ServiceDiscoveryService`
reporter parameter.

### 4.1 Options — every option names its consumer

| Option     | Consumer | Behavior (per implementation)                                                                                                               |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| None added | —        | No plugin option changes. The backplane reads `enableOfflineQueue` only on owned clients, and an injected pair keeps the caller's settings. |

## 5. Implementation files

| File                                                                                                 | Purpose                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/service-discovery-plugin/src/providers/kubernetes-provider.ts`                             | §3.1.1                                                                                                              |
| `packages/service-discovery-plugin/src/http/header-token.ts`                                         | `headerSafeToken`, the shared credential check (security audit M1, re-audit N1); `consul-provider.ts` also calls it |
| `packages/service-discovery-plugin/src/services/service-discovery-service.ts`                        | §3.1.2, §3.1.4                                                                                                      |
| `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts`                           | §3.1.3                                                                                                              |
| `packages/service-discovery-plugin/src/interfaces/index.ts`                                          | §3.1.5 JSDoc                                                                                                        |
| `packages/database-plugin/src/errors/classify.ts`                                                    | §3.2.1, §3.5.1, C2                                                                                                  |
| `packages/database-plugin/src/health/database-capacity.ts`                                           | §3.2.2                                                                                                              |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                   | §3.2.3                                                                                                              |
| `packages/database-plugin/src/plugin/database-plugin.ts`                                             | §3.2.4                                                                                                              |
| `packages/database-plugin/src/services/database-service.ts`                                          | §3.5.2                                                                                                              |
| `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`                               | §3.3.1, §3.3.3                                                                                                      |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                                         | §3.3.2, C1 JSDoc                                                                                                    |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`                                                   | §3.4                                                                                                                |
| READMEs (§3.6, C1–C3), `docs/health-indicators.md` (C5), `PUBLIC_API.md` (C6), `CHANGELOG.md` (§3.7) | docs                                                                                                                |

`src/index.ts` changes in no package.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                           | src covered                                         | Key assertions                                                                |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `service-discovery-plugin/test/unit/providers/kubernetes-health.test.ts`                                            | `kubernetes-provider.ts`                            | §3.1 test home                                                                |
| `service-discovery-plugin/test/unit/header-token.test.ts`, `consul-provider.test.ts`, `kubernetes-provider.test.ts` | `header-token.ts`, `consul-provider.ts`             | every non-visible-ASCII class refused with the fixed message, no request sent |
| `service-discovery-plugin/test/unit/service-discovery-service.test.ts`                                              | `service-discovery-service.ts`                      | §3.1; constructed with a recording `ConnectionErrorReporter`                  |
| `service-discovery-plugin/test/integration/readiness.test.ts`                                                       | `service-discovery-plugin.ts`                       | one `warn` with the cause, one `info` on recovery                             |
| `database-plugin/test/unit/classify-driver-error.test.ts`                                                           | `classify.ts`                                       | §3.2, §3.5                                                                    |
| `database-plugin/test/unit/database-pool-capacity.test.ts`                                                          | `database-capacity.ts`                              | reader absent, throws or true                                                 |
| `database-plugin/test/unit/drizzle-adapter-probe-saturation.test.ts`                                                | `drizzle-adapter.ts`                                | flag set, rethrown, then cleared                                              |
| `database-plugin/test/integration/pool-saturation-health.test.ts`                                                   | `database-plugin.ts`                                | `up` with progress; `degraded` without progress                               |
| `database-plugin/test/unit/database-service.test.ts`                                                                | `database-service.ts`                               | two timeout messages                                                          |
| `realtime-backplane-plugin/test/unit/redis-backplane.test.ts`                                                       | `redis-backplane.ts`                                | §3.3                                                                          |
| `realtime-backplane-plugin/test/unit/redis-module.test.ts`                                                          | `redis-module.ts` (unchanged; options pass-through) | `create` forwards `enableOfflineQueue`                                        |
| `realtime-backplane-plugin/test/integration/outage-real.test.ts` (guarded `REDIS_URL`)                              | real path                                           | a short pause drops frames, nothing arrives late                              |
| `queue-plugin/test/integration/queue-plugin-logger-ordering.test.ts`                                                | `queue-plugin.ts`                                   | §3.4                                                                          |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts` (guarded `POSTGRES_URL`)                            | real path                                           | §3.2                                                                          |

`test/health-indicator-audit.test.ts` (root tooling, unchanged) is the gate for C5: it fails when a
pinned line no longer holds the `ctx.health.register(...)` call.

Every changed test that proves a fix is run once without the fix and must fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139f-health-signals
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage service-discovery-plugin database-plugin realtime-backplane-plugin queue-plugin
pnpm run ci:local            # final commit, full shards, only when the user says go
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

Guarded real backends (Redis, PostgreSQL) run with the full-backend environment block. A benchmark
or another session's suite must not be running (check `pgrep`/`docker ps` first).

## 8a. Design security review

- **Flows:**
  - F1: a discovery backend error's text goes into a log line and into an error message.
  - F2: a database driver error is chosen as a log message.
- **Assets:** credentials in a backend URL or error text (the Kubernetes bearer token never enters
  an error message; Redis and pg URLs can carry userinfo).
- **Attacker:** someone who can read logs. No attacker-controlled input reaches these lines beyond
  what a backend echoes.
- **Obligations:**
  - **O1:** every new log line and message uses `describeError` (or the reporter, which uses it), so
    URL userinfo is masked and the line stays one line.
  - **O2:** the 503 public detail for discovery and the 504 public detail for the database are
    unchanged, so no cause text reaches a response body.
  - **O3:** a connection that never becomes ready still fails the backplane's start; the ready wait
    never reports a pair as open.
- **Audit:** a fresh-context audit of the committed tree, as for M139c, because the milestone
  changes what reaches logs.

## 8. Risks & mitigations

- **Per-frame `warn` now starts at once in a partition** (§3.3), where it used to start at ~11 s. A
  busy board could log many lines per second. Mitigation: the README states it, and per-frame
  logging belongs to the consuming plugins, whose rate is unchanged from the cliff case. The plan
  does not change their logging.
- **A third-party `IRedisModule` that ignores `enableOfflineQueue`** keeps queuing. Mitigation:
  documented on the type (§3.3.2), as for `commandTimeout`.
- **The real-Redis pause test is timing-sensitive.** Mitigation: assert that nothing arrives within
  a window after recovery, with a generous window, and that every publish rejects within 1 s.

## 9. Out of scope

- The Kubernetes watch loop's silent `catch` (`kubernetes-watch.ts:149-155`). The readiness probe
  now names the cause; routing the watch through the same reporter is left for a later milestone,
  and the PR body names it as a follow-up.
- Pool saturation on MySQL/MariaDB pools. Only the pg anchor is evidence here (V8-3 was measured on
  pg).
- Changing the websocket and SSE per-frame `warn` rate (§8).
