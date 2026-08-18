# Milestone 70c — Health signals that describe lifecycle, not reachability

> **Status:** Planning. Branch: `feat/m70c-health-signals`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Six packages answer `up` with their backends stopped, so `/ready` stays `200` and a dead dependency
triggers no restart, no alert and no rolling-deploy gate. The cause is one shape repeated: an
indicator reports its own **configuration** or a **lifecycle flag** (`connect()` was called and
`disconnect()` was not) and calls it health. This milestone makes every one of those signals
describe **reachability**, adds the reconnection that turns a broker blip into a self-repair rather
than a permanent outage, and fixes the two health-surface defects that ride with them — the report
publishing whatever an indicator returns (X3-7) and the gRPC bridge disagreeing with `/ready` about
`degraded` (X7-8).

The register scoped this as a **sweep, not a fix per report**, supplies the shape to audit against
(`ISessionStore.isHealthy?()`, `common/src/services/session.ts:183`) and names the counter-example
to build from (`worker-pool`'s indicator, `worker-pool-plugin/src/plugin/worker-pool-plugin.ts:49`,
the only one of the six reporting live state).

- **In scope:** register rows **X2-1** (all seven messaging brokers: truthful signal **and**
  reconnect with backoff, re-establishing subscriptions), **X3-2** (the realtime backplane's
  hardcoded `up`), **X8-5** (`storage`, `mail`, `queue`), **X10-3 health face** (service discovery
  reports `up` having never reached the API server) plus its `docs/deployment.md` `DENO_CERT`
  paragraph, **X7-8** (`degraded → NOT_SERVING`), **X3-7** (project each indicator result to
  `{ status, data }`). Packages: `common`, `health-plugin`, `messaging-plugin`,
  `realtime-backplane-plugin`, `storage-plugin`, `mail-plugin`, `queue-plugin`,
  `service-discovery-plugin`, `grpc-plugin`, and `docs/`.
