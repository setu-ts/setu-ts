# Milestone 86 — Non-HTTP Ingress (`common`, `websocket-plugin`, `queue-plugin`, `scheduler-plugin`, `messaging-plugin`, `cqrs-plugin`)

> **Status:** Planning. Branch: `feat/m86-non-http-ingress`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Four ingress paths accept a developer-supplied handler and expose no option to declare one, so
adding a single unit of non-HTTP work means hand-writing an `IPlugin`; and no cross-cutting concern
can run around those handlers, so tenant, auth and tracing reach none of them. This milestone gives
all four the two things HTTP ingress has had since M2 — a declarative registration site resolved at
`onInit`, and one behaviour chain wrapping the handler — plus route-scoped guards for the WebSocket
upgrade, which is the phase that currently forces an application-wide middleware.

- **In scope:** a `RegistryFactory` registration arm on each of the four plugins; one
  transport-neutral behaviour contract and one pure composer in `common`, consumed by all four and
  by `cqrs-plugin` (which loses its private copy); `WebSocketRouteOptions.guards` for the upgrade
  phase. Every addition is optional, so an application that sets none of them keeps today's
  behaviour byte-for-byte.
- **NOT this milestone:** decorators over the new arms (a successor, once the seam exists — see §9);
  wiring tenancy, auth or tracing through the chain (M70b's successor owns that — this milestone
  makes them expressible); typed connection data (§2 C3, deferred to the M71 successor that extends
  the state-key convention to `conn.data`); any wire-protocol change.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                     | Verified surface / fact                                                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RegistryFactory<T>`                 | `packages/common/src/registry.ts:65`                                                                   | `(services: IServiceRegistry) => T`. Not a class-compatible shape.                                                                                                                  |
| `resolveRegistryEntry`               | `packages/common/src/registry.ts:189`                                                                  | `(entry, services, label) => T`. Discriminates on `typeof entry === 'function'`; wraps a factory throw in an `Error` naming `label`, `cause` preserved.                             |
| M70d arm pattern                     | `packages/health-plugin/src/plugin/health-plugin.ts:65,77-84,118-126`                                  | Arms split ONCE at plugin construction; each factory carries its index in the DECLARED array (filtering first named the wrong entry); factories resolved in `ctx.lifecycle.onInit`. |
| `IPipelineBehavior`                  | `packages/common/src/services/cqrs.ts:86-98`                                                           | `handle(request: TRequest, next: () => Promise<TResult>): TResult \| Promise<TResult>`; `TRequest extends CqrsRequest = CqrsRequest`.                                               |
| `CqrsRequest`                        | `packages/common/src/services/cqrs.ts:19-24`                                                           | `{ readonly type: string; readonly data: TData }` — the constraint that makes `IPipelineBehavior` unusable for a queue job or a socket frame.                                       |
| `composePipeline` (private)          | `packages/cqrs-plugin/src/behaviors/pipeline-behavior.ts:23-35`                                        | INTERNAL, not barrel-exported. Wraps last-to-first so `behaviors[0]` runs first; a behaviour short-circuits by returning without calling `next()`.                                  |
| `JobProcessor<T>`                    | `packages/common/src/services/queue.ts:32`                                                             | `(job: IJob<T>) => void \| Promise<void>` — void-returning.                                                                                                                         |
| `IJob<T>`                            | `packages/common/src/services/queue.ts:14-23`                                                          | `{ id, name, data: T, attempts }`. `attempts` is 1 on first delivery.                                                                                                               |
| `IQueue.process`                     | `packages/common/src/services/queue.ts:118`                                                            | `process<T>(name, processor, options?): void` — synchronous, returns nothing.                                                                                                       |
| queue dispatch site                  | `packages/queue-plugin/src/processors/job-processor.ts:104`                                            | ONE call: `await processor(job)`.                                                                                                                                                   |
| `SchedulerJobHandler<T>`             | `packages/common/src/services/scheduler.ts:36-38`                                                      | `(job: ScheduledJob<T>) => void \| Promise<void>` — void-returning.                                                                                                                 |
| `ScheduledJob<T>`                    | `packages/common/src/services/scheduler.ts:18-27`                                                      | `{ id, name, data: T, attempts }`. `attempts` is 1-based.                                                                                                                           |
| scheduler dispatch site              | `packages/scheduler-plugin/src/jobs/job-executor.ts:63`                                                | ONE call: `await handler(job)`.                                                                                                                                                     |
| `SchedulerPluginOptions`             | `packages/scheduler-plugin/src/interfaces/index.ts:41-56`                                              | `{ timezone?, distributedLock? }` — confirmed: no job registration arm exists.                                                                                                      |
| `MessageHandler<T>`                  | `packages/common/src/services/messaging.ts:36-39`                                                      | `(message: T, metadata: MessageMetadata) => void \| Promise<void>` — TWO arguments, void-returning.                                                                                 |
| `MessageMetadata`                    | `packages/common/src/services/messaging.ts:14-26`                                                      | `{ topic, messageId?, timestamp?, headers? }`; `headers` is populated (M75) — `{}` means the transport carried none, absent means no channel.                                       |
| `MessageBrokerAdapter`               | `packages/messaging-plugin/src/brokers/message-broker.ts:39`                                           | Internal seam extending `IMessageBroker` with `publishWithHeaders`/`subscribeWithHeaders`.                                                                                          |
| `TracedBroker` (decorator precedent) | `packages/messaging-plugin/src/tracing/traced-broker.ts:18`, wired at `plugin/messaging-plugin.ts:239` | One decorator wraps the chosen broker for all ten arms; `broker = new TracedBroker(broker, …)`. The shape M86 reuses for the behaviour chain.                                       |
| `WebSocketHandlers`                  | `packages/common/src/services/websocket.ts:294-330`                                                    | `onOpen`/`onMessage`/`onClose`/`onError`, each `void \| Promise<void>`; a rejection routes to `onError`.                                                                            |
| `WebSocketRouteOptions`              | `packages/common/src/services/websocket.ts:331-353`                                                    | `{ protocols?, heartbeat? }` — confirmed: no middleware, no guard.                                                                                                                  |
| `IWebSocketConnection.data`          | `packages/common/src/services/websocket.ts:174`                                                        | `Map<string, unknown>`, documented as "the socket-lifetime analogue of `IRequestContext.state`".                                                                                    |
| `WebSocketConnectionContext`         | `packages/common/src/services/websocket.ts:259-284`                                                    | `{ url, path, query, headers, protocol?, user? }`. `user` is the M73 principal threaded from `ctx.request.user`.                                                                    |
| websocket frame dispatch site        | `packages/websocket-plugin/src/services/websocket-service.ts:561`                                      | ONE call: `invoke(handlers.onMessage, target, data)`, fire-and-forget with rejections routed to `onError`.                                                                          |
| context snapshot timing              | `packages/websocket-plugin/src/services/websocket-service.ts:540-546`                                  | The connection context is built in the router BEFORE `onOpen` (M46 fix), so it is available at accept-decision time — which is what makes an upgrade guard possible.                |
| kernel upgrade phase                 | `packages/kernel/src/application/application.ts:726,659`                                               | "Tries a WebSocket upgrade **after the middleware pipeline** and before route matching" — the upgrade DOES traverse global middleware; it reaches no route middleware.              |
| §9 prerelease scope                  | `AI_GUIDELINES.md:9` scope note                                                                        | §9.2's deprecate-then-remove is **post-v1 only**; in `0.x` a breaking change needs a CHANGELOG entry with migration text instead.                                                   |
| `common` may ship pure helpers       | `AI_GUIDELINES.md` §2.1 + `registry.ts:189`                                                            | "types, interfaces, constants, and pure zero-dependency type utilities". `resolveRegistryEntry` is precedent for a pure function living in `common`.                                |
| `MessagingCommonOptions`             | `packages/messaging-plugin/src/interfaces/index.ts:186`                                                | The shared arm every one of the eight `MessagingPluginOptions` union members (`:392`) extends — so the new options are declared once, not per broker.                               |
| `IScheduler.delay`                   | `packages/common/src/services/scheduler.ts:127`                                                        | Exists alongside `cron` and `every`, which is what the `trigger` union in `SchedulerJobDefinition` dispatches over.                                                                 |
| `SchedulerUnavailableError`          | `packages/scheduler-plugin/src/errors.ts:29`                                                           | The M70l Workers refusal is a real exported class, so §4.1's "refused on Workers before any entry is read" describes existing behaviour rather than new work.                       |
| `ILifecycleApi.onInit`               | `packages/common/src/plugin.ts:334`                                                                    | `onInit(fn: () => void \| Promise<void>): void` — async is permitted, which lets the messaging arm await `subscribe` before the app serves.                                         |
| `common` barrel-exports test         | `packages/common/test/unit/barrel-exports.test.ts`                                                     | Already exists, so §6's row EXTENDS a committed gate rather than adding a new file.                                                                                                 |
| M71 state-key gate scope             | `test/state-key-convention.test.ts`                                                                    | Covers `ctx.state` only. `conn.data` is NOT covered — which is why C3 defers typed connection data to that gate's successor rather than solving it here.                            |
| `RequestHandler` / `respond`         | `packages/common/src/services/messaging.ts:74,168`                                                     | A FIFTH developer-supplied handler on non-HTTP ingress, returning `TRes` where the other four are void — the reason §3.12 defers it rather than folding it in.                      |
| no broker delivery count             | `packages/messaging-plugin/src/brokers/` (`kafka-broker.ts:423`)                                       | Brokers redeliver and none tracks an attempt number, so `attempt` is ABSENT on the messaging arm rather than a fabricated `1` (§3.3).                                               |
| dispatch sites hold no registry      | `job-processor.ts`, `job-executor.ts`, `websocket-service.ts`, `traced-broker.ts`                      | `grep -c IServiceRegistry` returns **0** in all four; `job-executor.ts:38` already takes six positional parameters. This is why `IngressContext.services` is cut (§3.3).            |
| executor runs inside the lock        | `packages/scheduler-plugin/src/services/scheduler-service.ts:450-470`                                  | `#runWithLock` acquires, returns early on a null token, and reaches the executor only afterwards — so wrapping at `job-executor.ts:63` is inside the lock by construction (§3.10).  |
| `ProcessOptions.concurrency`         | `packages/common/src/services/queue.ts:53`                                                             | Several jobs of one name run at once, which is why the envelope is per-item and immutable (§3.3a).                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                            | Resolution (picked side)                                                                                                                                                                                                           | Doc deliverable (same PR)                                                                                      |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| C1 | The M86 ROADMAP section cites "§9.2" for deprecating the untyped connection-data read. §9.2 is **post-v1 only** by its own scope note, so the citation is wrong for a `0.x` package.                | The citation is struck. Prerelease policy is §9's scope note: a breaking change ships with a CHANGELOG entry carrying migration text. The point is moot here because C3 defers the item.                                           | Correct the ROADMAP In-scope bullet; no §9.2 citation.                                                         |
| C2 | The ROADMAP names five packages (`common` + the four plugins). `cqrs-plugin` must also change, because §11.1 forbids the composer existing twice and the four plugins would otherwise each copy it. | Package list corrected to six. `cqrs-plugin`'s private `composePipeline` is deleted and its one call site uses the promoted composer — this **removes** a duplicate rather than adding one (the M55 precedent).                    | Correct the ROADMAP **Packages** bullet; note it in CHANGELOG as an internal change with no surface effect.    |
| C3 | The ROADMAP In-scope bullet lists typed connection data. Verified: `conn.data` is documented as the analogue of `ctx.state`, and M71's key-convention gate covers `ctx.state` **only**.             | **Deferred out of M86.** The honest fix is to extend M71's `<owner-package>:<kebab-key>` convention and its gate to `conn.data`, which is that milestone's successor. Shipping a typed accessor here would pre-empt that decision. | Correct the ROADMAP In-scope bullet; record the deferral in §9 of this plan and in the ROADMAP "Not in scope". |
| C4 | `common/src/services/websocket.ts:371` — the `IWebSocketService` `@example` resolves connection data with `as string`, a cast AI_GUIDELINES §11.8 forbids in `src`.                                 | The example is rewritten to narrow with `typeof` rather than cast, matching what X13 actually had to write. This is a JSDoc fix and changes no behaviour; the typed-accessor answer to it is C3's deferral.                        | Edit the `@example` in `common/src/services/websocket.ts`; no `PUBLIC_API.md` row changes.                     |
| C5 | `ARCHITECTURE.md` §10 documents the middleware pipeline as the framework's cross-cutting mechanism and describes HTTP only, so a reader concludes non-HTTP work has none.                           | ARCHITECTURE gains a subsection naming the second chain, its four consumers, and the explicit statement that the two are separate mechanisms that do not share middleware instances.                                               | New `ARCHITECTURE.md` subsection under §10.                                                                    |

