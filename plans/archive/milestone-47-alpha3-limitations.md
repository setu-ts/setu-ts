# Milestone 47 — Alpha-3 Limitation Closeout (`resilience-plugin`, `feature-flags-plugin`, `websocket-plugin`, `sse-plugin`, `realtime-backplane-plugin`)

> **Status:** Planning. Branch: `feat/m47-alpha3-limitations`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Three "Known limitations" recorded in `CHANGELOG.md` for `v0.1.0-alpha.1` are closed so they do not
ship again in `v0.1.0-alpha.3`: resilience timeouts that never cancel, feature flags that cannot
talk to LaunchDarkly, and real-time rooms/channels that never leave the process. Each is a genuine
capability gap rather than a wording problem, so each is fixed in code and the CHANGELOG entry is
deleted rather than reworded. The maintainer chose a single combined branch and PR for all three
(normally one package per milestone), because the three share one release gate.

- **In scope:**
  - **A.** Real cancellation in `resilience-plugin`: the protected call receives an `AbortSignal`
    that the timeout layer aborts on deadline, that the retry layer stops looping on, that the
    bulkhead rejects queued waiters on, and that the caller can trigger from outside.
  - **B.** A `LaunchDarklyProvider` in `feature-flags-plugin` bridging LaunchDarkly's async
    evaluation onto the committed synchronous `IFeatureFlags.isEnabled`, plus a new optional
    `isEnabledAsync` on `IFeatureFlags` for callers that can await a correct answer.
  - **C.** Cross-replica fan-out for `websocket-plugin` rooms and `sse-plugin` channels, via a new
    `IRealtimeBackplane` port in `common` and a new `realtime-backplane-plugin` package supplying
    memory, messaging-backed, and Redis pub/sub transports.
  - The `CHANGELOG.md` "Known limitations" edits, and the `PUBLIC_API.md` / `ROADMAP.md` /
    `ARCHITECTURE.md` / `CLAUDE.md` updates each change requires.
