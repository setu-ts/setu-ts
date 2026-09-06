# Milestone 90b — Health That Tells the Truth, Bounded

> **Status:** Planning. Branch: `feat/m90b-health-truth-bounded`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Make every dependency-backed health signal distinguish lifecycle from present reachability, bound
and coalesce the I/O that establishes that fact, and expose capacity facts without claiming that a
merely connected dependency is serving useful work. This closes X20-1, X21-1, X25-1, X28-5/X28-6,
X29-1/X29-2, and X35-1 across secrets, cache, realtime backplane, messaging, health, queue, and
database plugins. The boundary is diagnostic readiness, plus a backwards-compatible Service Bus
retry-policy option; it does not change the default retry policy, queue admission policy, or
database pool configuration.

- **In scope:** Internal `isHealthy?` seams for cache and secrets; cached, explicitly bounded
  probes; Service Bus transport reachability and an opt-in retry-policy configuration;
  bound-method-safe messaging backplane probing; concurrent, deadline-bounded health aggregation;
  exactly defined queue backlog and database-pool capacity facts; docs and regression tests for each
  changed source file.
- **NOT this milestone:** Caller-facing pool timeout status mapping is M90f (X35-2); queue
  throughput/admission/backpressure policy is a separate queue capability; cloud-secret create
  semantics and endpoint configuration are not health changes (X20-3/X20-5); Service Bus delivery
  retry/recovery behaviour beyond a configurable SDK budget remains X28-8.

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CachedProbeOptions` / `createCachedProbe` | `packages/common/src/health/probe.ts:36-125`                                  | Accepts a `Promise<boolean>` probe, monotonic `hrtime`, optional runtime timer hooks, coalesces in-flight work, caches outcomes, turns throws/rejections/timeouts into `false`. |
| `IHealthService` / `HealthIndicatorFn`     | `packages/common/src/services/health.ts:13-100`                               | Indicators return `{ status, data? }`; reports aggregate named checks. The contract does not prescribe serial execution.                                                        |
| `IPluginContext.runtime`                   | `packages/common/src/plugin.ts:425-490`                                       | Plugins receive runtime services and the `health` registration API; no plugin needs a new token.                                                                                |
| `CacheStore`                               | `packages/cache-plugin/src/stores/cache-store.ts:21-69`                       | Internal (not barrel-exported) backend port owns lifecycle and cache operations, so optional reachability can be added without widening `ICacheStore`.                          |
| `SecretProvider`                           | `packages/secrets-plugin/src/interfaces/index.ts:132-163`                     | Internal provider seam has lifecycle plus get/set; external SDK facades are injected structural boundaries.                                                                     |
| `IMessageBroker.isHealthy?`                | `packages/common/src/services/messaging.ts:170-184`                           | Optional async reachability is the established cross-plugin port shape.                                                                                                         |
| `IRealtimeBackplane.isHealthy?`            | `packages/common/src/services/realtime.ts:137-151`                            | Optional async transport reachability is already the public backplane shape.                                                                                                    |
| Queue health/depth order                   | `packages/queue-plugin/src/services/queue-service.ts:217-250`                 | Existing indicator probes reachability before depths and preserves depths as data; it currently invokes the backend probe unbounded.                                            |
| Database health registration               | `packages/database-plugin/src/plugin/database-plugin.ts:125-135`              | The current indicator has only adapter/name data and delegates lifecycle-only `DatabaseService.isHealthy()`.                                                                    |
| Service Bus reachability                   | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:139-146,493-525` | Broker delegates optional transport `isHealthy`; its real SDK adapter must supply that member for the production path to be factual.                                            |
| Health aggregation                         | `packages/health-plugin/src/services/health-service.ts:77-124`                | The current loop awaits each selected indicator in order, which serially accumulates outage latency.                                                                            |
| Service Bus SDK adaptation                 | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:86-104,217-343`  | Current structural constructors take only connection strings and the administration facade has no namespace read; both must be extended and faked in the adapter test.          |
| Queue depth shape                          | `packages/queue-plugin/src/adapters/queue-adapter.ts:17-24,73-92`             | A reported name has `ready`, `processing`, and `dead`; a derived backlog must state which of those count as unfinished work.                                                    |
| Drizzle configuration                      | `packages/database-plugin/src/query/drizzle-database.ts:67-154`               | The configured Drizzle identity is opaque; the plugin cannot read an application driver's pool through it without a declared application-owned seam.                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                  | Resolution (picked side)                                                                                                                               | Doc deliverable (same PR)                                                                                  |
| -- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` describes M70c reachability but cache and secrets currently publish lifecycle only.                       | Source behaviour is authoritative until this milestone; make all stated dependency-backed indicators report actual reachability or explicit `unknown`. | Correct cache, secrets, messaging, queue, database, backplane, and health-status prose in `PUBLIC_API.md`. |
| C2 | Service Bus JSDoc says its real adapter probes the namespace, but `adaptServiceBusModule` does not implement `isHealthy`. | Implement the documented production probe and test its stopped/error path.                                                                             | Retain the documented behaviour only after the source matches it.                                          |
| C3 | Health response examples imply independent indicator timing, while the service runs serially.                             | Run selected indicators concurrently, retain stable registration-order insertion into `checks`, and measure each indicator individually.               | State concurrent, bounded aggregation in the Health section of `PUBLIC_API.md`.                            |