### 2.1 Per-package documentation deliverables

The first draft of this plan named C1-C5 and stopped, so the routine per-package documentation a
surface change owes was unlisted — README did not appear in it once. Six packages change surface, so
each owes three artifacts and they ship in the SAME PR (§10.2, §10.5, §9.4):

| Package            | `PUBLIC_API.md`                                                      | Package README                          | `CHANGELOG.md`                                                              |
| ------------------ | -------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| `common`           | New Ingress section (§4 symbols); `WebSocketRouteOptions.guards` row | Exports table rows                      | Added: ingress contract, composer, guard types                              |
| `websocket-plugin` | `routes`, `behaviors`, `guards` option rows                          | Options table + the §3.11 dispatch note | Added: three options; Note: dispatch becomes promise-mediated under a chain |
| `queue-plugin`     | `processors`, `behaviors` option rows                                | Options table                           | Added: two options                                                          |
| `scheduler-plugin` | `jobs`, `behaviors` option rows                                      | Options table + the §3.10 lock note     | Added: two options                                                          |
| `messaging-plugin` | `subscriptions`, `behaviors` rows on `MessagingCommonOptions`        | Options table + the §3.12 `respond` gap | Added: two options                                                          |
| `cqrs-plugin`      | No surface change (the deleted composer was internal)                | No change                               | Changed: internal composer promoted to `common`, no observable effect       |