- **NOT this milestone:**
  - **X10-3 parts 1 and 3** — setting `DENO_CERT` in the Helm chart and the CLI's `k8s/members.yaml`
    (M39 owns deployment artifacts; the CLI-manifest rows are M70g's), and logging a failed
    resolve's `cause` (M70f owns error visibility, including the sibling row X7-5). Maintainer's
    call, taken at plan time.
  - **The identically-shaped indicators outside the ROADMAP's named six** — `cache-plugin`
    (`cache-plugin.ts:108`), `database-plugin` (`database-plugin.ts:119`), `audit-plugin`
    (`audit-plugin.ts:136`) and `notification-plugin` (`notification-plugin.ts:88`) all report a
    configuration literal or an `isReady()` lifecycle flag. §3.9 makes the audit a deliverable that
    **classifies every registered indicator** and files the defective ones as new register rows;
    fixing them is not in this milestone's package list and is not smuggled in.
  - `cloudflare-plugin`'s indicator (`cloudflare-plugin.ts:229`), which is deliberately
    configuration-only because a binding read bills per operation — M52 documented that, and X8-5's
    own fix text carves it out. §3.9 classifies it `justified-literal` and it is not changed.

## 1. Contracts verified from SOURCE (not names)

Every row below was opened and read on this branch. The four npm rows were **probed by running the
real package** (`deno run` against `npm:` specifiers already in `deno.lock`), because reconnect
behaviour is the fact this milestone's design turns on and memory is not evidence for it.

| Reference                      | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HealthCheckResult`            | `packages/common/src/services/health.ts:13-19`                                                          | Declares exactly `status: HealthStatus` and `data?: Readonly<Record<string, unknown>>`. Nothing else.                                                                                                                   |
| `HealthStatus`                 | `packages/common/src/types.ts:62`                                                                       | `'up' \| 'down' \| 'degraded'`.                                                                                                                                                                                         |
| `ISessionStore.isHealthy?`     | `packages/common/src/services/session.ts:183`                                                           | `isHealthy?(): Promise<boolean>` — optional, documented as "a store with no meaningful liveness check omits it". **This is the shape to copy.**                                                                         |
| `SessionService.storeHealth`   | `packages/session-plugin/src/services/session-service.ts:208`                                           | `Promise<boolean \| undefined>`; the indicator maps `false → 'down'` and `undefined → 'none'` (`session-plugin.ts:131-146`). Precedent for §3.2.                                                                        |
| `HealthService.#runIndicators` | `packages/health-plugin/src/services/health-service.ts:92-117`                                          | Assembles `checks[name] = { ...result, latencyMs }` — **spreads the whole result**, which is X3-7: undeclared fields are published verbatim.                                                                            |
| readiness rule                 | `packages/health-plugin/src/plugin/health-plugin.ts:150-174`                                            | `/ready` = `200` iff `report.status === 'up'`; `/health` = `503` only if any indicator is `down` (`degraded` is `200`). Load-bearing for §3.2/§3.8.                                                                     |
| `worker-pool` indicator        | `packages/worker-pool-plugin/src/plugin/worker-pool-plugin.ts:49-57`                                    | Reports `{ available, pools: service.stats() }` — live counts. The counter-example; note it still hardcodes `status: 'up'` (§3.9 records this).                                                                         |
| `MessageBrokerAdapter`         | `packages/messaging-plugin/src/brokers/message-broker.ts:11-19`                                         | **Internal** seam `extends IMessageBroker` adding `isReady(): boolean`. So messaging's readiness already lives outside `common`.                                                                                        |
| messaging indicator            | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:236-243`                                      | `status: broker.isReady() ? 'up' : 'down'`, `data: { broker: brokerType }`.                                                                                                                                             |
| `RabbitMqBroker` state         | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:100-103,194`                                  | `#connection`, `#channel`, `#ready`, `#activeConsumers: Map<string, ActiveConsumer>`. `#ready` is written only in `connect()`/`disconnect()`.                                                                           |
| broker subscription registries | `rabbitmq-broker.ts:103`, `nats-broker.ts:95`, `kafka-broker.ts:109`, `redis-streams-broker.ts:108,112` | Every broker already keeps `#activeConsumers`/`#activeSubscriptions` keyed by id — **this is the replay source §3.5 needs**; none is added.                                                                             |
| `IAmqpConnection`              | `packages/messaging-plugin/src/interfaces/index.ts:46-50`                                               | `createChannel()`, `close()`. **No event surface** — nothing for a fault listener to attach to.                                                                                                                         |
| `IRedisStreamsClient`          | `packages/messaging-plugin/src/interfaces/index.ts:16-37`                                               | `xadd`/`xgroup`/`xreadgroup`/`xack`/`quit`/`connect?`. No `status`, no `ping`, no `on`.                                                                                                                                 |
| `INatsConnection`              | `packages/messaging-plugin/src/interfaces/index.ts:60-66`                                               | `jetstream()`, `jetstreamManager()`, `close()`. No liveness member.                                                                                                                                                     |
| `IKafkaFactory`                | `packages/messaging-plugin/src/interfaces/index.ts:76-81`                                               | `producer()`, `consumer({groupId})`. No `admin()` — M14d already recorded this.                                                                                                                                         |
| `IPubSubTransport`             | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:66-84`                                          | `publish`/`open`/`createSubscription`/`deleteSubscription`/`close`. No liveness member.                                                                                                                                 |
| `IServiceBusTransport`         | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:108-129`                                   | `send`/`open`/`createSubscription`/`deleteSubscription`/`close`. No liveness member.                                                                                                                                    |
| `IRealtimeBackplane`           | `packages/common/src/services/realtime.ts:104-140`                                                      | `origin`/`connect`/`publish`/`subscribe`/`close`. **No liveness member** — X3-2's "there is nothing to consult" is accurate.                                                                                            |
| backplane indicator            | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:69-79`                      | A literal `status: 'up'`. It never touches the transport on any arm.                                                                                                                                                    |
| `IRedisBackplaneClient`        | `packages/realtime-backplane-plugin/src/interfaces/index.ts:17-56`                                      | `publish`/`subscribe`/`unsubscribe`/`on`/`off`/`quit`. `on` is typed `(channel, message) => void`, so an `'error'` listener does not fit it.                                                                            |
| backplane transports           | `packages/realtime-backplane-plugin/src/transports/`                                                    | Exactly four arms: `MemoryBackplane:37`, `MessagingBackplane:54`, `RedisBackplane:33`, plus the `'custom'` arm in `backplane-factory.ts`.                                                                               |
| `StorageProvider`              | `packages/storage-plugin/src/interfaces/index.ts:182-190`                                               | `connect`/`disconnect`/`isReady(): boolean`/`put`/`get`/`delete`/`exists`/…                                                                                                                                             |
| storage indicator              | `packages/storage-plugin/src/plugin/storage-plugin.ts:156-160`                                          | `provider.isReady() ? 'up' : 'down'`, `data: { provider }`.                                                                                                                                                             |
| `IAwsS3Client`                 | `packages/storage-plugin/src/interfaces/index.ts:105-112`                                               | `put`/`get`/`delete`/`head(path)`/`getSignedUrl`/`getStream`. **`head` already exists** — the S3 probe needs no new client method.                                                                                      |
| `MailProvider`                 | `packages/mail-plugin/src/interfaces/index.ts:160-172`                                                  | `connect`/`disconnect`/`isReady(): boolean`/`send`.                                                                                                                                                                     |
| `ISmtpTransport`               | `packages/mail-plugin/src/interfaces/index.ts:41-58`                                                    | `sendMail(...)` only — no `verify`, which nodemailer's real transport does expose.                                                                                                                                      |
| `QueueAdapter`                 | `packages/queue-plugin/src/adapters/queue-adapter.ts:20-43`                                             | `connect`/`disconnect`/`isReady(): boolean`/`enqueue`/`reserve`/…                                                                                                                                                       |
| queue indicator                | `packages/queue-plugin/src/services/queue-service.ts:201-209`                                           | `createHealthIndicator()` returns `this.isReady() ? 'up' : 'down'`, `data: { adapter: constructor.name }`.                                                                                                              |
| `DiscoveryProvider`            | `packages/service-discovery-plugin/src/interfaces/index.ts:17-59`                                       | `kind`/`resolve`/`watch`/`registerSelf?`/`deregisterSelf?`.                                                                                                                                                             |
| discovery indicator + comment  | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:93-109`                       | The comment claiming `'down'` is "unreachable by construction", and `status: service.degraded ? 'degraded' : 'up'`.                                                                                                     |
| `#degraded` writes             | `packages/service-discovery-plugin/src/services/service-discovery-service.ts:46,73,153,182,189`         | Set `true` **only at :189** (the stale-cache branch, which requires a prior success). X10-3's "the premise is false" is confirmed.                                                                                      |
| `mapHealthStatus`              | `packages/grpc-plugin/src/health/grpc-health-bridge.ts:42-57`                                           | `degraded → 'serving'`, with the rationale comment X7-8 falsifies.                                                                                                                                                      |
| **npm** `ioredis@5`            | probed: `new Redis(url, {lazyConnect:true})`                                                            | `status` (string, `'wait'` when lazy), `ping()`, `on()`. **Auto-reconnects** via its default retry strategy.                                                                                                            |
| **npm** `amqplib@0.10`         | probed: `lib/channel_model.js`                                                                          | `ChannelModel extends EventEmitter` (`close`/`createChannel`/`createConfirmChannel`); `Channel` has `close`/`consume`/`cancel`. **No reconnect member anywhere** — RabbitMQ is the one broker needing an explicit loop. |
| **npm** `nats@2`               | probed: `Events`/`DebugEvents` enums + `NatsConnectionImpl`                                             | `Events = {Disconnect, Reconnect, Update, LDM, Error}`; connection exposes `status()`, `isClosed()`, `closed()`, `rtt()`, `reconnect()`. **Reconnects itself.**                                                         |
| **npm** `kafkajs@2`            | probed: `consumer.events` / `producer.events`                                                           | Consumer emits `CONNECT`, `DISCONNECT`, `CRASH`, `REBALANCING`, …; producer emits `CONNECT`, `DISCONNECT`, `REQUEST_TIMEOUT`. **Retries internally**; `CRASH` with `restart: false` is the terminal signal.             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                                                                                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `grpc-health-bridge.ts:42-46`, the gRPC README and `PUBLIC_API.md` all justify `degraded → SERVING` as avoiding a Kubernetes withdrawal — but `health-plugin.ts:168` already withdraws the replica on `degraded` via `/ready`. The stated reason describes an outcome the framework's own default already produces.                                                                   | **Map `degraded → NOT_SERVING`** (maintainer's call). The two health faces of one process agree, and the split brain — gRPC clients load-balancing onto a replica HTTP has taken out of rotation — ends. | Rewrite the comment at `grpc-health-bridge.ts:42-46`; correct the `grpc-plugin` README and the `PUBLIC_API.md` gRPC health rows; **CHANGELOG entry under Changed with migration text** (a client relying on `SERVING` while degraded now sees `NOT_SERVING`). |
| C2 | `service-discovery-plugin.ts:96-98` asserts in a source comment that `'down'` is "unreachable by construction"; `service-discovery-service.ts:189` shows `#degraded` is set only after a prior success, so a provider that never reached its backend reports `up` forever. The comment is the bug.                                                                                    | **Delete the claim and make `down` reachable** (§3.6): track "has never successfully resolved" distinctly from "degraded from a stale cache".                                                            | Replace the comment with the real rule; add the status table to the `service-discovery-plugin` README and the `PUBLIC_API.md` Service Discovery section.                                                                                                      |
| C3 | `packages/service-discovery-plugin/README.md:196` documents the in-cluster `DENO_CERT` requirement; `docs/deployment.md` owns the "Service discovery and RBAC" section, is what that README links to, and never mentions it (`grep -n "DENO_CERT\|NODE_EXTRA_CA\|ca.crt" docs/deployment.md` → nothing). A reader following the guide end to end gets the RBAC right and still fails. | **The guide is wrong by omission**; the README is correct. Add the requirement to the guide beside the RBAC it already documents.                                                                        | New paragraph in `docs/deployment.md` naming `DENO_CERT` / `NODE_EXTRA_CA_CERTS` and the fixed `serviceaccount/ca.crt` path, cross-linked from the RBAC subsection.                                                                                           |
| C4 | `common/src/services/health.ts:13-19` declares `{ status, data? }`, and the health service publishes whatever an indicator returns (X3-7), so a typo'd `details` is served beside the built-ins' `data`. Contract and behaviour disagree.                                                                                                                                             | **The contract is right**; project each result to `{ status, data }` when assembling the report (§3.8).                                                                                                  | `PUBLIC_API.md` Health section states the projection explicitly (an undeclared field is dropped, not published); CHANGELOG under Changed.                                                                                                                     |
| C5 | Six package READMEs and `PUBLIC_API.md` describe their health indicators without saying what the status means. After this milestone `up`/`degraded`/`down` become load-bearing operational signals.                                                                                                                                                                                   | Document the per-package status table wherever the indicator is described.                                                                                                                               | Health-status tables added to the `messaging-plugin`, `realtime-backplane-plugin`, `storage-plugin`, `mail-plugin`, `queue-plugin` and `service-discovery-plugin` READMEs and their `PUBLIC_API.md` sections.                                                 |