- **NOT this milestone:** FCM HTTP v1 migration (`notification-plugin`, its own follow-up);
  `KafkaBroker` request-reply (permanently refused by M14c with cause); Node/Bun compat suite runs
  (Milestone 40); cutting the `v0.1.0-alpha.3` release itself (a `release/…` branch, not a
  milestone); presence/roster tracking and cross-replica room membership _counts_ (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                          | Verified surface / fact                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResilienceService`                | `packages/common/src/services/resilience.ts:137`                            | Exactly one method: `wrap<T>(fn: () => Promise<T>, options?: WrapOptions): () => Promise<T>`. No signal anywhere.                                                                                                |
| `ICircuitBreaker`                   | `packages/common/src/services/resilience.ts:29`                             | `readonly state: CircuitState`, `execute<T>(fn: () => Promise<T>): Promise<T>`.                                                                                                                                  |
| `WrapOptions`                       | `packages/common/src/services/resilience.ts:110`                            | `circuitBreaker`, `retry`, `timeout` (a plain `number`), `bulkhead`. `timeout` is documented "per-attempt".                                                                                                      |
| `runWithTimeout`                    | `packages/resilience-plugin/src/patterns/timeout.ts:26`                     | Races `fn()` against a timer; JSDoc already concedes "the underlying operation is NOT cancelled". This is the defect.                                                                                            |
| `runWithRetry`                      | `packages/resilience-plugin/src/patterns/retry.ts:45`                       | Loops `policy.limit` times; its `delayFor` helper never clears its timer and cannot be interrupted.                                                                                                              |
| `Bulkhead.run`                      | `packages/resilience-plugin/src/patterns/bulkhead.ts:46`                    | Queued waiters park on a bare `new Promise` resolver with no rejection path — a queued caller cannot be cancelled.                                                                                               |
| `ITimers`                           | `packages/resilience-plugin/src/interfaces/index.ts:16`                     | `setTimeout(fn, ms): unknown`, `clearTimeout(handle): void`. Already the injectable clock seam.                                                                                                                  |
| `IFeatureFlags`                     | `packages/common/src/services/feature-flags.ts:41`                          | One method, synchronous: `isEnabled(flag: string, context?: FlagContext): boolean`.                                                                                                                              |
| `FlagContext`                       | `packages/common/src/services/feature-flags.ts:11`                          | `userId?: string`, `attributes?: Readonly<Record<string, string \| number \| boolean>>`. Attributes are carried but unread by the built-in evaluator.                                                            |
| `FlagProvider`                      | `packages/feature-flags-plugin/src/interfaces/index.ts:52`                  | `type`, `isEnabled` (sync), `start(): Promise<void>`, `stop(): Promise<void>`, optional `status()`. The async-lifecycle-plus-sync-read shape LaunchDarkly needs already exists.                                  |
| LD `init`                           | `~/.cache/deno/npm/.../node-server-sdk/9.12.3/dist/src/index.d.ts`          | `init(sdkKey: string, options?: LDOptions): LDClient` — **synchronous**, returns the client immediately.                                                                                                         |
| LD `LDClient.initialized`           | `.../js-server-sdk-common/2.19.5/dist/api/LDClient.d.ts:28`                 | `initialized(): boolean` — **synchronous**.                                                                                                                                                                      |
| LD `LDClient.waitForInitialization` | same, `:81`                                                                 | `waitForInitialization(options?): Promise<LDClient>`; options carry `timeoutSeconds`.                                                                                                                            |
| LD `LDClient.boolVariation`         | same, `:148`                                                                | `boolVariation(key, context, defaultValue: boolean): Promise<boolean>` — **async**. Confirms the limitation is real.                                                                                             |
| LD `LDClient.allFlagsState`         | same, `:306`                                                                | `allFlagsState(context, options?, callback?): Promise<LDFlagsState>` — **async**.                                                                                                                                |
| LD `LDFlagsState`                   | `.../js-server-sdk-common/2.19.5/dist/api/data/LDFlagsState.d.ts`           | `valid: boolean`, and **synchronous** `getFlagValue(key): LDFlagValue`. This is the sync bridge: the state object is fetched async once and read sync thereafter.                                                |
| LD `LDClient.on`                    | `.../node-server-sdk/9.12.3/dist/src/api/LDClient.d.ts:50`                  | Node `EventEmitter`; documented events `ready`, `failed`, `error`, `update`, `update:KEY`. `update` carries `{ key }`. Signature uses `any[]`, so it is wrapped in a structural facade (§3.6).                   |
| LD `LDClient.close`                 | `.../js-server-sdk-common/2.19.5/dist/api/LDClient.d.ts:325`                | `close(): void` — synchronous.                                                                                                                                                                                   |
| `SseChannel`                        | `packages/common/src/services/sse.ts:87`                                    | `size`, `add`, `remove`, `publish(msg: SseMessage): void`. **No `except` option** — unlike a WS room.                                                                                                            |
| `SseMessage`                        | `packages/common/src/services/sse.ts:22`                                    | `id?`, `event?`, `data: string \| Record<string, unknown>`, `retry?`. JSON-serializable, so it crosses a backplane unchanged.                                                                                    |
| `WebSocketRoom`                     | `packages/common/src/services/websocket.ts:215`                             | `name`, `size`, `add`, `remove`, `broadcast(data: string \| Uint8Array, options?)`, `broadcastJson<T>`. `RoomBroadcastOptions.except` holds a **live connection reference**, which cannot cross a wire (§3.10).  |
| `Room` / `RoomRegistry`             | `packages/websocket-plugin/src/rooms/room-registry.ts`                      | Plain `Set` membership plus a reverse index; both exported from the plugin barrel, so their surface is public and additive-only here.                                                                            |
| `ChannelRegistry`                   | `packages/sse-plugin/src/channels/channel-registry.ts`                      | Internal (not in the SSE barrel), so it may change shape freely.                                                                                                                                                 |
| `IMessageBroker`                    | `packages/common/src/services/messaging.ts:93`                              | `connect`, `disconnect`, `publish<T>(topic, message): Promise<void>`, `subscribe<T>(topic, handler, options?): Promise<ISubscription>`, `request`, `respond`. `publish`/`subscribe` are all the backplane needs. |
| `CAPABILITIES`                      | `packages/common/src/tokens.ts:51,55,77,85,103,105`                         | `CACHE: 'cache'`, `MESSAGING: 'messaging'`, `RESILIENCE: 'resilience'`, `FEATURE_FLAGS: 'feature-flags'`, `SSE: 'sse'`, `WEBSOCKET: 'websocket'`. No realtime-backplane token exists yet.                        |
| `createCapabilityToken`             | `packages/common/src/tokens.ts:160`                                         | Rejects anything outside lowercase kebab segments joined by dots. `'realtime-backplane'` passes; a colon would not.                                                                                              |
| `IRuntimeServices`                  | `packages/common/src/runtime.ts:184-265`                                    | `platform()`, `uuid()`, `now()`, `hrtime()`, `setTimeout`/`clearTimeout`, `setInterval`/`clearInterval`, `readonly env`.                                                                                         |
| `SsePlugin` register                | `packages/sse-plugin/src/plugin/sse-plugin.ts:44`                           | `register(ctx)` is currently sync-typed as `void \| Promise<void>`; already declares `optionalDependencies: ['logger']` and a `sse` health indicator. Returning a promise is already permitted.                  |
| Cross-plugin capability use         | `packages/notification-plugin` `EmailChannel` resolving `CAPABILITIES.MAIL` | The committed precedent for one plugin consuming another's capability through the registry, which §C reuses rather than importing a plugin.                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                    | Resolution (picked side)                            | Doc deliverable (same PR)                                                                                                             |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `CHANGELOG.md:153` states resilience timeouts do not cancel; after §A they do.                                                                                                                              | Code wins — the limitation is removed.              | Delete the bullet from the `v0.1.0-alpha.1` "Known limitations" list and record the change under a new `[Unreleased]` heading.        |
| C2 | `CHANGELOG.md:146` states LaunchDarkly is unsupported; after §B it is supported with documented cold-read semantics.                                                                                        | Code wins.                                          | Same treatment as C1, with the cold-read caveat stated in the `PUBLIC_API.md` Feature Flags Notes rather than left as a "limitation". |
| C3 | `CHANGELOG.md:151` and `PUBLIC_API.md:1621` both state rooms/channels are in-process, with `PUBLIC_API.md` promising "a follow-up milestone".                                                               | Code wins; this milestone _is_ that follow-up.      | Delete the CHANGELOG bullet; rewrite the `PUBLIC_API.md` WebSocket note to describe the backplane and its `except`/size caveats.      |
| C4 | `packages/resilience-plugin/src/patterns/timeout.ts:14-17` JSDoc asserts the call is not cancelled — that becomes a lie the moment §A lands.                                                                | Rewrite the JSDoc alongside the code.               | JSDoc correction in the same commit as the implementation.                                                                            |
| C5 | `CLAUDE.md` "Current status" M31 entry states LaunchDarkly "was deferred" because no provider can satisfy sync `isEnabled` without widening `common`. §B widens `common`, so the stated blocker is removed. | Record the resolution rather than deleting history. | Amend the M31 status entry to point at M47, and add the M47 entry.                                                                    |
| C6 | `ARCHITECTURE.md` Rules-engine row and the `ROADMAP.md` M31 provider list both dropped LaunchDarkly during M31.                                                                                             | Restore it, now that it ships.                      | Re-add LaunchDarkly to both, naming the provider and the async caveat.                                                                |

## 3. Design decisions

### 3.1 How the protected call receives its cancellation signal

- **Decision:** Widen the committed contract to
  `wrap<T>(fn: ResilientCall<T>, options?: WrapOptions): HardenedCall<T>`, with two new exported
  types in `common`: `ResilientCall<T> = (signal: AbortSignal) => Promise<T>` and
  `HardenedCall<T> = (signal?: AbortSignal) => Promise<T>`. `ICircuitBreaker.execute` is widened to
  `execute<T>(fn: ResilientCall<T>): Promise<T>` for consistency.
- **Why:** A parameter added to a _callback_ type is backward compatible for **callers**: every
  existing `resilience.wrap(() => api.call())` still type-checks, because a function accepting fewer
  parameters is assignable to one accepting more. Making the returned callable's parameter optional
  keeps `await guarded()` working and lets the result still be assigned to a `() => Promise<T>`
  variable.
- **Compatibility limit (verified against the compiler, not assumed):** it is **not** source
  compatible for **implementors**. `fn` sits in a contravariant position, so an object literal
  declaring `wrap<T>(fn: () => Promise<T>)` no longer satisfies `IResilienceService`, and the same
  applies to `ICircuitBreaker.execute`. `deno check` located every affected declaration in the repo:
  exactly two structural test doubles in `packages/common/test/unit/index.test.ts`, both updated
  here. Since the framework is pre-1.0 and the only implementors are the plugin itself plus test
  doubles, this is accepted rather than worked around — an approach preserving implementor
  compatibility would have to keep the un-cancellable overload alive, which is the defect being
  fixed. It ships as a named "breaking for implementors" note in `CHANGELOG.md`.
- **Test home:** `test/unit/resilience-service.test.ts` — "accepts a zero-argument protected call"
  and "returns a callable invocable with no argument", both compiled against the widened signature;
  plus the caller-compatibility assertions added to `packages/common/test/unit/index.test.ts`.

### 3.2 What aborts the signal, and with what reason

- **Decision:** One `AbortController` is created per _attempt_, inside `runWithTimeout`. Its signal
  is aborted with a `TimeoutError` instance as the abort reason when the deadline elapses. When the
  caller passes an outer signal to the hardened callable, that outer signal is linked: an outer
  abort propagates to the per-attempt controller with the outer signal's own `reason`. When no
  `timeout` is configured, the outer signal is passed through unwrapped, and when neither exists the
  call receives a never-aborted signal from a controller created once per invocation.
- **Why:** `timeout` is documented as per-attempt, so the controller's lifetime must match an
  attempt, not the whole retry sequence — otherwise attempt 2 would start pre-aborted. Using
  `TimeoutError` as the abort reason means a call that inspects `signal.reason` sees the same error
  type it would have caught, so there is exactly one error identity for a timeout.
- **Test home:** `test/unit/timeout.test.ts` — "aborts the signal with a TimeoutError reason",
  "links an outer abort through to the protected call", and "gives each retry attempt a fresh,
  unaborted signal".

### 3.3 Signal cleanup

- **Decision:** Every outer-signal `abort` listener is registered with `{ once: true }` and removed
  in a `finally`, and the deadline timer keeps its existing `finally` clear. A
  `linkAbort(outer,
  controller)` helper in a new `patterns/abort.ts` owns both halves and returns
  its own disposer.
- **Why:** A long-lived caller signal accumulating one listener per wrapped invocation is a leak of
  exactly the kind §14.5 forbids, and it is invisible in tests that only assert the happy path.
- **Test home:** `test/unit/abort.test.ts` — "removes its listener from the outer signal once the
  call settles", asserted by driving the same outer signal through many invocations and checking the
  protected calls stop being notified after each settles.

### 3.4 Retry stops on abort

- **Decision:** `runWithRetry` takes the outer signal, checks it before each attempt, and rejects
  immediately with the signal's `reason` when it is already aborted. Its backoff `delayFor` becomes
  interruptible: the sleep resolves early on abort and always clears its timer handle.
- **Why:** A cancelled operation that keeps sleeping and retrying for another three attempts has not
  been cancelled. The existing `delayFor` also leaks its handle unconditionally, which this fixes.
- **Test home:** `test/unit/retry.test.ts` — "stops retrying once the outer signal aborts" and
  "clears the backoff timer when interrupted".

### 3.5 Bulkhead rejects queued waiters on abort

- **Decision:** A queued waiter parks on a promise with both a resolver and a rejecter; an abort
  while queued removes it from the FIFO and rejects with the signal's `reason`. A slot is never
  consumed by an aborted waiter.
- **Why:** Otherwise a cancelled request still occupies queue depth and eventually runs its
  protected call, which is precisely the "keeps running" defect the CHANGELOG describes, relocated
  from the timeout layer to the queue.
- **Test home:** `test/unit/bulkhead.test.ts` — "rejects a queued waiter when its signal aborts" and
  "does not run the protected call for an aborted waiter".

### 3.6 How the LaunchDarkly client is loaded and typed

- **Decision:** The inject-or-lazy seam established by M25/M29: an exported structural facade
  `ILaunchDarklyClient` (only the six members §1 verified — `initialized`, `waitForInitialization`,
  `boolVariation`, `allFlagsState`, `on`, `close`), a pure `adaptLaunchDarklyModule(module)` that
  maps a supplied SDK module onto it, and a one-line `loadLaunchDarklyModule()` performing a real
  `await import('npm:@launchdarkly/node-server-sdk@^9')`. Options accept an already-constructed
  client for injection.
- **Why:** The SDK's `on` is typed `(...args: any[]) => void`; §5.2 permits `any` only at an
  external-library boundary and requires it be wrapped immediately. The facade is that wrapper, and
  it keeps the provider unit-testable with a fake module while the real import stays exercised by
  one guarded test (§6).
- **Test home:** `test/unit/launchdarkly-module.test.ts` for `adaptLaunchDarklyModule` branches;
  `test/integration/launchdarkly-real-import.test.ts` (guarded) for `loadLaunchDarklyModule`.

### 3.7 What synchronous `isEnabled` returns for LaunchDarkly

- **Decision:** The provider keeps a `Map<contextKey, LDFlagsState>` snapshot cache, keyed by
  `context?.userId ?? '__anonymous__'`. `isEnabled` reads the cached state's synchronous
  `getFlagValue(flag)` and coerces it to boolean. On a cache miss it returns the configured
  `fallbackValue` (default `false`) and schedules a background `allFlagsState` refill for that
  context; a subsequent call for the same context is answered from the real snapshot. `start()`
  prewarms the anonymous context, and an `update` event clears the whole cache.
- **Why:** LaunchDarkly evaluates locally against a streamed ruleset, so a snapshot is genuinely
  fresh; only the _first_ read for a previously-unseen user is uninformed. This is the only honest
  bridge to a synchronous contract, and it is bounded, documented, and observable.
- **Test home:** `test/unit/launchdarkly-provider.test.ts` — "returns the fallback on a cold context
  and refills in the background", "answers from the snapshot on the second call", "clears the cache
  on an update event".

### 3.8 The async escape hatch

- **Decision:** Add an **optional**
  `isEnabledAsync?(flag: string, context?: FlagContext):
  Promise<boolean>` to the committed
  `IFeatureFlags`, and an optional member of the same name to the plugin's `FlagProvider` port.
  `FeatureFlagService.isEnabledAsync` delegates to the provider's implementation when present and
  otherwise resolves `this.isEnabled(...)`, so both entry points funnel through one evaluation path
  per provider.
- **Why:** An optional interface member is additive, so no existing implementor breaks (§9.1). It
  gives correctness-critical callers a path with no cold-read caveat, and it is the member the
  LaunchDarkly provider implements with a direct `boolVariation` call.
- **Test home:** `test/unit/feature-flags-service.test.ts` — "resolves isEnabledAsync through the
  provider when it implements it" and "falls back to the sync evaluation when it does not", plus the
  mandatory both-entry-points-under-non-default-config test asserting identical output.

### 3.9 Where the backplane lives

- **Decision:** The port (`IRealtimeBackplane`, `RealtimeFrame`) is declared in
  `packages/common/src/services/realtime.ts` with a new
  `CAPABILITIES.REALTIME_BACKPLANE = 'realtime-backplane'` token. The implementations ship as a new
  plugin package, `@hono-enterprise/realtime-backplane-plugin`, which registers one under that
  token. `websocket-plugin` and `sse-plugin` each resolve the token _optionally_ and degrade to
  today's purely in-process behavior when it is absent.
- **Why:** §2.1 forbids runtime behavior in `common`, so the Redis and messaging adapters cannot
  live there; §3.3 forbids a plugin importing another plugin, so they cannot live in one of the two
  consumers. A capability-token plugin is the framework's own answer to "two plugins need the same
  service", and it is exactly the notification→mail precedent verified in §1. `'realtime-backplane'`
  passes the token grammar checked in §1.
- **Test home:** `packages/realtime-backplane-plugin/test/integration/plugin.test.ts` registers it
  in a kernel app and resolves the token;
  `packages/websocket-plugin/test/unit/room-registry.test.ts` asserts a room works unchanged with no
  backplane present.

### 3.10 Loop prevention and what does not cross the wire

- **Decision:** Every backplane instance owns an `origin` string from `runtime.uuid()`, stamped on
  each published `RealtimeFrame`. A subscriber drops any frame whose `origin` equals its own. A
  frame arriving from a remote origin is delivered to local members **without** being re-published.
  `RoomBroadcastOptions.except` is applied on the originating node only, and `Room.size` /
  `SseChannel.size` keep reporting **local** membership.
- **Why:** Without an origin stamp a two-node cluster echoes every frame forever. `except` names a
  live in-process connection object with no cross-process identity, so honoring it remotely is not
  expressible; reporting a cluster-wide `size` would require a presence protocol, which §9 defers.
  Both caveats are documented rather than silently approximated.
- **Test home:** `packages/realtime-backplane-plugin/test/unit/memory-backplane.test.ts` — "drops a
  frame it published itself"; `packages/websocket-plugin/test/integration/backplane.test.ts` — "a
  remote frame reaches local members exactly once and is not re-published".

### 3.11 Binary frame encoding across the backplane

- **Decision:** `RealtimeFrame.data` is always a `string`. A `Uint8Array` WebSocket payload is
  base64-encoded and flagged with `binary: true`; the receiving side decodes it back to a
  `Uint8Array` before local delivery. Encoding and decoding live in one exported pure pair in the
  backplane package.
- **Why:** The three transports (memory, `IMessageBroker`, Redis pub/sub) agree only on
  JSON-serializable payloads; `IMessageBroker.publish<T>` hands the payload to a serializer, and
  Redis pub/sub carries strings. A single encoded representation keeps all three honest instead of
  each inventing one.
- **Test home:** `test/unit/frame-codec.test.ts` — round-trips text and binary, and asserts the
  base64 output literally for a known byte sequence.

### 3.12 Redis pub/sub needs two connections

- **Decision:** `RedisBackplane` uses two clients: a dedicated subscriber and a separate publisher.
  When a client is injected, a `subscriber` client must be injected alongside it; when the lazy
  `npm:ioredis@5.x` path is used, the second is produced by the driver's own `duplicate()`.
- **Why:** A Redis connection in subscriber mode refuses every command other than (un)subscribe, so
  publishing over the subscribed client fails at runtime. This is a property of the protocol, not of
  `ioredis`, and getting it wrong would pass every unit test against a fake.
- **Test home:** `test/unit/redis-backplane.test.ts` — "publishes on the publisher client, never the
  subscriber" and "rejects at construction when a client is injected without a subscriber".

### 3.13 Backplane lifecycle

- **Decision:** `RealtimeBackplanePlugin.register` is `async` and awaits the transport's
  `connect()`. The websocket and SSE plugins subscribe during their own `register` (also `async`),
  and each unsubscribes in its existing `onClose`. The backplane plugin's own `onClose` closes the
  transport.
- **Why:** The kernel genuinely awaits an async `register` (the M31 precedent), so a subscription is
  live before the first request. Teardown must be split this way because the backplane may outlive
  neither consumer: each consumer owns its own subscription handle.
- **Test home:** `packages/realtime-backplane-plugin/test/integration/plugin.test.ts` — "connects
  during register and closes on app shutdown".

### 3.14 Default transport

- **Decision:** `RealtimeBackplanePlugin()` with no `transport` uses `'memory'`, which is a real
  single-process implementation and not a no-op. `'messaging'` resolves `CAPABILITIES.MESSAGING` and
  throws during `register` when it is absent. `'redis'` and `'custom'` are the remaining arms of a
  union discriminated on `transport`.
- **Why:** A silent no-op default would let an application believe it had cross-replica fan-out when
  it had none. Failing fast on a missing `messaging` capability follows the M30 rule that a
  misconfigured channel throws at registration rather than per request.
- **Test home:** `test/unit/backplane-factory.test.ts` — one case per arm, including the
  missing-capability throw.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                           | Kind             | Consumer / real code path that READS it                                                                                                         |
| ------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResilientCall<T>` (common)                                               | type             | The `fn` parameter of `IResilienceService.wrap` and `ICircuitBreaker.execute`; read by `ResilienceService.wrap` and every pattern in the chain. |
| `HardenedCall<T>` (common)                                                | type             | The return type of `wrap`; read by callers passing an outer signal, and by `sdk`-style consumers assigning it to a variable.                    |
| `IFeatureFlags.isEnabledAsync?` (common)                                  | interface member | Implemented by `FeatureFlagService`; called by application code and by the guard path's async variant.                                          |
| `IRealtimeBackplane` (common)                                             | interface        | Resolved by `websocket-plugin` and `sse-plugin` from the registry; implemented by all four transports.                                          |
| `RealtimeFrame` (common)                                                  | interface        | The payload published and received by every transport and both consumers.                                                                       |
| `CAPABILITIES.REALTIME_BACKPLANE` (common)                                | token            | Registered by `RealtimeBackplanePlugin`; read by both consumer plugins' optional resolution.                                                    |
| `RealtimeBackplanePlugin`                                                 | factory fn       | Registered in an application's plugin list; the package's entry point.                                                                          |
| `MemoryBackplane`                                                         | class            | The default transport built by `createBackplane`; also the fixture both consumer plugins' integration tests drive.                              |
| `MessagingBackplane`                                                      | class            | Built by `createBackplane` for `transport: 'messaging'`.                                                                                        |
| `RedisBackplane`                                                          | class            | Built by `createBackplane` for `transport: 'redis'`.                                                                                            |
| `createBackplane`                                                         | factory fn       | Called by `RealtimeBackplanePlugin.register`; exported so an application can build a transport for `transport: 'custom'` composition.           |
| `encodeFrameData` / `decodeFrameData`                                     | pure fns         | Called by `Room.broadcast` (encode) and the websocket subscriber (decode); exported so a custom transport can honor the same wire shape.        |
| `RealtimeBackplanePluginOptions` and its four arms                        | types            | The plugin factory's parameter.                                                                                                                 |
| `IRedisBackplaneClient`                                                   | interface        | The injection facade for `transport: 'redis'`.                                                                                                  |
| `LaunchDarklyProvider`                                                    | class            | Built by `createProvider` for the `'launchdarkly'` arm; exported so an application may compose it under the `'custom'` arm.                     |
| `adaptLaunchDarklyModule`                                                 | pure fn          | Called by `LaunchDarklyProvider` when a module is injected.                                                                                     |
| `loadLaunchDarklyModule`                                                  | fn               | Called by `LaunchDarklyProvider.start` when no client and no module were injected.                                                              |
| `ILaunchDarklyClient` / `ILaunchDarklyModule` / `ILaunchDarklyFlagsState` | interfaces       | The injection facades; read by the provider and by `adaptLaunchDarklyModule`.                                                                   |
| `LaunchDarklyProviderOptions`                                             | type             | New arm of the `FeatureFlagsPluginOptions` union.                                                                                               |

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                | Behavior (per implementation)                                                                                                                     |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `launchdarkly.sdkKey`                    | `LaunchDarklyProvider.start`            | Passed to `init`. Required unless `client` is injected; a missing key with no client throws at `register`.                                        |
| `launchdarkly.client`                    | `LaunchDarklyProvider.start`            | An already-built `ILaunchDarklyClient`; when present, no module is loaded and `sdkKey` is unread.                                                 |
| `launchdarkly.module`                    | `LaunchDarklyProvider.start`            | An SDK module passed through `adaptLaunchDarklyModule`; the unit-test seam that avoids a real import.                                             |
| `launchdarkly.fallbackValue`             | `LaunchDarklyProvider.isEnabled`        | The value returned on a cold-context cache miss and as `boolVariation`'s default. Defaults to `false`.                                            |
| `launchdarkly.initTimeoutSeconds`        | `LaunchDarklyProvider.start`            | Passed to `waitForInitialization`. Defaults to `5`. A timeout is logged and tolerated, leaving the provider degraded rather than failing `start`. |
| `launchdarkly.ldOptions`                 | `LaunchDarklyProvider.start`            | Forwarded verbatim as `init`'s second argument.                                                                                                   |
| `backplane.transport`                    | `createBackplane`                       | Discriminant selecting the arm; defaults to `'memory'`.                                                                                           |
| `backplane.topic`                        | every transport's `publish`/`subscribe` | The broker topic / Redis channel name. Defaults to `'hono-enterprise.realtime'`.                                                                  |
| `backplane.redis.client` / `.subscriber` | `RedisBackplane`                        | Injected `ioredis`-shaped clients; both required together (§3.12).                                                                                |
| `backplane.redis.url`                    | `RedisBackplane`                        | Used only on the lazy-load path to construct the pair.                                                                                            |
| `backplane.custom.instance`              | `createBackplane`                       | A caller-supplied `IRealtimeBackplane` returned as-is.                                                                                            |

## 5. Implementation files

| File                                                                         | Purpose                                                                          |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/common/src/services/resilience.ts`                                 | Add `ResilientCall`, `HardenedCall`; widen `wrap` and `ICircuitBreaker.execute`. |
| `packages/common/src/services/feature-flags.ts`                              | Add optional `isEnabledAsync` to `IFeatureFlags`.                                |
| `packages/common/src/services/realtime.ts`                                   | New: `IRealtimeBackplane`, `RealtimeFrame`.                                      |
| `packages/common/src/tokens.ts`                                              | Add `REALTIME_BACKPLANE`.                                                        |
| `packages/common/src/index.ts`                                               | Barrel the three additions.                                                      |
| `packages/resilience-plugin/src/patterns/abort.ts`                           | New: `linkAbort`, `createAttemptController`, `throwIfAborted`.                   |
| `packages/resilience-plugin/src/patterns/timeout.ts`                         | Abort the per-attempt controller on deadline; rewrite the JSDoc (C4).            |
| `packages/resilience-plugin/src/patterns/retry.ts`                           | Abort-aware loop and interruptible, handle-clearing backoff.                     |
| `packages/resilience-plugin/src/patterns/bulkhead.ts`                        | Rejectable queued waiters.                                                       |
| `packages/resilience-plugin/src/patterns/circuit-breaker.ts`                 | Thread the signal through `execute`.                                             |
| `packages/resilience-plugin/src/services/resilience-service.ts`              | Build the chain around a per-invocation signal; return a `HardenedCall`.         |
| `packages/feature-flags-plugin/src/providers/launchdarkly-provider.ts`       | New provider (§3.6, §3.7).                                                       |
| `packages/feature-flags-plugin/src/providers/launchdarkly-module.ts`         | New: facades, `adaptLaunchDarklyModule`, `loadLaunchDarklyModule`.               |
| `packages/feature-flags-plugin/src/services/feature-flags-service.ts`        | Add `isEnabledAsync` delegation (§3.8).                                          |
| `packages/feature-flags-plugin/src/interfaces/index.ts`                      | Optional `isEnabledAsync` on `FlagProvider`; new options arm.                    |
| `packages/feature-flags-plugin/src/plugin/feature-flags-plugin.ts`           | New `'launchdarkly'` arm in `createProvider`.                                    |
| `packages/feature-flags-plugin/src/index.ts`                                 | Barrel the new exports.                                                          |
| `packages/realtime-backplane-plugin/src/index.ts`                            | New package barrel.                                                              |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts` | Plugin factory, health indicator, `onClose`.                                     |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                 | Options union and client facades.                                                |
| `packages/realtime-backplane-plugin/src/transports/memory-backplane.ts`      | In-process transport (default).                                                  |
| `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`   | `IMessageBroker`-backed transport.                                               |
| `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`       | Redis pub/sub transport, two clients.                                            |
| `packages/realtime-backplane-plugin/src/transports/redis-module.ts`          | `adaptRedisModule` / `loadRedisModule` seam.                                     |
| `packages/realtime-backplane-plugin/src/transports/backplane-factory.ts`     | `createBackplane` union dispatch.                                                |
| `packages/realtime-backplane-plugin/src/codec/frame-codec.ts`                | `encodeFrameData` / `decodeFrameData`.                                           |
| `packages/realtime-backplane-plugin/deno.json`, `README.md`                  | Workspace member and package docs.                                               |
| `packages/websocket-plugin/src/rooms/room-registry.ts`                       | Publish local broadcasts; deliver remote frames locally.                         |
| `packages/websocket-plugin/src/plugin/websocket-plugin.ts`                   | Optionally resolve the backplane, subscribe, unsubscribe on close.               |
| `packages/sse-plugin/src/channels/channel-registry.ts`                       | Same for channels.                                                               |
| `packages/sse-plugin/src/plugin/sse-plugin.ts`                               | Same wiring as the websocket plugin.                                             |
| `packages/sse-plugin/src/services/sse-service.ts`                            | Thread the backplane into the registry.                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resilience-plugin/test/unit/abort.test.ts`                              | `patterns/abort.ts`                   | `linkAbort(outer, controller)` propagates reason; disposer removes the listener; `throwIfAborted` rejects with `signal.reason`. Calls type-check against `linkAbort(signal: AbortSignal, c: AbortController): () => void`.                                                                                                                                      |
| `resilience-plugin/test/unit/timeout.test.ts`                            | `patterns/timeout.ts`                 | Deadline aborts with a `TimeoutError` reason; the protected call observes `signal.aborted`; timer cleared on the success path; outer abort links through. Against `runWithTimeout<T>(fn: ResilientCall<T>, ms: number, timers: ITimers, outer?: AbortSignal)`.                                                                                                  |
| `resilience-plugin/test/unit/retry.test.ts`                              | `patterns/retry.ts`                   | Fresh unaborted signal per attempt; loop stops once the outer signal aborts; backoff timer cleared when interrupted; `computeBackoffMs` fixed and exponential.                                                                                                                                                                                                  |
| `resilience-plugin/test/unit/bulkhead.test.ts`                           | `patterns/bulkhead.ts`                | Queued waiter rejects on abort and its `fn` never runs; slot released to the next waiter; `BulkheadFullError` on overflow retained.                                                                                                                                                                                                                             |
| `resilience-plugin/test/unit/circuit-breaker.test.ts`                    | `patterns/circuit-breaker.ts`         | Existing state-machine assertions retained against the widened `execute<T>(fn: ResilientCall<T>)`.                                                                                                                                                                                                                                                              |
| `resilience-plugin/test/unit/resilience-service.test.ts`                 | `services/resilience-service.ts`      | Zero-arg call still accepted; hardened callable invocable with and without a signal; a timeout aborts the call's signal end-to-end; all three `default*` resolution throws retained.                                                                                                                                                                            |
| `resilience-plugin/test/integration/cancellation.test.ts`                | chain composition                     | A `fetch`-shaped call given `{ timeout, retry }` is abandoned on deadline: the call's own `signal.aborted` flips, and a recorded side effect proves it stopped rather than completing. This is the test that fails without the fix.                                                                                                                             |
| `feature-flags-plugin/test/unit/launchdarkly-module.test.ts`             | `providers/launchdarkly-module.ts`    | `adaptLaunchDarklyModule` maps a fake module; throws a named error when `init` is absent.                                                                                                                                                                                                                                                                       |
| `feature-flags-plugin/test/unit/launchdarkly-provider.test.ts`           | `providers/launchdarkly-provider.ts`  | Cold miss returns `fallbackValue` and schedules a refill; second call answers from the snapshot; `update` clears the cache; `isEnabledAsync` calls `boolVariation` with the resolved default; `stop()` calls `close()`; `status()` reflects `initialized()`. Against `boolVariation(key: string, context: LDContext, defaultValue: boolean): Promise<boolean>`. |
| `feature-flags-plugin/test/integration/launchdarkly-real-import.test.ts` | `loadLaunchDarklyModule`              | Guarded real `await import('npm:@launchdarkly/node-server-sdk@^9')`; asserts `typeof init === 'function'`. Skipped when the dep is absent.                                                                                                                                                                                                                      |
| `feature-flags-plugin/test/unit/feature-flags-service.test.ts`           | `services/feature-flags-service.ts`   | `isEnabledAsync` delegates when the provider implements it and falls back otherwise; **both entry points driven under a non-default config produce identical output**.                                                                                                                                                                                          |
| `feature-flags-plugin/test/unit/feature-flags-plugin.test.ts`            | `plugin/feature-flags-plugin.ts`      | `createProvider` builds the `'launchdarkly'` arm; missing `sdkKey` with no client throws.                                                                                                                                                                                                                                                                       |
| `realtime-backplane-plugin/test/unit/frame-codec.test.ts`                | `codec/frame-codec.ts`                | Text round-trip; binary round-trip; a known byte sequence encodes to its literal base64 string.                                                                                                                                                                                                                                                                 |
| `realtime-backplane-plugin/test/unit/memory-backplane.test.ts`           | `transports/memory-backplane.ts`      | Delivers to other subscribers; drops own-origin frames; `close()` stops delivery.                                                                                                                                                                                                                                                                               |
| `realtime-backplane-plugin/test/unit/messaging-backplane.test.ts`        | `transports/messaging-backplane.ts`   | Publishes on the injected `IMessageBroker` with the configured topic; handler receives the decoded frame; `close()` unsubscribes.                                                                                                                                                                                                                               |
| `realtime-backplane-plugin/test/unit/redis-backplane.test.ts`            | `transports/redis-backplane.ts`       | Publishes on the publisher client only; subscribes on the subscriber; construction throws without a subscriber; `close()` quits both.                                                                                                                                                                                                                           |
| `realtime-backplane-plugin/test/unit/redis-module.test.ts`               | `transports/redis-module.ts`          | `adaptRedisModule` branches over a fake module; named error when absent.                                                                                                                                                                                                                                                                                        |
| `realtime-backplane-plugin/test/integration/redis-real-import.test.ts`   | `loadRedisModule`                     | Guarded real `await import('npm:ioredis@5.x')`.                                                                                                                                                                                                                                                                                                                 |
| `realtime-backplane-plugin/test/unit/backplane-factory.test.ts`          | `transports/backplane-factory.ts`     | One case per union arm; `'messaging'` without the capability throws.                                                                                                                                                                                                                                                                                            |
| `realtime-backplane-plugin/test/integration/plugin.test.ts`              | `plugin/realtime-backplane-plugin.ts` | Registers in a kernel app; token resolves; health indicator reports the transport; connect on register and close on shutdown.                                                                                                                                                                                                                                   |
| `websocket-plugin/test/unit/room-registry.test.ts`                       | `rooms/room-registry.ts`              | Existing membership/eviction assertions retained with **no** backplane; with one, `broadcast` publishes exactly one frame carrying the room name.                                                                                                                                                                                                               |
| `websocket-plugin/test/integration/backplane.test.ts`                    | plugin wiring                         | Two service instances over one `MemoryBackplane`: a broadcast on A reaches B's local members exactly once, is not re-published, and `except` is honored only on A.                                                                                                                                                                                              |
| `sse-plugin/test/unit/channel-registry.test.ts`                          | `channels/channel-registry.ts`        | Same two shapes as the room registry, for `publish(msg: SseMessage)`.                                                                                                                                                                                                                                                                                           |
| `sse-plugin/test/integration/backplane.test.ts`                          | plugin wiring                         | Two SSE services over one `MemoryBackplane`; a publish on A reaches B's members once.                                                                                                                                                                                                                                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m47-alpha3-limitations, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the construct grep required before reporting done:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/{common,resilience-plugin,feature-flags-plugin,websocket-plugin,sse-plugin,realtime-backplane-plugin}/src
```

## 8. Risks & mitigations

- Widening a _released_ contract (`wrap`, `execute`) could break a consumer despite the
  assignability argument → a compile-time test asserts both the zero-argument call form and
  assignment of the result to a `() => Promise<T>` variable, and `deno task check` covers the one
  in-repo consumer (`packages/sdk`).
- The LaunchDarkly SDK is Node-oriented (`events`, `/// <reference types="node" />`) → the provider
  is documented Node/Deno/Bun only and never loaded unless the `'launchdarkly'` arm is configured,
  so Workers builds are unaffected. The guarded real-import test proves it resolves under Deno.
- A new workspace package must not silently join the publish set → `scripts/release-packages.ts`
  carries an explicit dependency-ordered allow-list, so the new package is added there deliberately
  and `deno task release:verify` re-checks full workspace coverage.
- Base64 in `frame-codec.ts` must not reach for a runtime-specific API → it is written against
  web-standard `btoa`/`atob` over a `Uint8Array`, asserted literally in its own test.
- Two plugins subscribing to one backplane topic could cross-deliver room frames into channels →
  `RealtimeFrame` carries a `kind` discriminant and each consumer ignores frames of the other kind,
  asserted in both integration tests.

## 9. Out of scope

- **Presence and cluster-wide membership counts.** `Room.size` and `SseChannel.size` stay local
  (§3.10); a distributed roster needs a presence protocol with expiry, which a later real-time
  milestone owns.
- **Honoring `except` across replicas.** Not expressible without stable cross-process connection
  identity (§3.10).
- **Cancelling in-flight I/O the protected call does not itself abort.** §A hands the call a signal;
  a call that ignores it still runs to completion. Making `fetch`-shaped calls abort is the caller's
  responsibility, and this is stated in the widened JSDoc.
- **LaunchDarkly big segments and migration flags.** The facade covers boolean evaluation only.
- **FCM HTTP v1**, **Kafka request-reply**, and the **Node/Bun compat suites** — each named in §0
  with its owning milestone.