**Three of the six READMEs are fence-compiled, and adding a fence to one FAILS the gate until a
constant moves.** `test/package-readme-fence-compiler.test.ts:55-78` holds a
`Record<path, expectedFenceCount>` and covers `common` (2), `websocket-plugin` (9) and
`queue-plugin` (8) among this milestone's packages; `scheduler-plugin`, `messaging-plugin` and
`cqrs-plugin` are absent. So:

- A new compilable example in the three covered READMEs must bump its count in that record, in the
  same commit. This is the kind of one-line omission that reads as an unrelated CI failure.
- **`scheduler-plugin` and `messaging-plugin` are deliberately NOT added to the gate here.** M70k
  recorded the reason at `test/package-readme-fence-compiler.test.ts:16` — pulling in the remaining
  40-odd READMEs surfaces a large pre-existing surface — and adopting two of them is a documentation
  workstream, not this milestone. Instead their new README examples are **copied verbatim from the
  integration tests in §6**, which do compile under `deno task check`, so the example is
  compiler-checked at its source rather than trusted.

## 3. Design decisions

### 3.1 The behaviour contract is a sibling in `common`, not a widened `IPipelineBehavior`

- **Decision:** `common/src/services/ingress.ts` declares `IIngressBehavior` with
  `handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void>`.
  `IPipelineBehavior` is **not** modified and stays in `cqrs.ts`.
- **Why:** `IPipelineBehavior` is constrained `TRequest extends CqrsRequest` (`cqrs.ts:86`), and
  `CqrsRequest` is `{ type, data }` (`cqrs.ts:19`) — a queue job, a cron tick and a socket frame
  satisfy none of it. Relaxing that constraint is source-compatible, but it would put a
  CQRS-namespaced type on four transports that have no commands, against §10.4 naming, and it would
  leave the two contracts differing invisibly in their result type: a CQRS behaviour returns
  `TResult`, and all four ingress handlers are void-returning (verified at `queue.ts:32`,
  `scheduler.ts:36`, `messaging.ts:36`, `websocket.ts:308`). Two names for two contracts is the
  honest shape; the shared part is the composer, not the interface.
- **Test home:** `packages/common/test/unit/ingress-contract.test.ts`.

### 3.2 One composer, promoted to `common`, with `cqrs-plugin` delegating

- **Decision:** `common/src/services/ingress.ts` exports
  `composeBehaviorChain<TWork, TResult>(work, behaviors: readonly BehaviorLike<TWork, TResult>[], terminal: () => Promise<TResult>): Promise<TResult>`
  and the structural `BehaviorLike<TWork, TResult>`. `cqrs-plugin`'s private `composePipeline` is
  deleted; `request-bus.ts:86` calls the promoted function. `IPipelineBehavior` and
  `IIngressBehavior` both satisfy `BehaviorLike` structurally, so neither needs to change.
- **Why:** the loop is eight lines and four plugins need it; §11.1 forbids the copies, and §2.1
  permits a pure zero-dependency helper in `common` (`resolveRegistryEntry` at `registry.ts:189` is
  the precedent). Promoting DELETES a duplicate rather than creating one, which is the M55 test for
  when a promotion is right.
- **Test home:** `packages/common/test/unit/compose-behavior-chain.test.ts`, plus
  `packages/cqrs-plugin/test/unit/pipeline-delegation.test.ts` asserting the CQRS ordering and
  short-circuit behaviour is unchanged after delegation.

### 3.3 The work envelope is `IngressContext` — four fields, all readonly