## 3. Design decisions

### 3.1 One reachability probe shape

- **Decision:** Every new dependency-I/O probe in cache, secrets, queue, database, and Service Bus
  is a `createCachedProbe` closure constructed at registration/connection time with
  `ctx.runtime.hrtime`, `ctx.runtime.setTimeout`, `ctx.runtime.clearTimeout`, a 5-second TTL, and an
  explicit 2-second timeout. It returns only a boolean and never lets probing throw through a health
  endpoint.
- **Why:** The helper already owns correct monotonic caching, timer ownership, timeout and
  coalescing semantics. Reimplementing them in seven packages would drift and turn health polling
  into dependency load.
- **Test home:** Existing `common/test/unit/health/probe.test.ts`, plus each plugin's health test
  proves one invocation per TTL/in-flight group and `false` on rejection/timeout.

### 3.2 Cache and secrets truthfulness

- **Decision:** Add optional `isHealthy?(): Promise<boolean>` only to each package's internal
  backend/provider seam. `IRedisClient` gains `ping()` and Redis invokes it; memory, noop, and env
  return their live lifecycle truth; Vault requests `/v1/sys/health`; cloud injected facades expose
  optional health methods and report `reachable: 'unknown'` when that structural capability is not
  supplied. A ready provider/store with a supplied failed probe reports `down`, with
  `data.reachable: false`; omitted capability remains explicitly `unknown`, never falsely `true`.
- **Why:** A null/absent secret is not a portable health probe, and forcing cloud facade
  implementers to invent a sentinel secret would make health alter customer data semantics. Optional
  capability matches the established messaging/realtime contract.
- **Test home:** Cache store and plugin unit tests; secrets provider/plugin unit tests, including
  Vault health status and an injected cloud facade with/without a probe.

### 3.3 Bounded Service Bus and backplane probes

- **Decision:** Extend the Service Bus administration facade with `getNamespaceProperties()` and
  make the adapted transport probe it. A success, or a positively identified HTTP 401/403 response,
  proves the namespace is reachable; only other failures are `false`. This avoids treating a normal
  send/listen-only credential as a network outage. `ServiceBusRetryOptions` models the data client's
  SDK retry shape and is optional on the production arm only; it is passed only to
  `ServiceBusClient`, never to the administration client, whose pipeline options have a different
  contract. Omission preserves the Azure SDK default; setting `maxRetries: 0` gives callers the
  documented short retry budget without pretending to provide a per-attempt deadline the SDK does
  not support below 60 s. The `ServiceBusBroker` owns the 2-second cached health probe.
  `MessagingBackplane` calls `broker.isHealthy()` on its owner; it retains the resolved broker's
  probe cache rather than adding a duplicate backplane cache.
- **Why:** This makes the real adapter satisfy the broker's documented reachability path, makes an
  authorization response an honest reachability result, and exposes the exact SDK escape hatch for
  X28-6 without changing existing publish retry defaults. Calling through the owner preserves
  `TracedBroker` private state and fixes X21-1 rather than hiding it with a catch.
- **Test home:** `service-bus-adapter.test.ts`, `service-bus-broker-health.test.ts`,
  `messaging-plugin-health.test.ts`, and `messaging-backplane.test.ts`.

### 3.4 Concurrent, bounded aggregation

- **Decision:** `HealthPluginOptions.indicatorTimeoutMs` is an optional positive finite millisecond
  deadline, defaulting to 5,000. The plugin passes it to `HealthService`; the service starts every
  selected indicator concurrently, races each one against a runtime-owned timer, records each
  latency independently, maps a timeout to `{ status: 'down', data: { reason: 'timeout' } }` and a
  rejection to `{ status: 'down', data: { reason: 'error' } }` without serializing the thrown value,
  then builds `checks` in registration order and computes the worst status after all outcomes
  settle.
- **Why:** Individual backend probes are bounded at 2 seconds, but arbitrary contributed indicators
  can otherwise leave the whole endpoint pending forever; sequential awaiting also multiplies the
  outage bound. The configurable 5-second default preserves the existing documented 3-second HTTP
  indicator example while making every report bounded.