## 3. Design decisions

### 3.1 The one seam: `isHealthy?(): Promise<boolean>` on the port, never a new status type

- **Decision:** every backend-owning port gains an **optional** `isHealthy?(): Promise<boolean>`
  answering one factual question — _is the backend reachable right now_. Ports widened:
  `IMessageBroker` and `IRealtimeBackplane` (in `common`, flagged widenings), and the
  plugin-internal `StorageProvider`, `MailProvider`, `QueueAdapter`, `DiscoveryProvider`.
  `MessageBrokerAdapter` inherits it from `IMessageBroker` and is not widened separately.
- **Why:** it is verbatim the shape `common` already ships at `session.ts:183`, which X3-2's own fix
  text names. Optional keeps every widening source-compatible: no existing implementor breaks, which
  matters because `cloudflare-plugin` implements `IQueue`/`IRealtimeBackplane` and applications
  implement the `'custom'` arms. `IMessageBroker` (not only the internal adapter) is the one
  carrying it because `MessagingBackplane` must delegate to a broker it resolved from
  `CAPABILITIES.MESSAGING` — typed `IMessageBroker` — and §2.2 forbids it importing
  `messaging-plugin` to reach the internal seam.
- **Rejected:** returning `HealthCheckResult` from the port. That puts the _policy_ (is a dead
  backplane `down` or `degraded`?) inside the transport, where it cannot see the application. The
  port answers a fact; the plugin's indicator owns the mapping (§3.2).
- **Test home:** `common/test/unit/contracts.test.ts` (optionality: an implementor omitting it still
  satisfies the type), plus each package's indicator tests.

### 3.2 `isReady()` stays and means what it always meant; the indicator reports both

- **Decision:** `isReady()` is **not** removed, renamed or repurposed on any port. It keeps its
  lifecycle meaning ("`connect()` was called and `disconnect()` was not") and its JSDoc is corrected
  to say exactly that. The indicator composes the two: `isReady() === false → 'down'` (never
  started, or shut down); otherwise it awaits `isHealthy?.()` and maps `false → 'down'`,
  `true → 'up'`, `undefined` (port does not implement it) → `'up'` with `reachable: 'unknown'` in
  `data`.
- **Why:** §9.2 governs published members on published packages — `isReady()` is on the public
  `StorageProvider`/`MailProvider`/`QueueAdapter` surface and on the internal broker seam, and
  removing it would break every custom implementation for no gain. The two questions are genuinely
  different and an operator needs both; X2-1's fix #3 asks for exactly this distinction to be
  documented rather than collapsed.
- **The `undefined` arm is honest, not a loophole:** it is the only outcome that reports "we did not
  check", and `data.reachable` makes it visible on `/health` rather than indistinguishable from a
  successful probe. Every in-repo implementation of every widened port implements `isHealthy` in
  this milestone (§3.4 table), so `undefined` is reachable only through an application's own custom
  arm.
- **Test home:** one shared table-driven test per package asserting all four arms.

### 3.3 Probes are cached and time-bounded, through one pure helper in `common`

- **Decision:** `common` gains a pure `createCachedProbe(options)` returning
  `() => Promise<boolean>`, with `{ probe, ttlMs, timeoutMs, hrtime }`. It caches the last outcome
  for `ttlMs` (default `5000`), coalesces concurrent calls into one in-flight probe, bounds each
  probe with `timeoutMs` (default `2000`, a timeout counting as unreachable), and never lets a
  rejecting probe escape — a throw is `false`. Every package's `isHealthy` is built through it.