- **Decision:** `IngressContext<TPayload = unknown>` carries exactly
  `{ readonly kind: IngressKind; readonly name: string; readonly payload: TPayload; readonly attempt?: number; readonly headers?: Readonly<Record<string, string>> }`,
  where `IngressKind = 'queue' | 'scheduler' | 'messaging' | 'websocket'`. The handler keeps its
  native signature; only the behaviour chain sees the envelope. There is **no `state` slot and no
  `services` member** — both were in the first draft of this plan and both are cut; see below.
- **Why the four that stay:** the handlers take different shapes and two of them take two arguments
  (`MessageHandler` at `messaging.ts:36`, `onMessage` at `websocket.ts:308`), so a chain wrapping
  all four needs one normalized object. `headers` is populated for the messaging arm only, from the
  `MessageMetadata.headers` M75 made a populated contract.
- **Why `state` is cut:** it had no reader. Its only stated purpose was as the attach point for a
  tenant or trace behaviour, and §0 puts that work in a successor — so by §4's own dead-surface rule
  it gets cut before implementing, not stored. It is also structurally write-only: the handler
  receives its NATIVE argument (`IJob`, `ScheduledJob`, `(message, metadata)`, `(conn, data)`) and
  never the envelope, so nothing a behaviour wrote to `state` could ever be read by the handler it
  wraps. The successor that wires tenancy decides how a behaviour reaches a handler, and that is a
  contract question, not a field this milestone can guess.
- **Why `services` is cut:** it is unreachable AND redundant. Unreachable —
  `grep -c IServiceRegistry` returns **0** at all four dispatch sites (`job-processor.ts`,
  `job-executor.ts`, `websocket-service.ts`, `traced-broker.ts`), and `job-executor.ts:38` is a free
  function already taking six positional parameters, so supplying it means threading a registry
  through four packages. Redundant — every `behaviors` arm accepts a `RegistryFactory`, which is
  handed the registry at `onInit`, so a behaviour needing a capability closes over it:
  `(services) => new TenantBehavior(services.get(CAPABILITIES.MULTI_TENANCY))`. Putting the registry
  on every work item as well would be a second way to do what the factory arm exists for.
- **Why `attempt` is optional:** it is present for queue (from `IJob.attempts`, `queue.ts:22`) and
  scheduler (from `ScheduledJob.attempts`, `scheduler.ts:27`), both 1-based, and **absent** for
  messaging and websocket. The first draft said `1` for ingresses that do not retry; that is false
  for messaging, where brokers redeliver — `kafka-broker.ts:423` describes exactly that — while no
  broker tracks a delivery count, so a fabricated `1` would tell a behaviour "first attempt" on a
  fifth redelivery. Absent means "this ingress cannot tell you", never "first try".
- **Test home:** `packages/common/test/unit/ingress-contract.test.ts` for the shape and the
  `attempt` presence rule; each plugin behaviour test asserts the envelope its dispatch site builds.

### 3.3a The envelope is built per work item and is immutable

- **Decision:** each dispatch site constructs a fresh `IngressContext` for every job, tick, message
  or frame, and every field is `readonly`. No envelope is reused across invocations.
- **Why:** `ProcessOptions.concurrency` (`queue.ts:53`) runs several jobs of one name at once, so an
  envelope built once per registration would be shared by concurrent work. With a mutable `state`
  slot that is a cross-tenant leak in the exact milestone whose stated security half is tenant
  propagation; cutting `state` (§3.3) removes the sharp edge, and constructing per item plus
  `readonly` removes the class. Building an object per work item is not a cost worth optimizing
  against a job that is already doing I/O.
- **Test home:** `queue-plugin/test/integration/queue-behaviors.test.ts` runs two jobs concurrently
  under `concurrency: 2` and asserts each behaviour invocation saw a distinct envelope instance.

### 3.4 Behaviour ordering, short-circuit and error semantics match CQRS exactly

- **Decision:** `behaviors[0]` runs first (declared order equals execution order); a behaviour
  short-circuits by returning without calling `next()`, which skips the handler; a behaviour that
  throws propagates to that ingress's existing failure path — the queue's retry/dead-letter
  machinery, the scheduler's retry machinery, the messaging handler's existing rejection path, and
  `WebSocketHandlers.onError` for a frame.
- **Why:** one set of semantics across five consumers is the whole reason for a shared contract, and
  these are the semantics `composePipeline` already implements
  (`cqrs-plugin/src/behaviors/pipeline-behavior.ts:23-35`), so nothing has to be relearned.
  Propagating rather than swallowing follows §11.7; routing a frame behaviour's throw to `onError`
  keeps the socket contract at `websocket.ts:324` intact rather than inventing a second error path.
- **Test home:** one shared table in each plugin's `*-behaviors.test.ts`; the short-circuit case is
  mandatory per the CLAUDE.md self-review checklist.

### 3.5 Registration arms follow M70d without deviation

- **Decision:** `WebSocketPluginOptions.routes`, `QueuePluginOptions.processors`,
  `SchedulerPluginOptions.jobs`, `MessagingPluginOptions.subscriptions`, and a `behaviors` arm on
  all four. Every arm takes `readonly (T | RegistryFactory<T>)[]`. Arms are split once at plugin
  construction; instances keep `register()` timing; factories resolve in `ctx.lifecycle.onInit` via
  `resolveRegistryEntry`, carrying the index they hold in the DECLARED array.
- **Why:** copied verbatim from `health-plugin/src/plugin/health-plugin.ts:65,77-84,118-126`,
  including the declared-index detail, which exists because filtering first made the error label
  name a different, working entry whenever the two arms were mixed. `onInit` is the first phase at
  which the registry holds every capability.
- **Test home:** each plugin's `*-registration.test.ts`, including a factory that throws and a mixed
  instance/factory array whose error names the right index.

### 3.6 The WebSocket upgrade takes route-scoped guards, not kernel middleware

- **Decision:** `WebSocketRouteOptions.guards?: readonly WebSocketUpgradeGuard[]`, where
  `WebSocketUpgradeGuard = (context: WebSocketConnectionContext) => WebSocketGuardDecision | Promise<WebSocketGuardDecision>`
  and `WebSocketGuardDecision = true | { readonly status: number; readonly body?: string }`. Guards
  run in the router, in declared order, before the handshake is accepted; the first non-`true`
  decision refuses. `IWebSocketService.routeUpgrade`'s signature does not change.