- **Test home:** `packages/health-plugin/test/unit/health-service.test.ts` proves concurrency,
  stable report ordering, rejection conversion, and `/live`/`/ready` filters.

### 3.5 Saturation is data before policy

- **Decision:** `DrizzleAdapterOptions.poolStats` is an optional application-owned callback
  returning `DatabasePoolCapacity { total, idle, waiting }`; the application reads its driver's
  documented pool counters and the adapter exposes the snapshot through a non-barrel internal symbol
  seam. The database plugin feature-detects that symbol on the `IDatabaseAdapter` value, so `common`
  and every other adapter stay unchanged. Queue health publishes `backlog` only when at least one
  depth read succeeds; it is the sum of each successful name's `ready + processing`, deliberately
  excluding `dead` because dead-lettered jobs are terminal and already remain visible per name. Both
  remain `up` when reachable: no threshold or implicit autoscaling policy is added.
- **Why:** X35-1 and X25-1 need observable saturation now, but a universal degraded threshold would
  be arbitrary and misrepresent intentionally buffered workloads. The queue precedent already
  publishes depth as data.
- **Test home:** Drizzle client/adapter health tests and queue-service health tests assert exact
  fields, zero/nonzero backlogs, and no depth call after failed reachability.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                  | Kind                        | Consumer / real code path that READS it                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ServiceBusRetryOptions`                                                                         | type                        | Production `ServiceBusMessagingOptions` accepts it; `adaptServiceBusModule` passes it to `ServiceBusClient`.  |
| `IAwsSecretsClient.isHealthy?`, `IGcpSecretsClient.isHealthy?`, `IAzureSecretsClient.isHealthy?` | optional structural methods | Respective provider probes them when injected; absence becomes explicit health `unknown`.                     |
| `DatabasePoolCapacity`                                                                           | type                        | `DrizzleAdapterOptions.poolStats` returns it; the internal adapter seam publishes it to the health indicator. |

### 4.1 Options — every option names its consumer

| Option                                    | Consumer                            | Behavior (per implementation)                                                                      |
| ----------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| `ServiceBusMessagingOptions.retryOptions` | Service Bus data-client constructor | Passed only to `ServiceBusClient`; omitted preserves the Azure SDK default.                        |
| `HealthPluginOptions.indicatorTimeoutMs`  | `HealthPlugin` / `HealthService`    | Positive finite deadline applied independently to every selected indicator; omitted uses 5,000 ms. |
| `DrizzleAdapterOptions.poolStats`         | `DrizzleAdapter`                    | Application-owned callback supplies `{ total, idle, waiting }`; omitted means no capacity data.    |

## 5. Implementation files

| File                                                                                                       | Purpose                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/cache-plugin/src/interfaces/index.ts`                                                            | Add the typed Redis `ping()` member used by the health probe.                       |
| `packages/cache-plugin/src/stores/{cache-store,redis-store,memory-store,noop-store}.ts`                    | Internal optional probe port and backend implementations.                           |
| `packages/cache-plugin/src/plugin/cache-plugin.ts`                                                         | Build/cache the bounded probe and publish lifecycle plus reachability.              |
| `packages/secrets-plugin/src/interfaces/index.ts`                                                          | Provider and optional injected-client health seams.                                 |
| `packages/secrets-plugin/src/providers/{env-provider,vault,aws-kms,gcp-secret-manager,azure-key-vault}.ts` | Provider-specific reachability implementations/delegation.                          |
| `packages/secrets-plugin/src/plugin/secrets-plugin.ts`                                                     | Cached probe and truthful indicator payload.                                        |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`                                              | SDK adapter namespace probe, authorization classification, and cached broker probe. |
| `packages/messaging-plugin/src/interfaces/index.ts`                                                        | Typed production-only Service Bus retry option.                                     |
| `packages/messaging-plugin/src/index.ts`                                                                   | Barrel-export the public Service Bus retry type.                                    |
| `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`                                 | Bound broker probe invocation.                                                      |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`                                                 | Forward the production retry option into `ServiceBusBroker`.                        |
| `packages/queue-plugin/src/services/queue-service.ts`                                                      | Cache/bound reachability and publish the defined aggregate backlog fact.            |
| `packages/database-plugin/src/interfaces/index.ts`                                                         | Public pool-capacity type and Drizzle callback option.                              |
| `packages/database-plugin/src/health/database-capacity.ts`                                                 | Non-barrel symbol, snapshot type guard, and adapter/plugin bridge.                  |
| `packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts`                                         | Read the application-owned pool callback and implement the symbol seam.             |
| `packages/database-plugin/src/plugin/database-plugin.ts`                                                   | Bounded probe and capacity data in the database indicator.                          |
| `packages/health-plugin/src/interfaces/index.ts`                                                           | Public indicator-deadline option.                                                   |
| `packages/health-plugin/src/plugin/health-plugin.ts`                                                       | Validate and pass the deadline to the health service.                               |
| `packages/health-plugin/src/services/health-service.ts`                                                    | Concurrent deadline-bounded aggregation and error-to-down conversion.               |
| `PUBLIC_API.md`                                                                                            | Corrected health semantics and documented public options/types.                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                  | src covered                                                 | Key assertions (and the signature each call type-checks against)                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache-plugin/test/unit/{redis-store,memory-store,noop-store}.test.ts`                                                                     | cache backend sources and interfaces                        | `isHealthy?(): Promise<boolean>` invokes typed `ping`, returns lifecycle truth, and is false after disconnect.                                                                   |
| `cache-plugin/test/unit/cache-plugin.test.ts`                                                                                              | `plugin/cache-plugin.ts`, `stores/cache-store.ts`           | Redis outage produces `{ status: 'down', data.reachable: false }`; concurrent checks share one `isHealthy` call.                                                                 |
| `secrets-plugin/test/unit/{env-provider,vault,aws-kms,gcp-secret-manager,azure-key-vault}.test.ts`                                         | provider sources                                            | Each `isHealthy?(): Promise<boolean>` success/failure/absence path; Vault calls its health URL without reading a secret.                                                         |
| `secrets-plugin/test/unit/secrets-plugin.test.ts`                                                                                          | `interfaces/index.ts`, `plugin/secrets-plugin.ts`           | Lifecycle and reachability are distinct; unknown facade capability remains `up` with `reachable: 'unknown'`; timeout is down.                                                    |
| `messaging-plugin/test/unit/{service-bus-adapter,brokers/service-bus-broker-health,plugin/messaging-plugin-health,barrel-exports}.test.ts` | Service Bus broker, interfaces, plugin, barrel              | Adapted SDK health probes namespace; 401/403 proves reachability; retry config reaches only the data client; failure/timeout is `reachable: false`.                              |
| `realtime-backplane-plugin/test/unit/messaging-backplane.test.ts`                                                                          | `transports/messaging-backplane.ts`                         | A receiver whose `isHealthy` needs its `this` succeeds; false remains false.                                                                                                     |
| `queue-plugin/test/unit/queue-service-coverage.test.ts`                                                                                    | `services/queue-service.ts`                                 | Cached reachability; backlog equals ready plus processing; dead is excluded; zero/partial depth, outage skip-depth, and unknown-probe branches.                                  |
| `database-plugin/test/unit/{drizzle-adapter,database-plugin-custom-arm,plugin-coverage,plugin-options-types}.test.ts`                      | database interfaces, capacity seam, Drizzle adapter, plugin | Application pool callback maps exact public fields; absent callback stays compatible; non-Drizzle adapter has no fields; indicator stays `up`.                                   |
| `health-plugin/test/unit/{health-service,health-plugin-factories}.test.ts`                                                                 | health interfaces, plugin, service                          | Two deferred indicators start before their resolutions; timeout/rejection bodies use only the specified reason; option validation, ordering, latency and filters remain correct. |
| `test/package-readme-fence-compiler.test.ts`                                                                                               | `PUBLIC_API.md` examples                                    | Updated public configuration examples continue to compile.                                                                                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90b-health-truth-bounded, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

After committing the completed tree, also run `deno task publish:check` and
`deno task release:verify <version>` with the release version selected by the maintainer.

## 8. Risks & mitigations

- An Azure SDK administration operation may differ from the emulator: isolate it behind the existing
  SDK module adapter and prove all adaptation branches with a fake, with a guarded real-emulator
  test where available.
- A timed-out probe can continue in a driver that has no abort signal: cache/coalesce its false
  result so health callers do not pile up; do not claim cancellation that the dependency cannot
  provide.
- Pool internals are not a supported framework compatibility surface: the application supplies the
  `poolStats` callback from its driver's documented API, and adapters that receive no callback
  publish no capacity fields.
- Concurrent execution changes timing but must not scramble reports: retain the registration-order
  name list when collecting settled results.

## 9. Out of scope

- Define an operational queue backlog threshold, reject enqueue requests, or change default worker
  concurrency; this milestone publishes facts only.
- Convert database pool timeouts to 503/Retry-After; M90f owns that caller-facing error contract.
- Add a generic health endpoint/configuration to every third-party secrets SDK facade; unknown is
  the truthful result when a facade has no non-mutating probe.