- **Why:** `/health` is polled by kubelet, by Prometheus and by load balancers; an uncached probe
  makes the health endpoint itself a load generator against the very backend it is checking, which
  X8-5's fix text calls out. Six packages need identical caching, so a copy in each is the §11.1
  duplication this repo has repeatedly paid for — and §2.2 forbids the plugin-to-plugin import that
  would be the alternative. `common` already carries pure shared utilities for exactly this reason
  (M47's frame codec, M55's content-type map, M52's `splitWorkerEnv`).
- **Clock:** `hrtime` is injected and is `IRuntimeServices.hrtime()` — a **monotonic** reading. TTL
  is an interval, so a wall clock would be wrong here and `Date.now()` is banned outside
  `packages/runtime` regardless.
- **Test home:** `common/test/unit/health/probe.test.ts` — TTL boundary, coalescing (two concurrent
  callers, one probe call), timeout, throw-is-false, and post-TTL re-probe.

### 3.4 Per-implementation probe, decided from the probed client surface

Each row states what the probe actually does. Where a client facade lacks the primitive, the facade
is widened with an **optional** member (non-breaking for injectors) and the real adapter implements
it; the fake-only path then reports `unknown` rather than lying.

| Implementation               | Probe                                                                                                                                                                                                            | Facade change                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InMemoryBroker`             | `true` while `isReady()` — there is no backend to be unreachable.                                                                                                                                                | none                                                                                                                                                    |
| `RedisStreamsBroker`         | `client.ping()` resolves.                                                                                                                                                                                        | `IRedisStreamsClient.ping?()`, `status?`                                                                                                                |
| `RabbitMqBroker`             | connection-fault flag maintained by the `'error'`/`'close'` listeners (§3.5); no request is issued.                                                                                                              | `IAmqpConnection.on?(event, listener)`                                                                                                                  |
| `NatsBroker`                 | `connection.isClosed() === false` **and** `rtt()` resolves under the timeout.                                                                                                                                    | `INatsConnection.isClosed?()`, `rtt?()`, `status?()`                                                                                                    |
| `KafkaBroker`                | consumer-fault flag maintained by the `CRASH`/`DISCONNECT`/`CONNECT` listeners (§3.5).                                                                                                                           | consumer/producer facades gain `on?(event, listener)`                                                                                                   |
| `PubSubBroker`               | `transport.isHealthy?.()` — the real adapter calls the SDK's `topic.exists()`.                                                                                                                                   | `IPubSubTransport.isHealthy?()`                                                                                                                         |
| `ServiceBusBroker`           | `transport.isHealthy?.()` — the real adapter peeks the namespace via its existing client.                                                                                                                        | `IServiceBusTransport.isHealthy?()`                                                                                                                     |
| `custom-adapter`             | delegates when the wrapped instance implements `isHealthy`, else `unknown`.                                                                                                                                      | none                                                                                                                                                    |
| `MemoryBackplane`            | `true` — a real single-process bus (M47), nothing to be unreachable.                                                                                                                                             | none                                                                                                                                                    |
| `MessagingBackplane`         | delegates to the resolved broker's `isHealthy?.()` (§3.1).                                                                                                                                                       | none                                                                                                                                                    |
| `RedisBackplane`             | **both** connections: `status === 'ready'` on each, then `ping()`. A subscriber-mode connection refuses every other command, so the pair is checked separately (M47 established the two-connection requirement). | `IRedisBackplaneClient.ping?()`, `status?`, and an `onError?` registration whose listener signature differs from the existing `(channel, message)` `on` |
| `MemoryProvider` (storage)   | `true`.                                                                                                                                                                                                          | none                                                                                                                                                    |
| `LocalStorageProvider`       | `runtime.fs.stat(root)` succeeds — a disk that vanished or a permission change is a real, common failure.                                                                                                        | none                                                                                                                                                    |
| `S3Provider` / B2            | `client.head('')`-shaped bucket probe using the **existing** `head` member.                                                                                                                                      | none                                                                                                                                                    |
| `GcsProvider`                | `bucket.exists()` through the injected client.                                                                                                                                                                   | `IGcsClient.isHealthy?()`                                                                                                                               |
| `AzureBlobProvider`          | container client `exists()`.                                                                                                                                                                                     | `IAzureBlobClient.isHealthy?()`                                                                                                                         |
| `LogProvider` (mail)         | `true`.                                                                                                                                                                                                          | none                                                                                                                                                    |
| `SmtpProvider`               | `transport.verify?.()` — nodemailer's real transport exposes it; absent, `unknown`.                                                                                                                              | `ISmtpTransport.verify?()`                                                                                                                              |
| `SesProvider`                | `client.isHealthy?.()` — the real adapter issues `GetAccount`.                                                                                                                                                   | `ISesClient.isHealthy?()`                                                                                                                               |
| `SendGridProvider`           | a `GET /v3/scopes` through the existing `IMailHttp` seam, 2xx/401 both meaning reachable.                                                                                                                        | none                                                                                                                                                    |
| `MemoryQueue`                | `true`.                                                                                                                                                                                                          | none                                                                                                                                                    |
| `RedisQueue`                 | `client.ping()`.                                                                                                                                                                                                 | `IRedisQueueClient.ping?()`                                                                                                                             |
| `RabbitMqQueue`              | connection-fault flag, same mechanism as the broker.                                                                                                                                                             | `on?` on its connection facade                                                                                                                          |
| `SqsQueue`                   | `client.isHealthy?.()` — the real adapter issues `GetQueueAttributes`.                                                                                                                                           | `ISqsClient.isHealthy?()`                                                                                                                               |
| `StaticProvider` (discovery) | `true` — the map is in memory.                                                                                                                                                                                   | none                                                                                                                                                    |
| `ConsulProvider`             | `GET /v1/status/leader` through the existing `IDiscoveryHttp` seam.                                                                                                                                              | none                                                                                                                                                    |
| `KubernetesProvider`         | a `limit=1` LIST against the EndpointSlice API through the existing seam. **This is the probe that makes X10-3 visible** — the `UnknownIssuer` TLS rejection surfaces here as `down`.                            | none                                                                                                                                                    |
| `DnsProvider`                | `runtime.dns` resolve of the configured service name.                                                                                                                                                            | none                                                                                                                                                    |

- **Why the `unknown` arm rather than `false` for an un-widened injected fake:** an application that
  injects a minimal client has not told us the backend is dead. Reporting `down` would fail `/ready`
  for every such application on upgrade — a far worse regression than the defect being fixed.
- **Test home:** one probe test per implementation file (§6), each driving reachable, unreachable,
  timeout and (where applicable) not-implemented.

### 3.5 Reconnect: an explicit supervisor for RabbitMQ, observation for the clients that self-heal

- **Decision:** `messaging-plugin` gains one internal `ReconnectSupervisor`
  (`src/brokers/reconnect.ts`) owning backoff, the reconnect attempt loop, and replay of the
  broker's existing subscription registry. Brokers use it in one of **two modes**, decided by the
  probed behaviour of their client (§1):
  - **`drive` (RabbitMQ only):** amqplib has no reconnect of any kind, so the supervisor reconnects
    on the `'error'`/`'close'` events, re-asserts the exchange, and replays every entry of
    `#activeConsumers` — which is why X2-1's queues showed **no consumers** after a broker restart
    and never recovered.
  - **`observe` (redis-streams, nats, kafka):** the client reconnects itself. The supervisor only
    tracks the fault/recovery events so `isHealthy` is truthful during the window, and replays
    subscriptions **only** where the client does not restore them itself — kafkajs restores its
    consumer group, ioredis's poll loop resumes against a live client, and NATS JetStream consumer
    bindings are re-established after `Events.Reconnect`.
  - Cloud brokers (`pubsub`, `service-bus`) stay SDK-managed: both SDKs own streaming-pull
    reconnection and neither facade exposes a hook. They get the §3.4 probe only.
- **Backoff:** full-jitter exponential, `initialMs: 500`, `maxMs: 30_000`, unbounded attempts,
  driven by `IRuntimeServices.setTimeout`. Unbounded because a broker outage longer than any attempt
  cap is exactly the case that must still self-repair; the health signal reports `down` throughout,
  so an orchestrator can act in parallel.
- **`#ready` is not overloaded:** reconnection state is its own field. `isReady()` keeps meaning
  lifecycle (§3.2), so a broker reconnecting reports `isReady() === true` and
  `isHealthy() === false` — which is precisely the distinction the milestone exists to draw.
- **Why not reconnect everything uniformly:** driving a reconnect loop over a client that already
  reconnects produces duplicate connections and duplicate consumer groups. The probed table is the
  reason the modes differ, and getting this from memory would have shipped exactly that bug.
- **Test home:** `messaging-plugin/test/unit/brokers/reconnect.test.ts` for the supervisor;
  per-broker fault-injection tests that drive the listener path; and the real-outage suite (§3.7).

### 3.6 Service discovery: "never reached the backend" is a distinct, reportable state

- **Decision:** `ServiceDiscoveryService` gains `#everResolved` (set on the first successful
  provider read) alongside the existing `#degraded`, plus an `isHealthy()` that runs the §3.4 probe.
  The indicator maps: never resolved and probe failing → `down`; `#degraded` (serving from a stale
  cache) → `degraded`; probe failing but cache warm → `degraded`; otherwise `up`. `data` gains
  `reachable` and `everResolved`.
- **Why:** the comment at `service-discovery-plugin.ts:96` argues `down` is unreachable because "the
  caller already received a `DiscoveryUnavailableError`". Its premise is false (`#degraded` is set
  only at `service-discovery-service.ts:189`, after a prior success), and its reasoning is the thing
  to fix: the caller is one route answering `500`, while probes, alerts and rolling-deploy gates all
  read `/health`.