- **Why:** the kernel holds an `IRequestContext` but `routeUpgrade` receives only
  `(request, principal?)` (`websocket.ts:431`), so a kernel `IMiddleware` cannot be run per route
  without widening a committed signature. It is also unnecessary: M73 already threads the principal
  into `WebSocketConnectionContext.user` (`websocket.ts:284`), and M46 moved the context snapshot
  into the router (`websocket-service.ts:540-546`), so everything a guard needs is present at
  accept-decision time. A predicate over the context is a smaller contract than middleware and
  cannot mutate a response that does not exist yet — the 101 carries no middleware-written headers,
  which is a limit M70a already documented.
- **Test home:** `packages/websocket-plugin/test/integration/upgrade-guards.test.ts`, including the
  negative control in §6 — a guard on one route must not run for a second route.

### 3.7 Frame behaviours are plugin-level; upgrade guards are route-level

- **Decision:** `WebSocketPluginOptions.behaviors` wraps `onMessage` for every route.
  `WebSocketRouteOptions.guards` is per route. No route-level `behaviors` arm ships.
- **Why:** the other three ingresses register behaviours per plugin, so a plugin-level frame chain
  is the consistent shape; a per-route chain is surface with no consumer named in §4, and §4's own
  rule cuts it before implementation. Guards must be per route because the whole defect is that the
  only available guard today is application-wide.
- **Test home:** `packages/websocket-plugin/test/integration/frame-behaviors.test.ts`.

### 3.8 Messaging attaches the chain with a decorator, not per broker

- **Decision:** a new internal `PipelinedBroker implements MessageBrokerAdapter` wraps the chosen
  broker and composes the chain inside `subscribe`/`subscribeWithHeaders`. It is applied in
  `messaging-plugin/src/plugin/messaging-plugin.ts` next to the existing `TracedBroker` wrap, and
  only when at least one behaviour is configured.
- **Why:** ten broker arms ship, and touching each is ten copies of one concern (§11.1). The
  decorator precedent is committed and consumed: `TracedBroker` at `tracing/traced-broker.ts:18` is
  wired as `broker = new TracedBroker(broker, telemetry, brokerType)` at `messaging-plugin.ts:239`.
  Wrapping only when behaviours exist keeps the zero-configuration path free of an extra frame.
- **Test home:** `packages/messaging-plugin/test/unit/pipelined-broker.test.ts` plus a conformance
  test driving `InMemoryBroker` through the plugin.

### 3.9 Nothing existing changes behaviour when no new option is set

- **Decision:** every arm defaults to `[]`; with no behaviours configured, each dispatch site calls
  its handler exactly as it does today, with no chain allocated and no decorator applied. The four
  imperative entry points (`IQueue.process`, `IScheduler.cron`/`every`/`delay`,
  `IMessageBroker.subscribe`, `IWebSocketService.route`) keep working unchanged and may be mixed
  with the arms.
- **Why:** §9.4 forbids silently changing released behaviour, and the arms are additions rather than
  replacements. An application on `0.2.0` must be able to upgrade with no edit.
- **Test home:** one `no-options-unchanged.test.ts` per plugin asserting the handler is invoked with
  the identical argument and that no chain is built.

### 3.10 Scheduler behaviours run INSIDE the distributed lock

- **Decision:** the chain wraps the handler call at `jobs/job-executor.ts:63`, which
  `scheduler-service.ts#runWithLock` reaches only after `this.#lock.acquire(...)` returns a non-null
  token (`:453`, then the executor in the following `try`). A replica that loses the lock runs no
  behaviour for that fire.
- **Why:** a behaviour is a cross-cutting concern around WORK, and on a losing replica no work
  happens. Running the chain outside the lock would make every metric, log line and span fire once
  per replica per tick while the job ran once — which is M70l's duplicate-execution defect
  reappearing in the observability layer, and it would be measured as real load. Wrapping at `:63`
  needs no code movement; this decision records that the position is deliberate rather than
  incidental.
- **Test home:** `scheduler-plugin/test/integration/scheduler-behaviors.test.ts` — with a lock that
  refuses, the handler does not run and neither does the behaviour.

### 3.11 Configuring behaviours makes frame dispatch promise-mediated, and that is documented

- **Decision:** with at least one behaviour configured, a synchronous `onMessage` is invoked through
  the chain and therefore after a microtask rather than synchronously. `invoke` stays the outer
  call, so the rejection path to `onError` is unchanged. This is stated in the websocket README, in
  `PUBLIC_API.md`, and in the CHANGELOG entry for the option.
- **Why:** the chain returns a promise by construction, and pretending otherwise would mean a
  synchronous fast path that behaves differently from the async one — two code paths for one
  capability. Documenting the consequence is honest; hiding it is how an ordering change becomes a
  bug report. With no behaviours configured, §3.9 keeps dispatch byte-identical, so an application
  that adds none never sees this.
- **Test home:** `websocket-plugin/test/integration/frame-behaviors.test.ts` asserts a synchronous
  handler still observes frames in arrival order under a chain.

### 3.12 RPC responders are named and deferred, not silently omitted

- **Decision:** `IMessageBroker.respond` (`messaging.ts:168`) and its `RequestHandler`
  (`messaging.ts:74`) get **no** arm and **no** chain in this milestone. The deferral is recorded in
  §9 with its owning successor.
- **Why:** it is a fifth developer-supplied handler on non-HTTP ingress, so leaving it unmentioned
  would be the omission this milestone exists to correct — but it does not fit the contract being
  built here. `RequestHandler` RETURNS `TRes`, where all four ingress handlers are void-returning
  (`queue.ts:32`, `scheduler.ts:36`, `messaging.ts:36`, `websocket.ts:308`); that is the CQRS shape,
  and `IIngressBehavior`'s `next: () => Promise<void>` cannot express it. Forcing it in would mean
  widening the ingress contract to carry a result nobody else has, or forking it — both of which
  trade this milestone's one-contract property for one more consumer.
