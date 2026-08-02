# Milestone 52d — Durable Objects (`@hono-enterprise/cloudflare-plugin`)

> **Status:** Complete — archived on merge. Branch: `feat/m52d-durable-objects`. `main` is protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Reach Durable Objects as first-class capabilities: a DO-backed `IRealtimeBackplane` registered under
`CAPABILITIES.REALTIME_BACKPLANE`, and a DO-backed distributed lock structurally satisfying
`scheduler-plugin`'s `IDistributedLock`. Both need the application to export a DO class plus a
wrangler stanza, which is the reason this is not M52b — and both are constrained by two platform
facts verified against current Cloudflare docs (§1, F1–F6) rather than assumed: a Worker isolate
cannot be relied on to hold a long-lived outbound WebSocket, and `cloudflare:workers` is
unresolvable off a Worker toolchain, so this package can neither import the `DurableObject` base
class nor the `WebSocketPair` global.

- **In scope:** `DurableObjectBackplane` (an `IRealtimeBackplane` over one WebSocket per replica to
  a fan-out DO), `DurableObjectLock` (an `IDistributedLock` over one DO per lock key),
  `RealtimeBackplaneObjectCore` + `DistributedLockObjectCore` (the two DO-side implementations the
  application's exported DO class delegates to), a `durableObject` arm on `CloudflarePluginOptions`
  registering the backplane, the wrangler stanza documented as a deliverable, and doc deliverables
  C1–C5.
- **NOT this milestone:** DO-backed sessions or storage (no milestone owns these; `KvSessionStore`
  already serves sessions and R2 serves storage). Deployment manifests for the DO stanza — M39.
  Anything requiring a live Cloudflare account in CI — M39. A cluster-wide `Room.size` — deferred to
  a presence milestone as a **contract** decision (M47 established this).

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRealtimeBackplane`                          | `packages/common/src/services/realtime.ts:104`                                                                      | `readonly origin: string`; `connect(): Promise<void>`; `publish(frame): Promise<void>`; `subscribe(handler): Promise<() => void>`; `close(): Promise<void>`. Publish must NOT echo to own handlers.                                                                                                       |
| `RealtimeFrame`                               | `packages/common/src/services/realtime.ts:41`                                                                       | `kind: 'ws-room' \| 'sse-channel'`, `origin`, `name`, `data: string`, `binary?: boolean`, `exceptId?: string`. Every field JSON-serializable.                                                                                                                                                             |
| `RealtimeFrameHandler`                        | `packages/common/src/services/realtime.ts:85`                                                                       | `(frame: RealtimeFrame) => void` — synchronous, returns nothing.                                                                                                                                                                                                                                          |
| `CAPABILITIES.REALTIME_BACKPLANE`             | `packages/common/src/tokens.ts:111`                                                                                 | `'realtime-backplane'`. Already committed (M47) — **no `common` change and no new token in this milestone.**                                                                                                                                                                                              |
| `CAPABILITIES.CLOUDFLARE`                     | `packages/common/src/tokens.ts:136`                                                                                 | `'cloudflare'` — what `CloudflarePlugin` already registers `BindingRegistry` under.                                                                                                                                                                                                                       |
| `encodeFrameData`/`decodeFrameData`           | `packages/common/src/realtime-codec.ts:43`, `:68`                                                                   | The committed wire codec plus `EncodedPayload` (`:20`). Used by the ws/sse plugins, NOT by a transport — a transport carries `RealtimeFrame` whole. Listed to record that it was checked and is **not** needed here.                                                                                      |
| `IDistributedLock`                            | `packages/scheduler-plugin/src/interfaces/index.ts:17`                                                              | `acquire(key: string, ttlMs: number): Promise<string \| null>`; `release(key: string, token: string): Promise<void>`. **Internal to scheduler-plugin, NOT exported from its `src/index.ts` barrel's runtime surface** — so this package satisfies it _structurally_ and must never import it (§2.2/§3.3). |
| `SchedulerPluginOptions.distributedLock.lock` | `packages/scheduler-plugin/src/interfaces/index.ts:77`                                                              | `lock?: IDistributedLock` — "Custom lock implementation. Takes priority over `storage` when present." This is the seam the DO lock is handed to; **no scheduler-plugin change is needed.**                                                                                                                |
| `IDurableObjectNamespace`                     | `packages/cloudflare-plugin/src/bindings/facades.ts:367`                                                            | `idFromName(name: string): unknown`; `get(id: unknown): IServiceBinding`. Its JSDoc (`:362`) already names M52d as the milestone that consumes it.                                                                                                                                                        |
| `IServiceBinding`                             | `packages/cloudflare-plugin/src/bindings/facades.ts:348`                                                            | `fetch(input: Request \| string, init?: RequestInit): Promise<Response>` — the DO stub's only member on this facade. **Has no `webSocket` on the response type**, so §3.3 widens the facade.                                                                                                              |
| `BindingRegistry.durableObject`               | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:216`                                                   | `durableObject(name) { return this.#require(name) as IDurableObjectNamespace; }` — an **unvalidated cast**, exactly the hole M52c's review closed for D1. §3.9 adds `isDurableObjectNamespace`.                                                                                                           |
| `hasMethods` guard family                     | `packages/cloudflare-plugin/src/bindings/facades.ts:393`, `isKvNamespace:410`, `isR2Bucket:421`, `isD1Database:437` | The committed guard pattern the new guard joins: every named member must be a function.                                                                                                                                                                                                                   |
| `CloudflareBindingMissingError`               | `packages/cloudflare-plugin/src/errors.ts:19`                                                                       | `.absent(binding, available)` (`:37`), `.wrongShape(binding, expected)` (`:52`) — the two committed factories.                                                                                                                                                                                            |
| `CloudflareUnsupportedError`                  | `packages/cloudflare-plugin/src/errors.ts:70`                                                                       | Exists and is exported; reused for the "no `webSocket` on the upgrade response" failure rather than inventing an error type.                                                                                                                                                                              |
| `instanceToken`                               | `packages/cloudflare-plugin/src/instance-token.ts:44`                                                               | `(base, name) => name ?? 'default' === 'default' ? base : createCapabilityToken(`base.name`)`. `@internal`, NOT barrel-exported. The `cache.<name>` convention the new arm follows.                                                                                                                       |
| `CloudflarePlugin` register flow              | `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts:66-168`                                                 | Arms are `{options, token}` pairs; `provides` is computed from the options; every arm registers inside `register()`; `ctx.health.register('cloudflare', …)` is called once at the end.                                                                                                                    |
| `resolveWaitUntil` logger thunk               | `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts:112-118`                                                | The committed rule: **never capture `ctx.logger` by value at `register()`** — pass `() => ctx.logger`. M52b shipped this defect on `WorkersQueueOptions.logger` and fixed it.                                                                                                                             |
| `IRuntimeServices`                            | `packages/common/src/runtime.ts:258`, `:274`, `:281`                                                                | `uuid(): string`, `now(): number` (wall clock), `hrtime(): number` (monotonic). Lock tokens come from `uuid()`.                                                                                                                                                                                           |
| `dispatchFrame`                               | `packages/realtime-backplane-plugin/src/transports/dispatch.ts:41`                                                  | Snapshot-then-iterate, isolate each handler, report throws. **In another plugin — cannot be imported** (§2.2). §3.7 decides the local copy.                                                                                                                                                               |
| `isRealtimeFrame`                             | `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts` (barrel-exported)                        | Same: another plugin, cannot import. §3.7.                                                                                                                                                                                                                                                                |
| `RedisBackplane` connect/close                | `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts:110-267`                                      | The memoized-open + `#generation` close-wins pattern this milestone mirrors, verified line by line rather than reinvented.                                                                                                                                                                                |
| `createDefaultCloudflareWebSocketHost`        | `packages/runtime/src/adapters/workers/cf-ws-upgrader.ts:127-147`                                                   | The committed precedent for reading a Workers-only global: a `globalThis as XGlobal` cast inside an exported **factory** (so a unit test can cover the default path), throwing a named error when absent. §3.4 follows it exactly. `packages/runtime` is a different package and is NOT imported.         |

### 1a. Cloudflare platform facts (verified against current docs, not memory)

Each one shaped a decision; none is inferred from an API name.

| #  | Fact                                                                                                                                                                                                                                                                                                                                                                    | Source                                                                           | Consequence                                                                                                                                        |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 | `ctx.acceptWebSocket(ws)` marks a socket **hibernatable**: "the runtime does not need to pin this Durable Object to memory while the connection is open." `ws.accept()` pins it. On a later message the runtime **re-runs the constructor** and delivers to `webSocketMessage`.                                                                                         | developers.cloudflare.com/durable-objects/examples/websocket-hibernation-server/ | §3.5: the DO holds **zero** in-memory state; `getWebSockets()` is the only membership source of truth.                                             |
| F2 | A Worker isolate is evicted at the platform's discretion; "do not rely on state persisting between requests"; there is "no guarantee that any two user requests will be routed to the same … instance". An evicted isolate loses its outbound WebSockets.                                                                                                               | developers.cloudflare.com/workers/reference/how-workers-works/                   | §3.1: connect **lazily and reconnect**; document that a replica's subscription lives exactly as long as the isolate holding the members it serves. |
| F3 | An HTTP-triggered Worker has **no hard duration limit** — "as long as the client remains connected, the Worker can continue processing". CPU time excludes network waits.                                                                                                                                                                                               | developers.cloudflare.com/workers/platform/limits/                               | §3.1: the coupling in F2 is _sound_, not merely tolerable — the isolate is kept alive by the very client sockets the subscription exists to serve. |
| F4 | The "6 simultaneous open connections" limit counts connections **waiting for response headers** only: "Once response headers arrive for a connection, it no longer counts toward the six-connection limit."                                                                                                                                                             | developers.cloudflare.com/workers/platform/limits/#simultaneous-open-connections | One established backplane socket does **not** permanently consume a slot. No blocker; recorded so a reviewer does not re-raise it.                 |
| F5 | DO eviction: hibernation after ~10 s idle when eligible; otherwise 70–140 s in memory. An outbound connection defers eviction for at most **15 minutes**.                                                                                                                                                                                                               | developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/     | §3.6: the lock DO must persist deadlines in `state.storage`, never in a field, because it can be evicted between `acquire` and `release`.          |
| F6 | Wrangler declares a DO with `durable_objects.bindings` (`name`, `class_name`, optional `script_name`). Two config flows exist: the modern `[exports.<Class>] type = "durable-object", storage = "sqlite"`, and the legacy `migrations` + `new_sqlite_classes`. `storage = "sqlite"` is required on the Workers Free plan; "a Worker can only use one [flow] at a time". | developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/  | §3.10: the docs ship the **modern `exports`** form as the single documented stanza, naming the legacy flow only as a compatibility note.           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                 |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:5209` states the backplane design as "each replica holds a WebSocket to the DO, which fans out", with no mention of isolate eviction. Platform fact F2 says an isolate may be evicted at any time and its outbound sockets lost, so a _durable_ per-replica subscription is not achievable.                    | Keep the WebSocket design (it is the only one that satisfies `subscribe`), but state the real guarantee: the subscription lives exactly as long as the isolate holding the local members it serves — and because those members are client sockets held by the same isolate (F3), losing one loses both **together**, which is consistent rather than lossy. Reconnect on failure; connect lazily.                               | ROADMAP §M52d scope paragraph rewritten to state the guarantee and cite F2/F3.                                            |
| C2 | `packages/cloudflare-plugin/src/bindings/facades.ts:362` documents `IDurableObjectNamespace` as "an escape hatch" whose consumers are M52d — but its `get()` returns `IServiceBinding`, whose `fetch` returns a plain `Response` with **no `webSocket` member**, so the type cannot express a DO WebSocket upgrade at all. | Widen the facade rather than cast at the call site: `IServiceBinding.fetch` keeps its committed signature, and a new `IDurableObjectStub extends IServiceBinding` adds nothing, while a new `DurableObjectUpgradeResponse` type carries `webSocket?: unknown`. `IDurableObjectNamespace.get` is **not** re-typed (that would be a breaking narrowing); the backplane narrows the returned `Response` through an exported guard. | PUBLIC_API.md Cloudflare section gains the new types; `facades.ts:362` JSDoc updated to name what M52d actually consumes. |
| C3 | `ROADMAP.md:5216` says the lock is handed to `SchedulerPlugin` because "`SchedulerPlugin` takes `IDistributedLock` as an option". Verified: the option is `distributedLock.lock`, nested one level deeper than the prose implies (`scheduler-plugin/src/interfaces/index.ts:77`).                                          | Use the real shape, `SchedulerPlugin({ distributedLock: { enabled: true, lock } })`, in every example. The `enabled: true` is load-bearing and the prose omits it — verify against `distributed-lock.ts:40` during implementation and, if `lock` alone suffices, document that instead of guessing.                                                                                                                             | ROADMAP §M52d + PUBLIC_API + README examples all use the verified nested shape.                                           |
| C4 | `CLAUDE.md` "Current status" lists M52d as "planned, not started" and "Next milestone" offers M52d **or** M37. `ROADMAP.md:5460` Progress row for 52d is `⬜`.                                                                                                                                                             | This milestone is M52d. Flip both in this PR (the mandatory status-flip rule), and point "Next milestone" at M37.                                                                                                                                                                                                                                                                                                               | `CLAUDE.md` status entry + "Next milestone" line; `ROADMAP.md` Progress row `52d → ✅`.                                   |
| C5 | `ROADMAP.md:5083` claims the Cache API shipped in M52b alongside queues and cron — checked and correct. Checked ARCHITECTURE §6/§10 for a realtime-backplane provider row: the package diagram lists `realtime-backplane-plugin` as the sole `REALTIME_BACKPLANE` provider, which this milestone makes false.              | Add `cloudflare-plugin` as a second provider of the token in the ARCHITECTURE capability table, and note that the kernel rejects two providers of one token — so an application registers exactly one.                                                                                                                                                                                                                          | ARCHITECTURE capability/provider table updated.                                                                           |

## 3. Design decisions

### 3.1 Replica ↔ DO transport: one lazily-opened WebSocket, reconnected on failure

- **Decision:** `DurableObjectBackplane.connect()` opens ONE WebSocket to the DO named by the
  configured topic (`ns.idFromName(topic)` →
  `stub.fetch(url, { headers: { Upgrade: 'websocket' } })` → `response.webSocket` → `ws.accept()`),
  memoized exactly like `RedisBackplane.connect()` (`redis-backplane.ts:110`): overlapping calls
  join one attempt, a failure clears the memo so a retry is possible, and a `close()` landing
  mid-attempt wins via a `#generation` counter and retires the socket it built. `publish()` awaits
  `connect()` first, so a caller never has to sequence them. A socket that closes or errors clears
  the memo, so the next `publish`/local broadcast reopens it; there is no timer-driven reconnect
  loop, because a backplane with no traffic needs no socket and a timer would defeat F2's eviction
  anyway.
- **Why:** F2 says the isolate can vanish; F3 says it will not vanish while it holds client sockets.
  Reconnect-on-demand is therefore the only shape that is both correct and free when idle. A
  publish-only `stub.fetch` design was rejected: `IRealtimeBackplane.subscribe` requires _pushed_
  delivery, which a request/response fetch cannot provide.
- **Test home:** `test/unit/durable-object-backplane.test.ts` — "joins one attempt under concurrent
  connect", "clears the memo after a failed open so a retry reopens", "a close during an in-flight
  open retires the socket", "publish reopens after the socket closed".

### 3.2 What crosses the wire: the whole `RealtimeFrame` as JSON, one line per frame

- **Decision:** each message is `JSON.stringify(frame)`. The DO re-broadcasts the **raw string**
  without parsing it.
- **Why:** every `RealtimeFrame` field is JSON-serializable by contract (`realtime.ts:41` JSDoc).
  Not parsing in the DO means the DO cannot corrupt a frame, costs no CPU per fan-out, and keeps the
  DO ignorant of the frame schema — so a future `common` widening of `RealtimeFrame` needs no DO
  redeploy, which matters because a DO class is deployed by the _application_, not by this package.
- **Test home:** `test/unit/realtime-backplane-object-core.test.ts` — "re-broadcasts the exact bytes
  it received", "does not JSON.parse the payload" (asserted by broadcasting a deliberately non-frame
  string and observing it arrive verbatim).