- **Test home:** `service-discovery-plugin/test/unit/plugin/health-indicator.test.ts`, including the
  X10-3 case — a provider that has never once succeeded reports `down`.

### 3.7 The bar: a real backend, stopped

- **Decision:** each of the six packages gets an outage test that drives a **real** backend through
  a **real** stop and restart, guarded on an env var and wired into CI's service containers on the
  M53 pattern: Redis (already a CI service) covers redis-streams, the Redis backplane and
  `RedisQueue`; a new `rabbitmq:3-management` service covers the `drive`-mode reconnect and
  `RabbitMqQueue`; MinIO covers `S3Provider`; Mailpit covers `SmtpProvider`. Each asserts the
  sequence **`up` → (stop) `down` → (restart) `up`**, and for RabbitMQ additionally that a
  subscription established before the outage receives a message published after it.
- **Why:** X2-1, X3-2 and X8-5 all state that no test using a fake can catch this — "every broker
  test injects a client fake that never dies, so the state `#ready` fails to describe cannot be
  constructed". A milestone about truthful health signals whose only evidence is a fake would be the
  defect it is fixing.
- **CI-wiring discipline (M53):** the enforcement is `test/apps-gate.test.ts`, which pins the
  service, the port mapping and the env var in **both** workflows, as it already does for Redis — so
  a dropped service container or a missing env var fails the gate instead of quietly skipping.
  _(Correction, made during code review: an earlier draft of this plan said these suites are "not
  added to `ALLOW_SKIP`". That is a category error — `ALLOW_SKIP` is read only by
  `scripts/check-apps.ts` and governs `apps/`, never a package's integration tests. The suites do
  skip locally on a missing env var; the apps-gate pin is what makes that safe.)_
- **Test home:** `<pkg>/test/integration/outage-real.test.ts` per package.

### 3.8 X3-7: the report projects, it does not spread

- **Decision:** `HealthService.#runIndicators` builds `checks[name]` as
  `{ status, ...(data !== undefined && { data }), latencyMs }` instead of
  `{ ...result, latencyMs }`.
- **Why:** excess-property checking does not survive `Promise.resolve({...})` at a generic call, so
  a typo'd `details` type-checks and is then published on what is often the least protected endpoint
  in the deployment. Projecting turns the typo into a visible omission and bounds what `/health`
  exposes.
- **`exactOptionalPropertyTypes` is on**, so `data` is conditionally spread and never assigned
  `undefined`.
- **Test home:** `health-plugin/test/unit/services/health-service.test.ts` — an indicator returning
  an undeclared field, asserted absent from the report while `status`/`data`/`latencyMs` survive.

### 3.9 The audit is a deliverable, and it is bounded