- **Test home:** none — this is a scope decision. `§9` carries it, and
  `messaging-plugin/test/unit/pipelined-broker.test.ts` asserts `respond` is forwarded UNWRAPPED, so
  the deferral is pinned rather than assumed.

## 4. Exported surface — every symbol names its consumer

| Exported symbol            | Kind      | Consumer / real code path that READS it                                                                                                                                                 |
| -------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IngressKind`              | type      | `IngressContext.kind`; a behaviour branches on it — asserted in the messaging and queue behaviour tests.                                                                                |
| `IngressContext<T>`        | interface | Built by all four dispatch sites; the parameter type of `IIngressBehavior.handle`. Four fields only — `state` and `services` were cut in §3.3 under this table's own dead-surface rule. |
| `IIngressBehavior`         | interface | The element type of all four `behaviors` arms.                                                                                                                                          |
| `BehaviorLike<TWork,TRes>` | interface | Parameter type of `composeBehaviorChain`; satisfied structurally by `IPipelineBehavior` and `IIngressBehavior`, which is what lets one composer serve both.                             |
| `composeBehaviorChain`     | function  | Called by all four plugin dispatch sites AND by `cqrs-plugin/src/bus/request-bus.ts:86` after the private copy is deleted.                                                              |
| `WebSocketUpgradeGuard`    | type      | The element type of `WebSocketRouteOptions.guards`; read by the router in `websocket-service.ts`.                                                                                       |
| `WebSocketGuardDecision`   | type      | Return type of `WebSocketUpgradeGuard`; the router branches on `true` versus the refusal object.                                                                                        |
| `WebSocketRouteEntry`      | type      | Element type of `WebSocketPluginOptions.routes` (`WebSocketRouteDefinition \| RegistryFactory<…>`), read by the plugin's `onInit`.                                                      |
| `WebSocketRouteDefinition` | interface | `{ path, handlers, options? }` — the declarative form of a `route()` call; read by the plugin's `onInit`.                                                                               |
| `QueueProcessorEntry`      | type      | Element type of `QueuePluginOptions.processors`, read by the plugin's `onInit`.                                                                                                         |
| `QueueProcessorDefinition` | interface | `{ name, processor, options? }`; read by the plugin's `onInit`.                                                                                                                         |
| `SchedulerJobEntry`        | type      | Element type of `SchedulerPluginOptions.jobs`, read by the plugin's `onInit`.                                                                                                           |
| `SchedulerJobDefinition`   | type      | A union discriminated on `trigger` (`'cron' \| 'every' \| 'delay'`), so a cron entry without an expression is a compile error (the M30 precedent).                                      |
| `SubscriptionEntry`        | type      | Element type of `MessagingPluginOptions.subscriptions`, read by the plugin's `onInit`.                                                                                                  |
| `SubscriptionDefinition`   | interface | `{ topic, handler, options? }`; read by the plugin's `onInit`.                                                                                                                          |

`PipelinedBroker` is deliberately NOT exported: it reaches an application only as a
`MessageBrokerAdapter`, and `deno doc --lint` rejects an export leaking that internal type — the
`BigtableTransaction` and `CosmosTransaction` precedent from M81/M82.

### 4.1 Options — every option names its consumer

| Option                                 | Consumer                                                   | Behavior (per implementation)                                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WebSocketPluginOptions.routes`        | `websocket-plugin/src/plugin/websocket-plugin.ts` `onInit` | Each entry calls `service.route(path, handlers, options)`. Absent, no route is declared and only imperative `route()` calls exist.                                 |
| `WebSocketPluginOptions.behaviors`     | `websocket-service.ts:561` frame dispatch                  | Wraps `onMessage` for every route. Absent, `invoke(handlers.onMessage, …)` is called directly with no chain allocated.                                             |
| `WebSocketRouteOptions.guards`         | `websocket-service.ts` router, at accept-decision time     | Runs in declared order before the handshake; first non-`true` decision refuses with its status. Absent, every upgrade that matched the path is accepted, as today. |
| `QueuePluginOptions.processors`        | `queue-plugin/src/plugin/queue-plugin.ts` `onInit`         | Each entry calls `queue.process(name, processor, options)`.                                                                                                        |
| `QueuePluginOptions.behaviors`         | `queue-plugin/src/processors/job-processor.ts:104`         | Wraps `await processor(job)`. A throw reaches the existing retry/dead-letter path, including `ProcessOptions.onFailed` on the final attempt.                       |
| `SchedulerPluginOptions.jobs`          | `scheduler-plugin/src/plugin/scheduler-plugin.ts` `onInit` | Dispatches on `trigger` to `cron`/`every`/`delay`. Refused on Workers by the existing M70l `SchedulerUnavailableError`, before any entry is read.                  |
| `SchedulerPluginOptions.behaviors`     | `scheduler-plugin/src/jobs/job-executor.ts:63`             | Wraps `await handler(job)`. A throw reaches the existing retry machinery, so `RetryOptions` is honoured unchanged.                                                 |
| `MessagingPluginOptions.subscriptions` | `messaging-plugin/src/plugin/messaging-plugin.ts` `onInit` | Each entry awaits `broker.subscribe(topic, handler, options)`. `onInit` may be async, so the subscription is established before the app serves.                    |
| `MessagingPluginOptions.behaviors`     | `messaging-plugin/src/pipeline/pipelined-broker.ts`        | Wraps the handler inside `subscribe`. Applied only when the array is non-empty, so the zero-configuration broker chain is unchanged.                               |

## 5. Implementation files