### 3.3 Own-origin filtering happens on the RECEIVING replica, not in the DO

- **Decision:** the DO broadcasts to every socket **except the sending socket**
  (`state.getWebSockets()` filtered by identity). The receiving `DurableObjectBackplane`
  additionally drops frames whose `origin === this.origin`.
- **Why:** two different concerns. Excluding the sender socket is what stops a replica receiving its
  own publish (the contract's "not delivered back to this instance's own handlers"). The origin
  check is the belt-and-braces the contract's `origin` field exists for (`realtime.ts:46`), and it
  is what saves a deployment where one replica somehow holds two sockets to the same DO — which F2's
  reconnect path makes reachable, since a stale socket can outlive the isolate's belief that it
  closed.
- **Test home:** `test/unit/realtime-backplane-object-core.test.ts` ("sender does not receive its
  own broadcast") and `test/unit/durable-object-backplane.test.ts` ("drops an arriving frame stamped
  with our own origin").

### 3.4 Reaching the Workers-only `WebSocketPair` global: an injectable host with an exported default factory

- **Decision:** `RealtimeBackplaneObjectCore` takes an optional `createPair` seam. The default is an
  exported `createDefaultDurableObjectWebSocketHost()` which reads
  `(globalThis as WebSocketPairGlobal).WebSocketPair` behind one documented boundary cast and throws
  a named error when absent.
- **Why:** an exact copy of the committed precedent at
  `packages/runtime/src/adapters/workers/cf-ws-upgrader.ts:127` — including _why_ it is a factory
  rather than a constant: so the cast is evaluated only when an upgrade happens, and so a unit test
  can call it directly and cover the default path instead of leaving it uncovered.
  `packages/runtime` is a separate package and is **not** imported (§2.2); this is a deliberate
  local implementation of the same pattern, in the same category as M30b's `pemToDer` copy.
- **Test home:** `test/unit/do-websocket-host.test.ts` — "throws naming the runtime when
  `WebSocketPair` is absent", "returns the client/server pair from the global", "throws when the
  global yields an incomplete pair".

### 3.5 The DO holds ZERO in-memory state; `getWebSockets()` is the membership source of truth

- **Decision:** `RealtimeBackplaneObjectCore` keeps **no** `Set` of sockets, no counters, and no
  fields other than its injected seams. Every fan-out reads `state.getWebSockets()`. Sockets are
  accepted with `state.acceptWebSocket(ws)`, never `ws.accept()`.
- **Why:** F1 — a hibernating DO discards in-memory state and **re-runs the constructor** on the
  next message. Any membership set held in a field would silently empty itself on the first
  hibernation, and every test that never hibernates would pass. This is the single most likely way
  this milestone could ship green and broken, so the design removes the possibility rather than
  testing around it. `acceptWebSocket` is also what makes an idle room cost nothing, since it lets
  the DO be evicted while its sockets stay open.
- **Test home:** `test/unit/realtime-backplane-object-core.test.ts` — "survives a simulated
  hibernation" (construct a fresh core over the same fake state and assert the next broadcast still
  reaches every socket), and a grep-style assertion that the core exposes no membership field.

### 3.6 The lock persists deadlines in `state.storage`, never in a field

- **Decision:** `DistributedLockObjectCore.acquire` reads the current holder from
  `state.storage.get(key)`, compares its `expiresAt` against the clock, writes
  `{ token, expiresAt }` via `state.storage.put(key, …)` when free or expired, and answers the token
  or `null`. `release` deletes only when the presented token matches. `state.storage` calls are
  awaited.
- **Why:** F5 — the DO is evicted after 70–140 s idle, and a lock TTL routinely outlives that. A
  deadline held in a `Map` field would evaporate on eviction and hand the lock to a second holder,
  which is precisely the failure a distributed lock exists to prevent. A DO's single-threaded
  execution is what makes the read-compare-write atomic without a transaction.
- **Test home:** `test/unit/distributed-lock-object-core.test.ts` — "a second acquire while held
  returns null", "an expired holder is displaced", "release with a foreign token does not release",
  "state survives a simulated eviction" (fresh core, same fake storage).

### 3.7 Frame validation and fan-out dispatch are local copies, not imports

- **Decision:** this package gets its own internal `isRealtimeFrame` and `dispatchFrame`, in
  `src/durable-objects/frame-dispatch.ts`, NOT exported from `src/index.ts`.
- **Why:** both live in `realtime-backplane-plugin`, and §2.2/§3.3 forbid a plugin importing a
  plugin — the identical situation to M30b's `pemToDer`, which AI_GUIDELINES resolved as a
  deliberate local copy. §11.1 (no duplicated logic) is scoped to a package; the alternative,
  promoting them to `common`, is a public-API change that buys nothing here because the two copies
  have no reason to drift (the shape they validate is a committed `common` type). Recorded as a
  deviation so a reviewer does not read it as an oversight.
- **Test home:** `test/unit/frame-dispatch.test.ts` — "a throwing handler does not starve the next",
  "handlers are snapshotted so a handler unsubscribing mid-dispatch cannot mutate the iteration",
  "rejects a non-frame object", "rejects a frame with a non-string `data`".

### 3.8 The application's DO class delegates to an exported core — no mixin, no base class import

- **Decision:** this package exports two plain classes, `RealtimeBackplaneObjectCore` and
  `DistributedLockObjectCore`, each constructed with a structural `IDurableObjectState` and each
  exposing the DO handler methods (`fetch`, `webSocketMessage`, `webSocketClose`, `webSocketError`
  for the backplane; `fetch` for the lock). The application writes:

  ```ts
  import { DurableObject } from 'cloudflare:workers';
  import { RealtimeBackplaneObjectCore } from '@hono-enterprise/cloudflare-plugin';

  export class RealtimeBackplaneObject extends DurableObject {
    #core = new RealtimeBackplaneObjectCore(this.ctx);
    override fetch(request: Request): Promise<Response> {
      return this.#core.fetch(request);
    }
    webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
      this.#core.webSocketMessage(ws, message);
    }
    webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
      this.#core.webSocketClose(ws, code, reason, wasClean);
    }
  }
  ```

- **Why:** a mixin (`createRealtimeBackplaneObject(DurableObject)`) reads better but **cannot be
  typed without `any`**: the TypeScript mixin constraint is `new (...args: any[]) => …`, and the
  `unknown[]` form does not accept a class whose constructor takes `(ctx: DurableObjectState, env)`
  because constructor parameters are contravariant. §5.2 forbids `any` outright, so the mixin is not
  available. Delegation is `any`-free, keeps `cloudflare:workers` out of this package (the hard M52
  constraint — the specifier breaks `deno check` on every other runtime), lets the app's class
  extend the real base class so workerd's DO-class expectation is satisfied regardless of whether it
  is strictly enforced, and makes both cores directly unit-testable off Workers.
- **Test home:** `test/integration/durable-object-wiring.test.ts` drives a hand-written delegating
  class exactly like the documented one over both cores, proving the documented snippet is the shape
  that actually works rather than an untested illustration.

### 3.9 `BindingRegistry.durableObject` validates its binding

- **Decision:** add `isDurableObjectNamespace` to `facades.ts`
  (`hasMethods(value, ['idFromName',
  'get'])`) and make `BindingRegistry.durableObject` throw
  `CloudflareBindingMissingError.wrongShape` instead of casting.
- **Why:** `binding-registry.ts:216` casts unvalidated — the exact defect M52c's code review found
  on D1, where an absent binding let the app boot clean and fail every request with a bare
  `TypeError`. The guard family's own JSDoc (`facades.ts:402`) states it exists "to fail at
  `register()` with a name rather than at the first request with a bare `TypeError`", so this closes
  the family's last hole. Coverage cannot catch this class of defect — there is no branch to cover
  until the guard exists.
- **Test home:** `test/unit/binding-registry.test.ts` (existing file, new cases) — "throws naming
  the binding when it is not DO-shaped", "throws listing available bindings when absent".

### 3.10 Registration: an opt-in `durableObject` arm, instance-named, on the existing plugin

- **Decision:** `CloudflarePluginOptions` gains
  `durableObject?: { binding: string; name?: string; topic?: string; connect?: 'lazy' }` — omitted
  registers nothing, present registers `DurableObjectBackplane` under
  `instanceToken(CAPABILITIES.REALTIME_BACKPLANE, name)` and pushes that token onto `provides`. The
  logger is passed as a **thunk** (`() => ctx.logger`). The lock is NOT registered — it is
  app-constructed and handed to `SchedulerPlugin`, the `KvSessionStore`/`D1Adapter` precedent,
  because that option is read before any application exists.
- **Why:** mirrors the three committed arms line for line (`cloudflare-plugin.ts:70-86`), so the
  kernel's duplicate-provider index sees exactly what this instance registers. The thunk is the
  M52b-defect rule from §1. `topic` defaults to `'realtime'` and names the DO instance, so two
  applications sharing a namespace do not cross-talk.
- **Test home:** `test/integration/cloudflare-plugin-do.test.ts` — "registers the backplane under
  the bare token", "derives `realtime-backplane.<name>` for a named instance", "registers nothing
  when the arm is omitted", "a logger registered imperatively after `register()` still receives a
  publish failure" (the thunk regression test).

### 3.11 A publish failure is reported and swallowed, never thrown into a broadcast

- **Decision:** `publish()` rejects on a failed connect (the contract returns a promise, and
  `websocket-service.ts:171` already `.catch()`es it), but a send on an already-open socket that
  throws is caught, reported through the logger thunk, and clears the memo so the next publish
  reopens.
- **Why:** the consuming plugins call `publish` detached (`void backplane.publish(frame).catch(…)`,
  `websocket-service.ts:171`), so an unreported throw is invisible. Clearing the memo is what turns
  a dead socket into a reconnect instead of a permanently silent backplane.
- **Test home:** `test/unit/durable-object-backplane.test.ts` — "reports a send failure through the
  logger and reopens on the next publish".

## 4. Exported surface — every symbol names its consumer

| Exported symbol                           | Kind      | Consumer / real code path that READS it                                                                                                                                                                            |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DurableObjectBackplane`                  | class     | Constructed by `CloudflarePlugin`'s `durableObject` arm (`plugin/cloudflare-plugin.ts`) and registered under `CAPABILITIES.REALTIME_BACKPLANE`; resolved by `websocket-plugin`/`sse-plugin` at their `register()`. |
| `DurableObjectBackplaneOptions`           | type      | The `DurableObjectBackplane` constructor's second parameter; built by the plugin arm from `DurableObjectArm`.                                                                                                      |
| `DurableObjectLock`                       | class     | App-constructed, handed to `SchedulerPlugin({ distributedLock: { lock } })`; its `acquire`/`release` are called by `SchedulerService` on every fire.                                                               |
| `DurableObjectLockOptions`                | type      | The `DurableObjectLock` constructor's second parameter.                                                                                                                                                            |
| `RealtimeBackplaneObjectCore`             | class     | Instantiated by the DO class the **application** exports; its `fetch`/`webSocketMessage`/`webSocketClose` are invoked by the Workers runtime.                                                                      |
| `DistributedLockObjectCore`               | class     | Same: instantiated by the application's exported lock DO class; its `fetch` is invoked by the runtime on every `DurableObjectLock` call.                                                                           |
| `RealtimeBackplaneObjectCoreOptions`      | type      | The core's second constructor parameter — carries the `createPair` seam (§3.4) and the logger thunk.                                                                                                               |
| `DistributedLockObjectCoreOptions`        | type      | The lock core's second constructor parameter — carries the `now` clock seam (§3.6).                                                                                                                                |
| `IDurableObjectState`                     | interface | The structural facade for `DurableObjectState`; the type of both cores' first constructor parameter, written by the application's DO class.                                                                        |
| `IDurableObjectWebSocket`                 | interface | The structural facade for a hibernatable socket; the element type of `IDurableObjectState.getWebSockets()` and the first parameter of the handlers.                                                                |
| `DurableObjectWebSocketHost`              | interface | The `createPair` seam's type (§3.4); implemented by `createDefaultDurableObjectWebSocketHost` and by the test double.                                                                                              |
| `createDefaultDurableObjectWebSocketHost` | function  | The default value of `RealtimeBackplaneObjectCoreOptions.createPair`; called by the core when the option is omitted, i.e. on every real deployment.                                                                |
| `DurableObjectUpgradeResponse`            | type      | The narrowed response type `DurableObjectBackplane` reads `webSocket` from (C2); returned by `asUpgradeResponse`.                                                                                                  |
| `asUpgradeResponse`                       | function  | Called by `DurableObjectBackplane.#open` to narrow the stub's `Response`; throws `CloudflareUnsupportedError` when `webSocket` is absent.                                                                          |
| `isDurableObjectNamespace`                | function  | Called by `BindingRegistry.durableObject` (§3.9); joins the committed `isKvNamespace`/`isR2Bucket`/`isD1Database` family.                                                                                          |
| `DurableObjectArm`                        | type      | The `durableObject` member of `CloudflarePluginOptions`; read by the plugin's arm construction.                                                                                                                    |

Nothing above is exported only for its own test. `RealtimeBackplaneObjectCoreOptions.createPair` and
`DistributedLockObjectCoreOptions.now` are seams whose **default** path runs on every real
deployment (§3.4's factory is called when the option is omitted), so neither is test-only surface.

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                                                     | Behavior (per implementation)                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DurableObjectArm.binding`                      | `CloudflarePlugin.register` → `registry.durableObject(name)` | The `durable_objects.bindings` name from wrangler. Absent or wrong-shaped → `CloudflareBindingMissingError` at `register()` (§3.9).                                                                                                                                                 |
| `DurableObjectArm.name`                         | `instanceToken(CAPABILITIES.REALTIME_BACKPLANE, name)`       | `'default'`/omitted claims the bare token; anything else derives `realtime-backplane.<name>`.                                                                                                                                                                                       |
| `DurableObjectArm.topic`                        | `DurableObjectBackplane` → `ns.idFromName(topic)`            | Names the DO instance every replica shares. Default `'realtime'`. Two applications sharing one namespace must set different topics or they cross-talk.                                                                                                                              |
| `DurableObjectBackplaneOptions.origin`          | `DurableObjectBackplane.origin`; stamped on every frame      | Defaults to `runtime.uuid()`. Read by §3.3's own-origin filter on every arriving frame.                                                                                                                                                                                             |
| `DurableObjectBackplaneOptions.logger`          | §3.11's failure reporting                                    | A **thunk** (`() => ILogger \| undefined`), never a captured value (§1, the M52b defect).                                                                                                                                                                                           |
| `RealtimeBackplaneObjectCoreOptions.createPair` | The core's `fetch` upgrade path                              | Defaults to `createDefaultDurableObjectWebSocketHost()`. Injected in tests; the default runs on every deployment.                                                                                                                                                                   |
| `DistributedLockObjectCoreOptions.now`          | The lock core's expiry comparison                            | Defaults to `Date.now`. **The one sanctioned `Date.now` in this package** — see §8 R4: a DO is constructed by the platform as `(state, env)` with no `IPluginContext` and therefore no `IRuntimeServices`, so this class IS the runtime boundary, exactly as `packages/runtime` is. |
| `DurableObjectLockOptions.runtime`              | `DurableObjectLock.acquire` → `runtime.uuid()`               | The token source. Required, not defaulted — a lock token must come from `IRuntimeServices` per §4.2, and the _client_ side does have a plugin context.                                                                                                                              |
| `DurableObjectLockOptions.keyPrefix`            | `ns.idFromName(prefix + key)`                                | Namespaces lock keys so a shared DO namespace does not collide with another application's. Default `''`.                                                                                                                                                                            |

## 5. Implementation files

| File                                               | Purpose                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                     | Barrel — adds the 16 symbols in §4.                                                                        |
| `src/durable-objects/do-facades.ts`                | `IDurableObjectState`, `IDurableObjectWebSocket`, `DurableObjectUpgradeResponse`, `asUpgradeResponse`.     |
| `src/durable-objects/do-websocket-host.ts`         | `DurableObjectWebSocketHost` + `createDefaultDurableObjectWebSocketHost` (§3.4).                           |
| `src/durable-objects/frame-dispatch.ts`            | Internal `isRealtimeFrame` + `dispatchFrame` (§3.7). NOT barrel-exported.                                  |
| `src/durable-objects/realtime-backplane-object.ts` | `RealtimeBackplaneObjectCore` — the DO-side fan-out (§3.2, §3.3, §3.5).                                    |
| `src/durable-objects/distributed-lock-object.ts`   | `DistributedLockObjectCore` — the DO-side lock (§3.6).                                                     |
| `src/realtime/durable-object-backplane.ts`         | `DurableObjectBackplane` — the replica-side `IRealtimeBackplane` (§3.1, §3.11).                            |
| `src/lock/durable-object-lock.ts`                  | `DurableObjectLock` — the replica-side `IDistributedLock` (structural).                                    |
| `src/bindings/facades.ts`                          | **Modified:** adds `isDurableObjectNamespace` (§3.9).                                                      |
| `src/bindings/binding-registry.ts`                 | **Modified:** `durableObject()` validates instead of casting (§3.9).                                       |
| `src/options.ts`                                   | **Modified:** adds `DurableObjectArm` and the `durableObject` member (§3.10).                              |
| `src/plugin/cloudflare-plugin.ts`                  | **Modified:** the fourth arm — token derivation, `provides`, registration, health-indicator field (§3.10). |
| `src/health/indicator.ts`                          | **Modified:** reports `durableObject: boolean` alongside the existing `cache`/`storage`/`queue` fields.    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                          | src covered                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/do-facades.test.ts`                     | `durable-objects/do-facades.ts`                                    | `asUpgradeResponse(res)` returns the narrowed response when `webSocket` is present; throws `CloudflareUnsupportedError` naming the binding when absent (a plain `Response` from a non-DO endpoint). Types against `(response: Response) => DurableObjectUpgradeResponse`.                                                                                                                                                                                            |
| `test/unit/do-websocket-host.test.ts`              | `durable-objects/do-websocket-host.ts`                             | Default factory throws when `globalThis.WebSocketPair` is absent; returns `{client, server}` when a fake global is installed; throws on an incomplete pair. Types against `() => DurableObjectWebSocketHost`. Global is saved/restored in `afterEach` (§6.6 independence).                                                                                                                                                                                           |
| `test/unit/frame-dispatch.test.ts`                 | `durable-objects/frame-dispatch.ts`                                | Throwing handler does not starve the next; handlers snapshotted against mid-dispatch mutation; `isRealtimeFrame` rejects a non-object, a missing `kind`, a non-string `data`, and an unknown `kind`. Types against `(handlers, frame, onError) => void`.                                                                                                                                                                                                             |
| `test/unit/realtime-backplane-object-core.test.ts` | `durable-objects/realtime-backplane-object.ts`                     | Upgrade returns 101 with the client half and calls `state.acceptWebSocket(server)` (**not** `ws.accept()`); a non-upgrade request answers 426; broadcast reaches every socket except the sender; the payload arrives **verbatim** (§3.2); **survives a simulated hibernation** — a fresh core over the same fake state still fans out (§3.5); a socket that throws on `send` does not starve the rest.                                                               |
| `test/unit/distributed-lock-object-core.test.ts`   | `durable-objects/distributed-lock-object.ts`                       | `acquire` on a free key returns the token and persists `{token, expiresAt}` to `state.storage`; a second `acquire` while held returns `null`; an expired holder is displaced (advance the injected `now`); `release` with the held token deletes; `release` with a foreign token does **not**; **state survives a simulated eviction** (fresh core, same fake storage); an unknown path answers 404.                                                                 |
| `test/unit/durable-object-backplane.test.ts`       | `realtime/durable-object-backplane.ts`                             | Concurrent `connect()` joins one attempt; a failed open clears the memo so a retry reopens; a `close()` mid-open retires the socket; `publish` awaits connect; an arriving own-origin frame is dropped (§3.3); an unparseable message is dropped without throwing; `subscribe` returns a working unsubscribe; a send failure is reported through the logger thunk and reopens next publish (§3.11); `close()` clears handlers and drops the memo.                    |
| `test/unit/durable-object-lock.test.ts`            | `lock/durable-object-lock.ts`                                      | `acquire` posts to the DO derived from `keyPrefix + key` and returns the token the DO answered; `null` when the DO refuses; `release` posts the token; the token comes from `runtime.uuid()` (fake runtime records the call); a non-200 from the stub throws rather than silently reporting "not acquired".                                                                                                                                                          |
| `test/unit/binding-registry.test.ts` (existing)    | `bindings/binding-registry.ts`, `bindings/facades.ts`              | New cases for §3.9: `durableObject()` throws `wrongShape` for a KV binding, throws `absent` listing available names, returns the namespace when DO-shaped. `isDurableObjectNamespace` unit cases alongside the committed guard tests.                                                                                                                                                                                                                                |
| `test/integration/cloudflare-plugin-do.test.ts`    | `plugin/cloudflare-plugin.ts`, `options.ts`, `health/indicator.ts` | Registers the backplane under the bare token; derives `realtime-backplane.<name>`; registers nothing when the arm is omitted; `provides` lists exactly the registered tokens; the health indicator reports `durableObject: true`; the **logger-thunk regression test** — a logger registered imperatively after `register()` receives a publish failure (fails without the thunk).                                                                                   |
| `test/integration/durable-object-wiring.test.ts`   | both cores + both clients, end to end                              | A hand-written delegating DO class exactly matching the documented snippet (§3.8) is driven by a fake namespace; two `DurableObjectBackplane` instances over that one DO exchange a frame — replica A publishes, replica B's subscriber receives it, replica A's does not. Two `DurableObjectLock` instances over one lock DO: the second `acquire` returns `null` until the first releases. **This is the read-it-back proof** that neither deliverable is a no-op. |
| `test/e2e/durable-object-realtime-e2e.test.ts`     | the whole path through a kernel app                                | A real `createApplication` with `RuntimePlugin` + `CloudflarePlugin({ durableObject })` + `WebSocketPlugin`: a room broadcast on replica A reaches a client connected to replica B through the fake DO. Proves the token the plugin registers is the one `websocket-plugin` resolves.                                                                                                                                                                                |

No `src/` file is unmapped. Per-file 90% branch/function/line is read ANSI-stripped after every
change; the whole package currently sits at 100%, so the bar for this milestone is **no regression
from 100%**, not 90%.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m52d-durable-objects, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the mandated forbidden-construct audit, whose expected result is documented rather than assumed
(§8 R4):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|globalThis.__" packages/cloudflare-plugin/src   # MUST be empty
grep -rn "Date.now()" packages/cloudflare-plugin/src   # exactly ONE hit, the §3.6 clock default
file packages/cloudflare-plugin/src/**/*.ts | grep -v "ASCII text\|Unicode text"   # MUST be empty (M50's NUL-byte false pass)
```

## 8. Risks & mitigations

- **R1 — Not verified against a live Worker.** CI holds no Cloudflare account, and DOs cannot be
  faked end to end by the Deno suite. → Drive the whole surface against real **workerd** via
  `wrangler dev` before reporting done, the harness M52b established (it is what caught the kernel's
  module-scope `AbortController`). State plainly in the PR and CLAUDE.md entry what was and was not
  reached, rather than letting green gates imply live verification.
- **R2 — Hibernation is the defect this milestone is most likely to ship green.** A membership set
  in a field passes every non-hibernating test. → §3.5 removes the state entirely rather than
  testing around it, and the "survives a simulated hibernation" test constructs a _fresh core over
  the same fake state_, which is the only shape that would fail if a field crept back in.
- **R3 — The isolate-eviction guarantee is weaker than the ROADMAP implies.** A reader may expect a
  durable cross-replica subscription. → C1 rewrites the ROADMAP claim, and the guarantee is stated
  in the class JSDoc, the README, and PUBLIC_API — not only in this plan.
- **R4 — `Date.now()` in `src` will trip the mandated grep audit.** → It is a single, deliberate,
  documented default on an injectable seam (§3.6, §4.1), justified because a DO is constructed by
  the platform with `(state, env)` and has no route to `IRuntimeServices`. The gate command in §7
  states the expected count so a reviewer sees an intended hit, not an escape. If review rejects the
  rationale, the fallback is to require `now` rather than default it, pushing the boundary into the
  application's DO class.
- **R5 — Two providers of `REALTIME_BACKPLANE`.** An application registering both this arm and
  `RealtimeBackplanePlugin` fails at startup on the kernel's duplicate-provider check. → That is the
  correct behavior (it is a real misconfiguration), but it must be _documented_ rather than
  discovered: C5's ARCHITECTURE row and the README both say to register exactly one.
- **R6 — `wrangler` stanza drift.** F6 records two config flows and warns "a Worker can only use one
  at a time". → Document the modern `exports` form as primary, name the legacy `migrations` form as
  the alternative, and never emit both in one example.

## 9. Out of scope

- **DO-backed sessions or a DO-backed cache.** `KvSessionStore` (M52) already serves sessions and KV
  serves the cache; a DO would add strong consistency at a large latency cost with no requester. No
  milestone owns this; it would need its own.
- **Deployment manifests / compose / k8s for the DO stanza** — M39 owns platform objects. This
  milestone documents the stanza; it does not ship deployment config.
- **A cluster-wide `Room.size` / `SseChannel.size`.** M47 established this as a **contract**
  decision (a cluster-wide count is inherently async and cannot satisfy the synchronous committed
  `size` getter), deferred to a presence milestone. A DO would make it _implementable_, which is
  exactly why it must not be smuggled in here without the contract change.
- **RPC-style DO invocation** (`stub.someMethod()` instead of `stub.fetch`). It needs the
  `DurableObject` base class's typing at the call site, which this package cannot import (§3.8);
  `fetch` is the documented path for exactly this case.
- **Alarms.** `state.storage.setAlarm` could expire locks proactively rather than lazily on read.
  §3.6's read-time comparison is correct without it, and an alarm adds a billed wake-up per lock.