- **Decision:** the PR commits `docs/health-indicators.md`, a table classifying **every**
  `ctx.health.register` call in the repository (26 real registration sites at the time of writing —
  `grep -rn "ctx\.health\.register(" packages/*/src`, excluding the one inside a CLI schematic's
  template string) as `live-state`, `justified-literal` (with the justification, e.g.
  `cloudflare-plugin`'s billed binding read) or `configuration-literal`. Sites in the six in-scope
  packages are fixed here. Sites outside them that classify as `configuration-literal` —
  `cache-plugin`, `database-plugin`, `audit-plugin`, `notification-plugin`, and
  `worker-pool-plugin`'s own hardcoded `status: 'up'` beside its live `data` — are **recorded as new
  rows in `smoke/DEFECTS.md`** and are not changed on this branch.
- **Why:** the register asked for the audit and warned "the same reasoning will be sitting in the
  other five". Producing the inventory is the cheap half and is what stops this recurring; fixing
  packages outside the milestone's stated list would be the unilateral scope widening this repo's
  own conventions warn against. Recording rows keeps them from being lost.
- **Test home:** `test/health-indicator-audit.test.ts` — asserts every `ctx.health.register` site in
  `packages/*/src` appears in the document, so a new indicator cannot be added unclassified.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                   | Kind              | Consumer / real code path that READS it                                                                                                                      |
| --------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createCachedProbe` (`common`)                                                    | function          | Every `isHealthy` implementation in the six packages (§3.4) builds its probe through it.                                                                     |
| `CachedProbeOptions` (`common`)                                                   | type              | The parameter type of `createCachedProbe`; named by each caller that builds an options object.                                                               |
| `IMessageBroker.isHealthy?` (`common`)                                            | interface member  | `messaging-plugin`'s indicator (`messaging-plugin.ts`) and `MessagingBackplane` (§3.1) — the only way the backplane can delegate without importing a plugin. |
| `IRealtimeBackplane.isHealthy?` (`common`)                                        | interface member  | `realtime-backplane-plugin`'s indicator.                                                                                                                     |
| `StorageProvider.isHealthy?`                                                      | interface member  | `storage-plugin.ts` indicator.                                                                                                                               |
| `MailProvider.isHealthy?`                                                         | interface member  | `mail-plugin.ts` indicator.                                                                                                                                  |
| `QueueAdapter.isHealthy?`                                                         | interface member  | `QueueService.createHealthIndicator()`.                                                                                                                      |
| `DiscoveryProvider.isHealthy?`                                                    | interface member  | `ServiceDiscoveryService.isHealthy()`, read by the plugin indicator (§3.6).                                                                                  |
| Client-facade `isHealthy?`/`ping?`/`status?`/`on?`/`verify?` members (§3.4 table) | interface members | Each is read by the named provider/broker's probe or fault listener; the §3.4 table is the mapping, and §6 gives each a test.                                |
| `ReconnectSupervisor`                                                             | class             | **Internal to `messaging-plugin` — NOT barrel-exported.** Consumed by the four self-managed brokers.                                                         |

No new capability token. No new plugin option. Nothing in this milestone is configurable, which is
deliberate: an application cannot opt out of a truthful health signal, and the two knobs that could
plausibly exist (probe TTL and timeout) have defaults chosen in §3.3 and are revisited only if a
real deployment needs them — a dead option is the defect §4 exists to prevent.

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)                                                                                                                                                                                           |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked) | —        | No plugin option is added or changed. `CachedProbeOptions` is a function parameter, not user-facing configuration; its fields are all read by `createCachedProbe` itself (§3.3), and its two defaults are stated there. |

## 5. Implementation files

| File                                                                                                               | Purpose                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `packages/common/src/health/probe.ts`                                                                              | **New.** Pure `createCachedProbe` (§3.3).                                                        |
| `packages/common/src/services/messaging.ts`                                                                        | `IMessageBroker.isHealthy?`.                                                                     |
| `packages/common/src/services/realtime.ts`                                                                         | `IRealtimeBackplane.isHealthy?`.                                                                 |
| `packages/common/src/index.ts`                                                                                     | Barrel: `createCachedProbe`, `CachedProbeOptions`.                                               |
| `packages/health-plugin/src/services/health-service.ts`                                                            | Project to `{ status, data }` (§3.8).                                                            |
| `packages/messaging-plugin/src/brokers/reconnect.ts`                                                               | **New.** `ReconnectSupervisor` (§3.5).                                                           |
| `packages/messaging-plugin/src/brokers/{in-memory,redis-streams,rabbitmq,nats,kafka,pubsub,service-bus}-broker.ts` | `isHealthy` per §3.4; reconnect mode per §3.5.                                                   |
| `packages/messaging-plugin/src/brokers/custom-adapter.ts`                                                          | Delegating `isHealthy`.                                                                          |
| `packages/messaging-plugin/src/brokers/message-broker.ts`                                                          | JSDoc: `isReady()` is lifecycle, `isHealthy()` is reachability (§3.2).                           |
| `packages/messaging-plugin/src/interfaces/index.ts`                                                                | Facade widenings (§3.4).                                                                         |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`                                                         | Indicator maps both signals (§3.2).                                                              |
| `packages/realtime-backplane-plugin/src/transports/{memory,messaging,redis}-backplane.ts`                          | `isHealthy` per §3.4.                                                                            |
| `packages/realtime-backplane-plugin/src/transports/backplane-factory.ts`                                           | `'custom'` arm delegation.                                                                       |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                                                       | `IRedisBackplaneClient` widening (§3.4).                                                         |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`                                       | Replace the literal; a fan-out failure is `degraded` (local delivery still works), never `down`. |
| `packages/storage-plugin/src/providers/{memory,local,s3,gcs,azure}-provider.ts`                                    | `isHealthy` per §3.4.                                                                            |
| `packages/storage-plugin/src/interfaces/index.ts`                                                                  | `StorageProvider.isHealthy?` + facade widenings.                                                 |
| `packages/storage-plugin/src/plugin/storage-plugin.ts`                                                             | Indicator.                                                                                       |
| `packages/mail-plugin/src/providers/{log,smtp,ses,sendgrid}-provider.ts`                                           | `isHealthy` per §3.4.                                                                            |
| `packages/mail-plugin/src/interfaces/index.ts`                                                                     | `MailProvider.isHealthy?` + `ISmtpTransport.verify?`, `ISesClient.isHealthy?`.                   |
| `packages/mail-plugin/src/plugin/mail-plugin.ts`                                                                   | Indicator.                                                                                       |
| `packages/queue-plugin/src/adapters/{memory,redis,rabbitmq,sqs}-queue.ts`                                          | `isHealthy` per §3.4.                                                                            |
| `packages/queue-plugin/src/adapters/queue-adapter.ts`                                                              | `QueueAdapter.isHealthy?`.                                                                       |
| `packages/queue-plugin/src/services/queue-service.ts`                                                              | `createHealthIndicator` maps both signals.                                                       |
| `packages/service-discovery-plugin/src/providers/{static,consul,kubernetes,dns}-provider.ts`                       | `isHealthy` per §3.4.                                                                            |
| `packages/service-discovery-plugin/src/interfaces/index.ts`                                                        | `DiscoveryProvider.isHealthy?`.                                                                  |
| `packages/service-discovery-plugin/src/services/service-discovery-service.ts`                                      | `#everResolved` + `isHealthy()` (§3.6).                                                          |
| `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts`                                         | Indicator; delete the false comment (C2).                                                        |
| `packages/grpc-plugin/src/health/grpc-health-bridge.ts`                                                            | `degraded → 'not-serving'` + corrected rationale (C1).                                           |
| `docs/deployment.md`, `docs/health-indicators.md`, `PUBLIC_API.md`, `CHANGELOG.md`, six package READMEs            | C1–C5, §3.9.                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                          | src covered                                     | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/health/probe.test.ts`                                            | `common/src/health/probe.ts`                    | Against `createCachedProbe(opts: CachedProbeOptions): () => Promise<boolean>`: cached within TTL (one probe call for N reads), re-probed after TTL via a fake monotonic `hrtime`, two concurrent callers coalesce to one probe, a probe exceeding `timeoutMs` yields `false`, a rejecting probe yields `false` and does not escape.                         |
| `common/test/unit/contracts.test.ts`                                               | `services/messaging.ts`, `services/realtime.ts` | A structural implementor **omitting** `isHealthy` still satisfies `IMessageBroker`/`IRealtimeBackplane` (compile-level, so the widening is proven non-breaking), and one implementing it type-checks against `() => Promise<boolean>`.                                                                                                                      |
| `health-plugin/test/unit/services/health-service.test.ts`                          | `services/health-service.ts`                    | An indicator returning `{ status, details, latencyMs }` produces a report entry with **no** `details` and no caller-supplied `latencyMs`; `data` survives when present and the key is **absent** (not `undefined`) when omitted; `worstStatus` unchanged.                                                                                                   |
| `messaging-plugin/test/unit/brokers/reconnect.test.ts`                             | `brokers/reconnect.ts`                          | Against `ReconnectSupervisor`: backoff sequence under a fake `setTimeout` (full-jitter bounds), replay invokes the registry's re-subscribe per entry, a reconnect failing mid-loop retries rather than terminating, `stop()` cancels a pending attempt and removes every listener (the M47/M50 listener-accumulation class: N cycles → N added, N removed). |
| `messaging-plugin/test/unit/brokers/<broker>-health.test.ts` (×8)                  | each broker + `custom-adapter.ts`               | Four arms per §3.2: not started → `down`; probe true → `up`; probe false/timeout → `down`; facade without the optional member → `unknown`. `drive`-mode brokers additionally: an injected `'close'` event flips `isHealthy` to `false` while `isReady()` stays `true`, and replay re-subscribes every `#activeConsumers` entry.                             |
| `messaging-plugin/test/unit/plugin/messaging-plugin.test.ts`                       | `plugin/messaging-plugin.ts`                    | The indicator's four arms and that `data` carries `broker` plus `reachable`.                                                                                                                                                                                                                                                                                |
| `messaging-plugin/test/integration/outage-real.test.ts`                            | rabbitmq + redis-streams brokers                | §3.7: real broker, real stop/restart, `up → down → up`, and a pre-outage subscription receives a post-outage publish (the X2-1 reproduction). Guarded on `RABBITMQ_URL`/`REDIS_URL`; the apps-gate workflow pin is the enforcement.                                                                                                                         |
| `realtime-backplane-plugin/test/unit/transports/<t>-health.test.ts` (×3 + factory) | each transport, `backplane-factory.ts`          | Memory always `true`; messaging delegates to the broker's `isHealthy` and reports `unknown` when the broker omits it; redis requires **both** connections healthy (a healthy publisher with a dead subscriber is `false` — the M47 two-connection property); `'custom'` delegates or reports `unknown`.                                                     |
| `realtime-backplane-plugin/test/unit/plugin/health-indicator.test.ts`              | `plugin/realtime-backplane-plugin.ts`           | A transport reporting unreachable yields `degraded`, **never** `down` (local delivery still works, so `/ready` keeps serving — the §3.2 mapping), with `transport` and `origin` preserved in `data`.                                                                                                                                                        |
| `realtime-backplane-plugin/test/integration/outage-real.test.ts`                   | `redis-backplane.ts`                            | §3.7 against real Redis, including recovery (X3-2 recorded that this arm self-heals).                                                                                                                                                                                                                                                                       |
| `storage-plugin/test/unit/providers/<p>-health.test.ts` (×5)                       | each provider                                   | Per §3.4: local probes `stat(root)` and reports `false` when the root is removed; S3 uses the **existing** `head`; gcs/azure report `unknown` without the optional facade member.                                                                                                                                                                           |
| `storage-plugin/test/unit/plugin/storage-plugin.test.ts`                           | `plugin/storage-plugin.ts`                      | Indicator arms; `data.provider` preserved.                                                                                                                                                                                                                                                                                                                  |
| `storage-plugin/test/integration/outage-real.test.ts`                              | `s3-provider.ts`                                | §3.7 against MinIO.                                                                                                                                                                                                                                                                                                                                         |
| `mail-plugin/test/unit/providers/<p>-health.test.ts` (×4)                          | each provider                                   | Log always `true`; smtp uses `verify?()` and reports `unknown` when absent; sendgrid's probe drives the existing `IMailHttp` and treats `401` as reachable.                                                                                                                                                                                                 |
| `mail-plugin/test/unit/plugin/mail-plugin.test.ts`                                 | `plugin/mail-plugin.ts`                         | Indicator arms.                                                                                                                                                                                                                                                                                                                                             |
| `mail-plugin/test/integration/outage-real.test.ts`                                 | `smtp-provider.ts`                              | §3.7 against Mailpit.                                                                                                                                                                                                                                                                                                                                       |
| `queue-plugin/test/unit/adapters/<a>-health.test.ts` (×4)                          | each adapter                                    | Per §3.4, including `RedisQueue.ping()` — asserted through the **widened** `IRedisQueueClient`, so a fake that does not implement it reports `unknown` rather than passing vacuously (the M53 `zrangebyscore` class).                                                                                                                                       |
| `queue-plugin/test/unit/services/queue-service.test.ts`                            | `services/queue-service.ts`                     | `createHealthIndicator()` maps both signals; `data.adapter` preserved.                                                                                                                                                                                                                                                                                      |
| `queue-plugin/test/integration/outage-real.test.ts`                                | `redis-queue.ts`, `rabbitmq-queue.ts`           | §3.7.                                                                                                                                                                                                                                                                                                                                                       |
| `service-discovery-plugin/test/unit/providers/<p>-health.test.ts` (×4)             | each provider                                   | Consul probes `/v1/status/leader`; kubernetes issues a `limit=1` LIST and reports `false` on the **TLS rejection** shape X10-3 observed; dns uses `runtime.dns`; static is `true`.                                                                                                                                                                          |
| `service-discovery-plugin/test/unit/services/service-discovery-service.test.ts`    | `services/service-discovery-service.ts`         | `#everResolved` false until the first success; a stale-cache serve sets `#degraded` without setting `#everResolved` retroactively.                                                                                                                                                                                                                          |
| `service-discovery-plugin/test/unit/plugin/health-indicator.test.ts`               | `plugin/service-discovery-plugin.ts`            | **The X10-3 case**: a provider that has never resolved reports `down`, not `up`. Plus the `degraded` and `up` arms.                                                                                                                                                                                                                                         |
| `grpc-plugin/test/unit/health/grpc-health-bridge.test.ts`                          | `health/grpc-health-bridge.ts`                  | `degraded → 'not-serving'`; `up → 'serving'`; `down → 'not-serving'`; `SERVICE_UNKNOWN` for an unserved name unchanged.                                                                                                                                                                                                                                     |
| `grpc-plugin/test/integration/health-agreement.test.ts`                            | bridge + `health-plugin`                        | **The X7-8 reproduction through a real kernel app**: one process, one degraded indicator, `/ready` 503 **and** `Health/Check` `NOT_SERVING` — the two faces agreeing is the deliverable, and a unit test on the mapping alone cannot show it.                                                                                                               |
| `test/health-indicator-audit.test.ts`                                              | — (repo gate)                                   | Every `ctx.health.register` site under `packages/*/src` appears in `docs/health-indicators.md` with a classification (§3.9).                                                                                                                                                                                                                                |

**Per-file 90% bar**: every `src` file listed in §5 has a named test above. The four cloud
implementations whose probe is one external SDK call (`pubsub`, `service-bus`, `ses`, `sqs`) follow
the established rule — the branching lives in an injectable adapter unit-tested directly, and only
the single `await import('npm:…')` line sits behind a guarded real-import test.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70c-health-signals, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree; 10 packages change
deno task release:verify 0.1.0-alpha.8
deno task check:apps        # apps/realtime and apps/microservices exercise these indicators
```

Plus the evidence CLAUDE.md requires beyond the gates: the §3.7 outage suites run against real
backends with their stop/restart observed, and each fix demonstrated to **fail without it** —
`up → down → up` becomes `up → up → up` when the probe is reverted.

## 8. Risks & mitigations

- **`/health` becomes a load generator against the backends it probes.** → §3.3's cached, coalesced,
  time-bounded probe; a test asserts N reads inside the TTL issue one probe.
- **A probe's own latency stalls the health endpoint.** kubelet timeouts are typically 1s. → 2s
  probe timeout is bounded and cached, but the first uncached read on a _hung_ backend still costs
  up to 2s. Mitigated by the cache (only one request per TTL pays it) and recorded in
  `docs/health-indicators.md` so an operator setting an aggressive probe timeout knows.
- **Applications upgrade and their `/ready` starts failing.** That is the _point_, but it will look
  like a regression. → CHANGELOG entry under Changed stating plainly that an application whose
  backend is unreachable now reports `down` and fails readiness where it previously reported `up`,
  with the `data.reachable` field named for diagnosis.
- **The `drive`-mode reconnect double-connects or duplicates consumers.** → the modes are decided
  from probed client behaviour (§1/§3.5), and the RabbitMQ replay is asserted to re-subscribe each
  registry entry exactly once, with the real-outage test proving no duplicate delivery.
- **A reconnect loop accumulates one listener per attempt** — the exact defect M47 fixed in
  `resilience-plugin` and M50's review found twice in watch backoffs. → `stop()` removes every
  listener, asserted by an N-cycles add/remove count test (§6).
- **CI gains two service containers** (RabbitMQ, MinIO) and gets slower / flakier. → M53's pattern:
  job-level env, `localhost` mapped ports (a `services:` label is not a resolvable hostname for a
  job running on the runner), and the apps-gate workflow pin asserting each service so a
  silently-dropped container fails rather than silently skips.
- **A widened optional facade member is never implemented by the real adapter**, leaving the probe
  permanently `unknown` while every injected-fake test passes — the M55 `createReadStream` defect
  class exactly. → every real adapter's default path is driven once by the guarded real-import /
  real-backend test, and the §3.7 suite would report `up → up → up` if it were not.

## 9. Out of scope

- **Setting `DENO_CERT` in the Helm chart and the CLI's `k8s/members.yaml`** (X10-3 part 1) — M39
  owns deployment artifacts, M70g owns the CLI-manifest rows. This milestone makes the failure
  _visible_ (`down`) and _documented_ (C3); making the documented path work by default is theirs.
- **Logging a failed resolve's `cause`** (X10-3 part 3) — M70f owns error visibility, including its
  sibling row X7-5.
- **Fixing the `configuration-literal` indicators outside the six named packages** (`cache-plugin`,
  `database-plugin`, `audit-plugin`, `notification-plugin`, and `worker-pool-plugin`'s hardcoded
  `status`) — §3.9 classifies and files them as register rows; a follow-up milestone owns them.
- **A `tenant`-aware or per-dependency health decomposition** — M70b's "tenancy is a plugin, not a
  dimension" thread, not this one.
- **Making probe TTL/timeout configurable** — §4 declines the option until a real deployment needs
  it; a dead option is the defect §4 exists to prevent.
- **Reconnection for the queue and storage backends.** X2-1 scoped reconnect to messaging, where
  amqplib's lack of it is what left X2-1's workspace permanently broken. `RedisQueue` inherits
  ioredis's own reconnection; a storage provider holds no long-lived subscription to replay.