| File                                                          | Purpose                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/ingress.ts`                     | NEW. `IngressKind`, `IngressContext`, `IIngressBehavior`, `BehaviorLike`, `composeBehaviorChain`.           |
| `packages/common/src/services/websocket.ts`                   | EDIT. `WebSocketUpgradeGuard`, `WebSocketGuardDecision`, `WebSocketRouteOptions.guards`; C4 `@example` fix. |
| `packages/common/src/index.ts`                                | EDIT. Barrel re-exports for every §4 symbol.                                                                |
| `packages/cqrs-plugin/src/behaviors/pipeline-behavior.ts`     | DELETE. Its one caller uses `composeBehaviorChain`.                                                         |
| `packages/cqrs-plugin/src/bus/request-bus.ts`                 | EDIT. Import the promoted composer.                                                                         |
| `packages/websocket-plugin/src/interfaces/index.ts`           | EDIT. `routes`, `behaviors`, `WebSocketRouteDefinition`, `WebSocketRouteEntry`.                             |
| `packages/websocket-plugin/src/plugin/websocket-plugin.ts`    | EDIT. Arm split at construction; `onInit` resolution.                                                       |
| `packages/websocket-plugin/src/services/websocket-service.ts` | EDIT. Guard evaluation in the router; behaviour chain around the `:561` dispatch.                           |
| `packages/queue-plugin/src/interfaces/index.ts`               | EDIT. `processors`, `behaviors`, `QueueProcessorDefinition`, `QueueProcessorEntry`.                         |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`            | EDIT. Arm split; `onInit` resolution.                                                                       |
| `packages/queue-plugin/src/processors/job-processor.ts`       | EDIT. Behaviour chain around the `:104` dispatch.                                                           |
| `packages/scheduler-plugin/src/interfaces/index.ts`           | EDIT. `jobs`, `behaviors`, `SchedulerJobDefinition`, `SchedulerJobEntry`.                                   |
| `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`    | EDIT. Arm split; `onInit` resolution after the Workers refusal.                                             |
| `packages/scheduler-plugin/src/jobs/job-executor.ts`          | EDIT. Behaviour chain around the `:63` dispatch.                                                            |
| `packages/messaging-plugin/src/interfaces/index.ts`           | EDIT. `subscriptions`, `behaviors` on `MessagingCommonOptions`, so all eight union arms inherit them.       |
| `packages/messaging-plugin/src/pipeline/pipelined-broker.ts`  | NEW. Internal decorator composing the chain inside `subscribe`.                                             |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`    | EDIT. Wrap with `PipelinedBroker` when behaviours exist; `onInit` subscription resolution.                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                             | src covered                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/compose-behavior-chain.test.ts`                     | `services/ingress.ts` (composer)    | Declared order equals execution order; a behaviour returning without `next()` skips the terminal; a throw propagates; empty array calls the terminal once. Calls type-check against `BehaviorLike<IngressContext, void>` AND `BehaviorLike<CqrsRequest, unknown>`, which is the proof one composer serves both.          |
| `common/test/unit/ingress-contract.test.ts`                           | `services/ingress.ts` (types)       | Compile-time assertions that `IPipelineBehavior` and `IIngressBehavior` are both assignable to `BehaviorLike`; `IngressKind` exhaustiveness over a `switch`.                                                                                                                                                             |
| `common/test/unit/websocket-guard-types.test.ts`                      | `services/websocket.ts` (additions) | `WebSocketGuardDecision` accepts `true` and the refusal object and rejects a bare number; `guards` is optional so an existing `WebSocketRouteOptions` literal still type-checks.                                                                                                                                         |
| `common/test/unit/barrel-exports.test.ts` (EXTEND)                    | `src/index.ts`                      | Every §4 symbol is exported from the barrel. Compile-time, declared against the barrel — the M56/M70m defect class, where dropping an export left every runtime assertion green.                                                                                                                                         |
| `cqrs-plugin/test/unit/pipeline-delegation.test.ts`                   | `bus/request-bus.ts`                | Ordering, short-circuit and result propagation are unchanged after delegation; captured against the pre-change behaviour so the promotion is proven byte-equivalent, not merely compiling.                                                                                                                               |
| `websocket-plugin/test/unit/route-registration.test.ts`               | `plugin/websocket-plugin.ts`        | Instance and factory arms both register; a throwing factory rejects `start()` naming `WebSocketPlugin({ routes })[N]` with the DECLARED index in a mixed array.                                                                                                                                                          |
| `websocket-plugin/test/integration/upgrade-guards.test.ts`            | `services/websocket-service.ts`     | A guard refusing with `{ status: 401 }` prevents the handshake; **negative control: a guard on `/ws/a` does not run for `/ws/b`** — the property the current application-wide workaround cannot express.                                                                                                                 |
| `websocket-plugin/test/integration/frame-behaviors.test.ts`           | `services/websocket-service.ts`     | A behaviour observes `kind: 'websocket'`, `name` equal to the route path, and the frame as `payload`; a short-circuit prevents `onMessage`; a throw reaches `onError` rather than becoming unhandled; a synchronous handler still observes frames in arrival order under a chain (§3.11).                                |
| `websocket-plugin/test/integration/no-options-unchanged.test.ts`      | `services/websocket-service.ts`     | With no `behaviors`, `onMessage` receives the identical `(conn, data)` arguments and is invoked **synchronously** — asserted by observing the handler ran before the next statement, which is the observable form of "no chain". Reading a private field would prove nothing a refactor could not break.                 |
| `queue-plugin/test/unit/processor-registration.test.ts`               | `plugin/queue-plugin.ts`            | Both arms register; declared-index error attribution; an imperative `process()` call and an arm entry coexist.                                                                                                                                                                                                           |
| `queue-plugin/test/integration/queue-behaviors.test.ts`               | `processors/job-processor.ts`       | Envelope carries `kind: 'queue'`, the job name, and `attempt` equal to `IJob.attempts`; **under `concurrency: 2` two in-flight jobs see two distinct envelope instances** (§3.3a); short-circuit skips the processor; a behaviour throw reaches the retry path and fires `ProcessOptions.onFailed` on the final attempt. |
| `queue-plugin/test/integration/no-options-unchanged.test.ts`          | `processors/job-processor.ts`       | With no `behaviors`, `processor(job)` is called with the identical job object and no extra microtask is interposed (observable, not a private read).                                                                                                                                                                     |
| `scheduler-plugin/test/unit/job-registration.test.ts`                 | `plugin/scheduler-plugin.ts`        | The `trigger` union dispatches to `cron`/`every`/`delay`; a cron entry missing `expression` is a compile error (`@ts-expect-error`, self-validating); the Workers refusal precedes any entry read.                                                                                                                       |
| `scheduler-plugin/test/integration/scheduler-behaviors.test.ts`       | `jobs/job-executor.ts`              | Envelope carries `kind: 'scheduler'` and the 1-based `attempt`; a behaviour throw is retried per `RetryOptions` rather than swallowed; **a lock that refuses runs neither handler nor behaviour** (§3.10).                                                                                                               |
| `scheduler-plugin/test/integration/no-options-unchanged.test.ts`      | `jobs/job-executor.ts`              | With no `behaviors`, `handler(job)` is called with the identical job object and no extra microtask is interposed (observable, not a private read).                                                                                                                                                                       |
| `messaging-plugin/test/unit/pipelined-broker.test.ts`                 | `pipeline/pipelined-broker.ts`      | The decorator forwards every `MessageBrokerAdapter` member; the chain wraps only the subscribe handler; **`respond` is forwarded UNWRAPPED**, pinning the §3.12 deferral; `headers` from `MessageMetadata` reach `IngressContext.headers`; the envelope carries no `attempt` on this arm (§3.3).                         |
| `messaging-plugin/test/integration/subscription-registration.test.ts` | `plugin/messaging-plugin.ts`        | Both arms subscribe through a real `InMemoryBroker` (§6.7 in-memory, no real backend); a message published after `start()` reaches an arm-registered handler.                                                                                                                                                            |
| `messaging-plugin/test/integration/no-options-unchanged.test.ts`      | `plugin/messaging-plugin.ts`        | With no `behaviors`, no `PipelinedBroker` is applied — asserted through the broker chain, not by reading a private field.                                                                                                                                                                                                |

Every `src/` file in §5 appears in this table. No file in this milestone loads an external package,
so no guarded real-import test is required; the messaging integration tests use `InMemoryBroker` per
§6.7.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m86-non-http-ingress, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree; six packages change surface
deno task release:verify <next-version>   # the RELEASE's version, not the milestone's; 0.2.0 is already published
```

Beyond the gates, the milestone is not done until the X13 collaboration route is expressible with
none of what X13 had to write. That proof lives at
`packages/websocket-plugin/test/e2e/declarative-route.test.ts`, NOT in `apps/`: it registers the
room route entirely through `WebSocketPluginOptions.routes` with a route-scoped guard, and asserts
the result has no `IPlugin` wrapper, no second copy of the path string, and no application-wide
middleware. A `test/e2e` file is committed, readable and gate-run, where a new `apps/` example would
need its own `deno.json`, a `smoke` task and `check:apps` wiring for a demonstration the suite
already has to make. (`apps/realtime-clients/src/app.ts` is the natural host should a runnable
example be wanted later; that is a documentation milestone's call, not this one's.)

## 8. Risks & mitigations

- A behaviour chain around the WebSocket frame dispatch changes a fire-and-forget call site
  (`websocket-service.ts:561` uses `invoke`, which routes rejections to `onError`) into one that
  awaits a promise → keep `invoke` as the outer call and pass it a wrapped handler, so the rejection
  path is unchanged; the `no-options-unchanged` test pins that.
- Deleting `cqrs-plugin`'s private composer touches a shipped, consumed path → the delegation test
  captures ordering, short-circuit and result propagation against the pre-change behaviour before
  the deletion, so a regression fails rather than compiles.
- The scheduler's `SchedulerJobDefinition` union is the one new type a caller writes by hand and a
  wrong `trigger` arm is silent if the union is loose → the arm is discriminated on `trigger` and
  the registration test carries a self-validating `@ts-expect-error` for a cron entry with no
  expression.
- Six packages change `src/index.ts` or options surface, so §10.2 approval and `PUBLIC_API.md` edits
  must ship in the same PR → tracked as C1–C5 doc deliverables plus per-package `PUBLIC_API.md`
  rows, and the extended `barrel-exports` test fails if a symbol is added without its row.
- `messaging-plugin` has ten broker arms and only `InMemoryBroker` is exercised in the plugin
  integration test → the decorator is the single insertion point (§3.8), so no broker is touched;
  the unit test asserts the decorator forwards every `MessageBrokerAdapter` member, which is what
  makes the untouched arms safe.

## 9. Out of scope

- **Decorators over the new arms** (`@Gateway`, `@Processor`, `@Cron`, `@Subscribe`). Deferred to a
  successor milestone once this seam exists. Shipping them first gives `@UseGuards` nothing to
  attach to, which is the M70n `@ValidateBody` defect (decorated routes, validated nothing) and the
  M58 `g controller` defect (500 on every request for five releases).
- **Wiring tenancy, auth and tracing through the chain.** M70b's successor owns it. This milestone
  makes them expressible; designing the seam and consuming it in one pass is what this repository's
  own review history warns against.
- **Typed connection data** (§2 C3). Owned by the M71 successor that extends the
  `<owner-package>:<kebab-key>` convention and `test/state-key-convention.test.ts` to cover
  `conn.data`.
- **RPC responders** — `IMessageBroker.respond` and its `RequestHandler` (§3.12). A fifth
  developer-supplied handler on non-HTTP ingress, deferred because it returns a value where all four
  ingress handlers are void, which is the CQRS shape rather than this contract's. Owned by whichever
  milestone next touches brokered request-reply; `pipelined-broker.test.ts` pins that `respond` is
  forwarded unwrapped so the gap stays visible.
- **CLI schematics for the new arms.** A `setu generate processor` belongs with the decorator
  milestone, since M60's seam registry keys on the artifact shape the schematic emits.
- **Widening `IPipelineBehavior`** (§3.1). Considered and rejected on naming and result-type
  grounds; recorded so a later reader does not re-open it as an oversight.
