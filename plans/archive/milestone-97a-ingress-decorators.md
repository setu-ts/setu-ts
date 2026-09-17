# Milestone 97a — Decorators for Non-HTTP Ingress (`@setu-ts/decorator-plugin`, `@setu-ts/cli`)

> **Status:** Complete (PR pending). Archived on completion. Branch: `feat/m97a-ingress-decorators`.
> `main` is protected — all work (implementation + fixes) stays on this one branch until it merges
> via a single PR.

## 0. Objective & scope

Give the six non-HTTP ingress categories the class-based registration surface HTTP has had since M9.
A class-based project today gets `@Controller` and then hand-writes an options array for every queue
processor, cron job, event handler, socket route, and command or query handler it owns, so
`--template class-based` describes one sixth of an application. This milestone adds one method
decorator per ingress to `decorator-plugin`, plus a single registration pass that resolves each
ingress capability optionally and registers what the metadata store holds, plus the CLI schematics
that emit them. **No ingress plugin's `src` changes**, **`packages/common` is not touched at all**,
no capability token is added, and no declarative options arm changes meaning. The package list is
`decorator-plugin` + `cli`; an earlier ROADMAP draft said `decorator-plugin` + `common`, corrected
once §3.6 resolved the metadata home (the M70b/M70g/M70k precedent).

- **In scope:** `@Processor`, `@Cron`, `@Every`, `@OnEvent`, `@Subscribe`, `@Gateway` +
  `@OnOpen`/`@OnMessage`/`@OnClose`, `@CommandHandler`, `@QueryHandler`, `@UseIngressBehaviors` and
  `@UsePipelineBehaviors`; a new `ingress` map on the package-private metadata store; one `onInit`
  registration pass; per-handler behaviour scoping; two startup refusals, one naming the absent
  plugin and one naming the unusable `@UseGuards`; a class-based arm on the EXISTING CLI schematics;
  README, `PUBLIC_API.md` and `ARCHITECTURE.md` updates.
- **NOT this milestone:** Any change to `queue-plugin`, `scheduler-plugin`, `messaging-plugin`,
  `events-plugin`, `cqrs-plugin` or `websocket-plugin` source. Any change to `IMetadataStore` in
  `common`. Automatic per-request DI scope (named unowned in `ROADMAP.md` M97). Response shaping for
  decorated HTTP handlers — M97b. Typed configuration sections — M97c. Filesystem auto-discovery of
  ingress classes; the class list stays explicit as `controllers` is.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                    | Source (file:line)                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M86 deferred exactly this                                    | `ROADMAP.md:8509-8514`                                                                          | "A `@Gateway`/`@Processor`/`@Cron`/`@Subscribe` surface is the natural follow-on and is deliberately deferred until the arms and the pipeline exist." The arms and the shared composer shipped in PR #228, so the stated precondition is met.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The registered queue service IS the behaviour wrapper        | `packages/queue-plugin/src/plugin/queue-plugin.ts:238,245,349,378-381`                          | `ctx.services.register<IQueue>(token, registrar)` registers `registrar`, which is `new TracedQueue(service, …)` when telemetry is present and otherwise `service`; `service` is `BehaviorChainQueueService` whose `override process()` wraps the processor in `withIngressBehaviors(processor, this.#behaviors, this.#chainReady)`. An imperative `process()` on the RESOLVED capability therefore inherits behaviours, the chain-ready gate and tracing.                                                                                                                                                                                                              |
| Same for messaging                                           | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:392-403`                              | `new PipelinedBroker(broker, behaviorChain, …)` is what `ctx.services.register<IMessageBroker>(token, broker)` receives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Same for scheduler                                           | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:159-172,274`                          | `ctx.services.register<IScheduler>('scheduler', service)` receives `BehaviorChainSchedulerService`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `IQueue.process`                                             | `packages/common/src/services/queue.ts:150`                                                     | `process<T>(name: string, processor: JobProcessor<T>, options?: ProcessOptions): void` — synchronous, `JobProcessor<T> = (job: IJob<T>) => void \| Promise<void>` (`:52`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IScheduler` registration is ASYNC                           | `packages/common/src/services/scheduler.ts:93,109,127`                                          | `cron`, `every` and `delay` each return `Promise<void>`; `SchedulerJobHandler<T> = (job: ScheduledJob<T>) => void \| Promise<void>` (`:36`). The registration pass must await them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `IMessageBroker.subscribe` handler shape                     | `packages/common/src/services/messaging.ts:36-39`                                               | `MessageHandler<T> = (message: T, metadata: MessageMetadata) => void \| Promise<void>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `IEventBus.subscribe`                                        | `packages/common/src/services/events.ts:39,82`                                                  | `subscribe<T>(type: string, handler: EventHandler<T>): Unsubscribe`, `EventHandler<T> = (event: IDomainEvent<T>) => void \| Promise<void>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ICommandBus`/`IQueryBus` registration                       | `packages/common/src/services/cqrs.ts:105,114,137,146`                                          | Both expose `register<TX, TResult>(...)`. `CAPABILITIES.COMMAND_BUS` and `CAPABILITIES.QUERY_BUS` are separate tokens from `CAPABILITIES.CQRS` (`packages/common/src/tokens.ts:89-93`), so the pass resolves the two buses directly.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `IWebSocketService.route`                                    | `packages/common/src/services/websocket.ts:323-344,430`                                         | `route(path, handlers: WebSocketHandlers, options?: WebSocketRouteOptions): void`; `WebSocketHandlers` has optional `onOpen(conn, context)`, `onMessage(conn, data)`, `onClose(conn, event)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `IIngressBehavior` and the composer                          | `packages/common/src/services/ingress.ts` (whole module)                                        | `IIngressBehavior.handle(ctx: IngressContext, next: () => Promise<void>)`; `IngressContext` carries `kind`/`name`/`payload` plus optional `attempt`/`headers`. `IngressKind` is `'queue' \| 'scheduler' \| 'messaging' \| 'websocket'` — it has **no CQRS arm**, and CQRS uses `IPipelineBehavior` instead.                                                                                                                                                                                                                                                                                                                                                            |
| `decorator-plugin` already uses the optional-dependency edge | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:867-872`                              | `provides: [CAPABILITIES.METADATA_STORE]`, `optionalDependencies: [VALIDATION, AUTHORIZATION, VIEW]`, `priority: PLUGIN_PRIORITY.LOW` (900, `packages/common/src/types.ts:90`). Adding the **seven** ingress provider tokens — `QUEUE`, `SCHEDULER`, `MESSAGING`, `EVENTS`, `COMMAND_BUS`, `QUERY_BUS`, `WEBSOCKET` — reuses a mechanism already present three times. Seven tokens, not six: the six ingress CATEGORIES map to seven tokens because `CqrsPlugin` provides `COMMAND_BUS` and `QUERY_BUS` as separate tokens (`packages/cqrs-plugin/src/plugin/cqrs-plugin.ts:111`) and §3.1 resolves both buses directly rather than going through `CAPABILITIES.CQRS`. |
| No dependency cycle exists                                   | `grep -rn METADATA_STORE packages/{queue,scheduler,messaging,events,cqrs,websocket}-plugin/src` | Returns **nothing** — no ingress plugin depends on what this plugin provides, so the `LoggerPlugin` ↔ `TelemetryPlugin` cycle M90i found (which threw at `start()`) cannot arise.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| The plugin has NO lifecycle hook today                       | `grep -n "ctx.lifecycle" packages/decorator-plugin/src/plugin/decorator-plugin.ts`              | Returns nothing: everything happens inside `register()`. The `onInit` hook this milestone adds is new to this plugin.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Standard decorator kinds                                     | `packages/decorator-plugin/src/metadata/context-bridge.ts:52,60-63,124-128`                     | `SetuMethodDecorator = (value: unknown, context: ClassMethodDecoratorContext) => void`; method decorators `defer(context.metadata, …)` and the class decorator flushes. Member decorators run BEFORE the class decorator and share its metadata object.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DecoratorPluginOptions`                                     | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:53-81`                                | `autoDiscover`, `controllersPath`, `controllers`, `services`, `modules`, `enforceSchemas`, `enforceRoles`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IMetadataStore` in `common` is NOT the channel              | `packages/common/src/plugin.ts:406-413`                                                         | It declares exactly three readonly maps — `controllers`, `services`, `routes`. The ingress map is added to the concrete `MetadataStore` class only, which is what keeps this a zero-`common` milestone (the M36b `mergeCtorParam`/`ctorInject` precedent).                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `docs/migration-nestjs.md:712-753` presents `WebSocketPlugin` + an imperative `ws.route(...)` after `start()` as the answer to `@WebSocketGateway`/`@SubscribeMessage`, and `packages/websocket-plugin/README.md` leads with the plugin-options form. Both become one of two ways once `@Gateway` exists.                 | Keep the options form as the primary documented route — it is what a functional project uses and what M86 built — and document `@Gateway` as the class-based alternative, not the replacement.                                                    | Add a `@Gateway` subsection to the websocket README and to `docs/migration-nestjs.md`'s WebSocket section, each stating which generator mode emits which.                                                                      |
| C2 | `ROADMAP.md:8510` says decorators are "out of scope" for M86. That sentence is scoped to M86 and is not a standing refusal, but a reader arriving at it after this milestone ships will read it as current.                                                                                                               | The M86 section is history and stays as written; M97a's own section carries the reversal and names the precondition that changed.                                                                                                                 | Append one sentence to the M86 "Decorators are out of scope" paragraph pointing at M97a, in the style the repo already uses for closed deferrals.                                                                              |
| C3 | `docs/decorators.md` documents the decorator surface as HTTP-only throughout; its "Available Decorators" listing has no non-HTTP entry.                                                                                                                                                                                   | The guide gains an ingress section rather than a rewrite; the HTTP material is unchanged.                                                                                                                                                         | New `## Non-HTTP Ingress` section in `docs/decorators.md` with one compiling fence per ingress, and the fence counts in `test/decorator-fence-compiler.test.ts` and `test/guide-fence-compiler.test.ts` bumped in the same PR. |
| C4 | `packages/cli/src/schematics/job.ts`'s module JSDoc states "`QueuePluginOptions` also publishes no `processors` list a barrel could feed", as the stated reason the artifact is deliberately unwired. That has been **false since M86**, which added `processors` at `packages/queue-plugin/src/interfaces/index.ts:263`. | The claim is corrected and the schematic stops being unwired in class-based mode (§3.8); it stays unwired in functional mode, because the rest of that JSDoc's reasoning — the CLI cannot pick a transport for a bare job function — still holds. | Rewrite `job.ts`'s module JSDoc to say which half of its rationale survived and which arm now wires.                                                                                                                           |

## 3. Design decisions

### 3.1 The registration channel is the resolved capability, never a plugin import

- **Decision:** For each ingress the pass resolves the capability token from `ctx.services` and
  calls its public registration method: `IQueue.process`, `IScheduler.cron`/`every`,
  `IMessageBroker.subscribe`, `IEventBus.subscribe`, `ICommandBus.register`/`IQueryBus.register`,
  `IWebSocketService.route`. Nothing reads or writes another plugin's options object.
- **Why:** AI_GUIDELINES §2.2 forbids a plugin importing a plugin, and every method above is
  declared in `common` (§1). It is also strictly better than the alternative of widening
  `IMetadataStore` and having six plugins each grow a metadata-reading path: that would be six
  copies of one read, and §1 establishes that registering on the resolved capability already
  inherits the behaviour chain, the chain-ready gate and tracing, which a bespoke path would have to
  re-derive.
- **Test home:** `test/integration/ingress-registration.test.ts` — one real kernel application per
  ingress, asserting the decorated handler receives real work.

### 3.2 The pass runs at `onInit`, once, and awaits the async registrations

- **Decision:** `register()` keeps doing everything it does today; a new `ctx.lifecycle.onInit(...)`
  hook performs the ingress pass. Scheduler registrations are awaited (§1: they return
  `Promise<void>`); the rest are synchronous and are still executed inside the same hook body so
  ordering is one place.
- **Why:** `onInit` is documented as running "after all plugins have registered"
  (`packages/common/src/plugin.ts:330-334`), which is the first phase at which every ingress
  capability exists and every ingress plugin's own behaviour chain is built. Registering during
  `register()` would race the ingress plugins' own chain construction, which is the defect M86's
  review found and fixed by gating delivery. Registering at `onBootstrap` would work equally for
  delivery but would place these registrations after an application plugin's own `onInit`, which is
  a surprising ordering for a class the application listed explicitly.
- **Test home:** `test/unit/ingress-pass-phase.test.ts` asserts the pass runs after a probe plugin's
  `register()` and that a scheduler registration is awaited before the hook resolves.

### 3.3 An absent ingress capability is a startup refusal, not a warning

- **Decision:** A class carrying an ingress decorator whose capability is not registered throws from
  the `onInit` pass of §3.2 — **not** from `register()` — naming the class, the decorated method,
  and the plugin that provides the capability.
- **Why (that it refuses at all):** This follows M92's `@Render` arm and deliberately not M70n's
  `@ValidateBody` warn arm. The two differ in whether silence has a defensible reading: an
  unenforced validation schema still serves the request, whereas a processor that never registers
  means the work is never done and nothing anywhere reports it. That is the M58 `g controller`
  failure shape, and a warning at startup is exactly what did not save it.
- **Why `onInit` and not `register()`:** an earlier draft of this plan said `register()`, which
  contradicts §3.2 and would refuse too early. `optionalDependencies` orders only plugins that
  DECLARE the capability in `provides`, while `ServiceRegistry` also accepts imperative
  registration, and the application registry is not sealed until after `runBootstrap()`
  (`packages/kernel/src/application/application.ts:505-506`) — so a capability registered by a
  `PLUGIN_PRIORITY.LOWEST` plugin, or imperatively from any plugin's `onRegister`/`onInit`, is
  invisible to a `register()`-time `has` check and the application would be refused for a capability
  it has. The refusal must be read at the same point the registration is attempted, which §3.2 fixes
  at `onInit`. This is also the one placement with no second source of truth: the pass resolves each
  token exactly once, and that single reading decides both the registration and the refusal.
- **Test home:** `test/unit/ingress-missing-capability.test.ts`, one case per ingress, asserting the
  message names both the class and the plugin, plus a case proving the refusal is NOT raised for a
  capability registered imperatively by a later plugin — the negative control for the paragraph
  above, which fails if the check moves back to `register()`.

### 3.4 Typed behaviour decorators, NOT `@UseGuards` — the two are structurally incompatible

- **Decision:** `@UseIngressBehaviors(...behaviors: readonly IIngressBehavior[])` is valid only on
  queue, scheduler, messaging, and WebSocket handlers, while
  `@UsePipelineBehaviors(...behaviors: readonly IPipelineBehavior[])` is valid only on command and
  query handlers. `@OnEvent` has no behaviour decorator: `IngressContext.kind` deliberately has no
  event arm, so fabricating one would widen a committed cross-plugin contract. Each supported arm
  scopes behaviours to ONE handler by composing them into the terminal the pass registers with
  `composeBehaviorChain` — not by contributing to the owning plugin's application-wide `behaviors`
  arm. **`@UseGuards` on an ingress method is REFUSED at startup** under §3.3, naming the
  appropriate typed behaviour decorator as the replacement.
- **Why:** An earlier draft of this plan reused `@UseGuards`, and that does not type-check.
  `MiddlewareFunction` is `(ctx: IRequestContext, next: NextFunction) => …`
  (`packages/common/src/http.ts:362-365`) while `IIngressBehavior.handle` takes an `IngressContext`
  (`packages/common/src/services/ingress.ts`), and the two contexts share no member: a real guard
  such as `requireRole()` reads `ctx.request.user` and writes `ctx.response`, neither of which an
  ingress path has. Bridging would mean fabricating an `IRequestContext` for work that carries no
  request — the "synthetic context widening" `test/guide-fence-compiler.test.ts` has a named step
  rejecting. The refusal rather than a silent ignore is the whole point: a stored-and-unread
  `@UseGuards` is precisely the "silently do nothing" outcome `ROADMAP.md:8511` gives as the reason
  this milestone was deferred.
- **Scoping is still the deliverable M86 named.** The `behaviors` arm is application-wide by
  construction, so contributing there would make a behaviour declared on one processor run for every
  processor; composing at the registration site is the only placement that gives per-handler scope.
- **Test home:** `test/integration/ingress-guard-scope.test.ts` — the negative control M86's
  verification bar names: a behaviour on ONE processor is proven not to run for a second processor
  in the same application. `test/unit/ingress-missing-capability.test.ts` covers the `@UseGuards`
  refusal.

### 3.5 CQRS uses `IPipelineBehavior`; type safety belongs in the decorator spelling

- **Decision:** `@CommandHandler`/`@QueryHandler` register through `ICommandBus`/`IQueryBus`, and
  `@UsePipelineBehaviors` takes an `IPipelineBehavior`, while the four behaviour-capable ingress
  categories use `@UseIngressBehaviors` and `IIngressBehavior`. The registration pass refuses a
  _decorator-kind_ mismatch (for example, `@UsePipelineBehaviors` beside `@Processor`) at startup.
- **Why separate spellings are necessary:** the prior `@UseBehaviors` union proposed a runtime
  rejection of the wrong interface. That is impossible: both interfaces are structural objects with
  a `handle` method, carry no brand or discriminant, and a runtime test can only establish that a
  value has a callable `handle`, which both satisfy. A method decorator also cannot inspect a
  sibling decorator at type-check time. The separate factories make the behavior value type-check at
  the call site, and their recorded metadata makes the handler-kind mismatch observable at startup.
  This is a real guarantee rather than an unimplementable one.
- **Why the two types stay separate at all:** §1 establishes that `IngressKind` has no CQRS arm and
  that `services/ingress.ts` states in its own module doc that `IPipelineBehavior` was deliberately
  not widened, because its `TRequest extends CqrsRequest` constraint cannot describe a queue job and
  its result type cannot describe four void-returning handlers. Forcing CQRS into `IngressContext`
  would reverse a decision M86 recorded with reasons.
- **Test home:** `test/integration/cqrs-decorator.test.ts` asserts a decorated command handler
  executes through the bus and that a pipeline behaviour wraps it.
  `test/unit/ingress-behavior-kind.test.ts` covers both decorator-kind mismatches and a positive
  case per arm; `test/type/ingress-behavior-typing.test.ts` proves each factory rejects the other
  interface at the call site.

### 3.6 The ingress metadata lives on the concrete `MetadataStore`, not on `IMetadataStore`

- **Decision:** `MetadataStore` gains an `ingress: Map<Constructor, readonly IngressMetadata[]>`
  member. `IMetadataStore` in `common` is unchanged.
- **Why:** §1 records that `IMetadataStore` declares exactly three maps and that the M36b
  parameter-`@Inject` work solved the identical problem the same way — concrete-class members, no
  `common` change, no new token. Nothing outside this package reads the ingress metadata, because
  §3.1 makes the registration push rather than pull.
- **Test home:** `test/unit/barrel-exports.test.ts` asserts `src/index.ts` is unchanged apart from
  the new decorators, and a compile-time assertion pins that `IMetadataStore` still declares three
  maps.

### 3.7 `@Gateway` is a class decorator carrying the path; the frame handlers are method decorators

- **Decision:** `@Gateway(path)` on the class; `@OnOpen`, `@OnMessage`, `@OnClose` on methods. The
  pass assembles one `WebSocketHandlers` object per gateway class and calls `route(path, handlers)`
  once.
- **Why:** `route()` takes one handlers object per path (§1), so a per-method registration is not
  expressible. A gateway class with no `@Gateway` path but carrying frame decorators is the M64
  cross-copy signal and is refused under §3.3.
- **Test home:** `test/integration/gateway.test.ts` drives a real socket through a real kernel
  application.

### 3.8 The CLI gains class-based ARMS on existing schematics, never new schematics

- **Decision:** `job.ts`, `ws-route.ts`, `event-handler.ts`, `command-handler.ts` and
  `query-handler.ts` each gain a `generatorMode(options.plugins) === 'class-based'` arm, the
  mechanism `controller.ts:94` and `route.ts:30` already use. No `processor.ts`, `cron.ts` or
  `gateway.ts` file is created.
- **Why:** An earlier draft of this plan added all three, which is §11.1 duplication — `job.ts`
  already emits "a job processor usable by the queue or scheduler plugin" and `ws-route.ts` already
  emits a WebSocket route (added by M84 in `ab0aba27`, superseding M70i's decline; §9 corrected).
  Two schematics for one artifact would give `setu g` two names for one thing and leave the older
  one emitting the shape this milestone exists to replace.
- **Test home:** `packages/cli/test/unit/ingress-schematics.test.ts` asserts each schematic's two
  arms and that the registry gained no new verb.

### 3.9 One ingress seam, and a mode picks exactly one registration site

- **Decision:** A single new `SeamSpec` (`packages/cli/src/seams/ingress.ts`) owns the barrel
  feeding `DecoratorPluginOptions.ingress`. For each artifact, `generatorMode` selects **exactly
  one** seam: functional mode keeps today's family seam (`seams/events.ts`, `seams/cqrs.ts`),
  class-based mode uses the ingress seam instead.
- **Why:** `seams/events.ts` and `seams/cqrs.ts` already regenerate barrels feeding
  `EventsPluginOptions.handlers` and `CqrsPluginOptions.commandHandlers` through M70d factories. An
  artifact reaching BOTH sites would be registered twice — an event handler subscribed twice runs
  twice per event, silently. That is the M60 duplicate-registration hazard, which `generate` already
  refuses before writing for the token and route cases; here the mode makes it unreachable by
  construction. One seam rather than five because `DecoratorPluginOptions.ingress` is one list.
- **Test home:** `packages/cli/test/e2e/ingress-scaffold-e2e.test.ts` asserts a class-based
  project's generated event handler is registered EXACTLY once by counting handler invocations for
  one published event — a presence assertion would pass with the double registration in place.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                | Kind                   | Consumer / real code path that READS it                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Processor`                                    | fn (method decorator)  | The `onInit` pass calls `IQueue.process` with what it recorded; `docs/decorators.md` fence; `setu g job` class-based arm (§3.8).                                                                                                                                                                                |
| `Cron`                                         | fn (method decorator)  | The pass calls `IScheduler.cron`; `setu g job` class-based arm — `job.ts` already emits "a job processor usable by the queue or scheduler plugin", so it is the generator for all three of `Processor`, `Cron` and `Every`.                                                                                     |
| `Every`                                        | fn (method decorator)  | The pass calls `IScheduler.every`; `setu g job` class-based arm. Separate from `Cron` because the two take different second arguments (`string` expression vs `number` ms) and `SchedulerJobDefinition` is itself a union discriminated on `trigger` (`packages/scheduler-plugin/src/interfaces/index.ts:139`). |
| `OnEvent`                                      | fn (method decorator)  | The pass calls `IEventBus.subscribe`; `setu g event-handler` class-based arm.                                                                                                                                                                                                                                   |
| `Subscribe`                                    | fn (method decorator)  | The pass calls `IMessageBroker.subscribe`. **No generator path, deliberately:** there is no messaging schematic to give an arm to, and §3.8 forbids creating one in this milestone. Recorded in §9 rather than promised.                                                                                        |
| `Gateway`                                      | fn (class decorator)   | The pass calls `IWebSocketService.route`; `setu g ws-route` class-based arm (§3.8).                                                                                                                                                                                                                             |
| `OnOpen` / `OnMessage` / `OnClose`             | fn (method decorators) | Assembled into the `WebSocketHandlers` object `Gateway`'s registration passes to `route()`.                                                                                                                                                                                                                     |
| `CommandHandler` / `QueryHandler`              | fn (method decorators) | The pass calls `ICommandBus.register` / `IQueryBus.register`; `setu g command-handler` and `setu g query-handler` class-based arms.                                                                                                                                                                             |
| `UseIngressBehaviors` / `UsePipelineBehaviors` | fn (method decorators) | `plugin/ingress-registration.ts` composes the listed behaviours around that one handler (§3.4); the stored decorator kind lets the pass refuse a handler-kind mismatch (§3.5).                                                                                                                                  |
| `IngressMetadata`                              | internal type          | Read only by the metadata store and registration pass. It is deliberately not exported: no external consumer needs the implementation detail.                                                                                                                                                                   |

### 4.1 Options — every option names its consumer

| Option                                                    | Consumer                       | Behavior (per implementation)                                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPluginOptions.ingress?: readonly Constructor[]` | The `onInit` pass iterates it. | The explicit list of classes carrying ingress decorators, mirroring `controllers`. Absent means none, and the pass does nothing — so an application registering no ingress class composes byte-identically to today. |
| (no other new option)                                     | —                              | `enforceSchemas` and `enforceRoles` are HTTP-route concerns and are not consulted by the ingress pass; the plan states this rather than silently reusing them.                                                       |

## 5. Implementation files

| File                                                                           | Purpose                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                 | Barrel: the thirteen new decorators (see §4).                                                                                                                                |
| `src/decorators/ingress.ts`                                                    | All thirteen decorators, each recording into the store via the existing `defer`/`flushCarrier` bridge.                                                                       |
| `src/metadata/metadata-store.ts`                                               | The new `ingress` map on the concrete class (§3.6).                                                                                                                          |
| `src/plugin/ingress-registration.ts`                                           | The `onInit` pass: resolves each token, assembles definitions, composes typed behaviours per handler, registers, and refuses missing or mismatched declarations (§3.1–§3.5). |
| `src/plugin/decorator-plugin.ts`                                               | Adds the seven ingress provider tokens (§1) to `optionalDependencies` and installs the `onInit` hook.                                                                        |
| `packages/cli/src/schematics/job.ts`                                           | Gains a class-based arm emitting a `@Processor`/`@Cron` class. **No new schematic is added** — §3.8.                                                                         |
| `packages/cli/src/schematics/ws-route.ts`                                      | Gains a class-based arm emitting a `@Gateway` class, losing the `IPlugin` wrapper M86's verification bar names.                                                              |
| `packages/cli/src/schematics/{event-handler,command-handler,query-handler}.ts` | Each gains a class-based arm emitting the decorated method form.                                                                                                             |
| `packages/cli/src/seams/ingress.ts`                                            | ONE new `SeamSpec` whose barrel feeds `DecoratorPluginOptions.ingress` — one family, not five, because the option is one list (§3.9).                                        |
| `packages/cli/src/seams/registry.ts`                                           | Registers the ingress seam and routes each schematic to exactly one seam per mode (§3.9).                                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                           | src covered                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/ingress-decorator.test.ts`               | `decorators/ingress.ts`, `metadata/metadata-store.ts` | Each decorator records the expected `IngressMetadata`; member-before-class ordering holds; a `@Gateway`-less class carrying `@OnMessage` is detectable. Calls type-check against `SetuMethodDecorator`/`SetuClassDecorator` from §1.                           |
| `test/unit/ingress-registration.test.ts`            | `plugin/ingress-registration.ts`                      | Each capability's registration method is called with the recorded name/expression/topic and a bound handler. Fakes implement the `common` interfaces from §1 in full — a fake omitting `has` is the M89b contract-violating-double defect.                     |
| `test/unit/ingress-registration.test.ts`            | `plugin/ingress-registration.ts`                      | §3.3: missing-provider cases name class, method and provider plugin.                                                                                                                                                                                           |
| `test/unit/ingress-registration.test.ts`            | `plugin/decorator-plugin.ts`                          | §3.2: the `onInit` hook runs the pass and awaits scheduler registration.                                                                                                                                                                                       |
| `test/unit/ingress-registration.test.ts`            | `plugin/ingress-registration.ts`                      | §3.1–§3.5: registration methods receive bound handlers; missing providers and decorator-kind mismatches refuse; a short-circuiting behavior skips its handler.                                                                                                 |
| `test/type/ingress-behavior-typing.test.ts`         | `decorators/ingress.ts`                               | The two typed factories reject the other behavior interface at the call site.                                                                                                                                                                                  |
| `test/unit/barrel-exports.test.ts` (extended)       | `src/index.ts`                                        | §3.6: the barrel gains exactly the new decorators; a compile-time assertion pins `IMetadataStore`'s three maps.                                                                                                                                                |
| `test/integration/ingress-registration.test.ts`     | all of the above, end to end                          | **The verification bar.** Six real kernel applications (one per ingress), each with the REAL ingress plugin registered, each driving real work to a decorated handler and asserting the handler ran. Not a metadata assertion — see §8.                        |
| `test/integration/ingress-registration.test.ts`     | `plugin/ingress-registration.ts`                      | The M86 negative control: a behavior on ONE processor does not run for a second processor in the same application.                                                                                                                                             |
| `test/integration/ingress-registration.test.ts`     | `decorators/ingress.ts`, registration                 | Real socket, real handshake, frame round trip through a decorated `@OnMessage` in a network-permitted subprocess.                                                                                                                                              |
| `test/integration/ingress-registration.test.ts`     | registration, guards                                  | §3.5: decorated command and query handlers execute through the real buses.                                                                                                                                                                                     |
| `test/integration/ingress-registration.test.ts`     | registration                                          | A decorated processor runs through the resolved real queue service.                                                                                                                                                                                            |
| `packages/cli/test/unit/ingress-schematics.test.ts` | the five schematic arms of §3.8                       | Decorated output when `decorator-plugin` is in the manifest, functional output otherwise — the M65 `generatorMode(plugins)` mechanism, which reads the generated manifest and needs no new `SchematicOptions` field. Hostile-name coverage per the M34b sweep. |
| `packages/cli/test/e2e/template-e2e.test.ts`        | schematics + templates, end to end                    | The class-based scaffold imports the ingress barrel, passes it to `DecoratorPlugin`, and type-checks against this workspace.                                                                                                                                   |
| `packages/cli/test/unit/ingress-schematics.test.ts` | `seams/ingress.ts`, `seams/registry.ts`               | §3.9: a class-based artifact lands in the ingress barrel and NOT in its family barrel, and the reverse in functional mode. Asserts the two barrels are disjoint for one generated name — the property that makes double registration unreachable.              |

Per-file 90% branch/function/line on every new `src` file, read from the ANSI-stripped per-file
table (the task's exit code is not the check).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m97a-ingress-decorators, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree — decorator-plugin's barrel changes
deno task release:verify 0.6.0
```

## 8. Risks & mitigations

- **A test asserts the decorator is PRESENT rather than that the handler RAN.** This is the exact
  way M58's `g controller` answered 500 on every request for five releases and M70n's
  `@ValidateBody` validated nothing for as long, and M86 named it as the reason to defer this
  milestone. Mitigation: §6's integration row is mandatory and metadata-only assertions do not
  discharge it; every ingress must be driven with real work through a real kernel application.
- **A test double that does not honour the real contract.** A fake registry omitting `has`, or a
  fake `IScheduler` whose `cron` returns a non-promise, would make the pass pass against a shape the
  real capability does not have. Mitigation: §6 requires fakes to implement the §1 interfaces in
  full; the integration rows use the REAL plugins.
- **The `optionalDependencies` widening introduces a cycle.** §1 establishes none exists today by
  grep. Mitigation: a boot test registering all six ingress plugins (seven tokens) plus
  `DecoratorPlugin` asserts `start()` resolves, so a future edge that creates one fails loudly
  rather than at a user's startup.
- **Behaviour placement leaks application-wide.** Mitigation: §3.4's negative control is a committed
  test, not a review note.
- **A developer writes `@UseGuards` on an ingress method.** It is the obvious thing to reach for and
  it cannot work (§3.4). Left unhandled it would be stored and read by nobody — the silent no-op
  `ROADMAP.md:8511` names as the reason this milestone was deferred. Mitigation: a startup refusal
  naming the appropriate typed behavior decorator, with its own §6 row.
- **An artifact is registered twice.** The functional seams already feed the plugins' own options
  arms; a class-based artifact also reaching `DecoratorPluginOptions.ingress` would subscribe twice
  and run twice per event, with nothing failing. Mitigation: §3.9 makes the two sites mutually
  exclusive by mode, and the e2e counts invocations rather than asserting presence.
- **The gateway integration test is flaky against a real socket.** Mitigation: follow M73 exactly —
  a hand-written handshake on `Deno.connect`, answering the server's keep-alive pings, and
  `app.fetch` rather than global `fetch` for the refusal case (the fetch algorithm strips
  `Upgrade`/`Connection` as forbidden headers).

## 9. Out of scope

- **An automatic per-request DI scope.** Named unowned in `ROADMAP.md`'s M97 section; it is a kernel
  and container change with a per-request container cost, not sugar over an existing seam.
- **Response shaping for decorated HTTP handlers** — M97b.
- **Typed configuration sections** — M97c.
- **A NEW websocket or job schematic.** `ws-route.ts` and `job.ts` already exist and gain arms
  instead (§3.8). `ROADMAP.md:7075` records M70i declining a `ws-route` schematic; **that decline
  was superseded by M84**, which shipped one in `ab0aba27` — an earlier draft of this plan cited the
  decline as current, which is the stale-reference class the plan checklist exists to catch.
- **A generator path for `@Subscribe`.** The five schematics §3.8 gives class-based arms to are
  `job`, `ws-route`, `event-handler`, `command-handler` and `query-handler` — the full registry list
  relevant to ingress (`packages/cli/src/schematics/registry.ts:151-156`). There is no messaging
  schematic to give an arm to, and creating one is exactly what §3.8 refuses. So `@Subscribe` is
  hand-written in a class-based project, as it is in a functional one; the decorator is still in
  scope, only its generator is not. Recorded here rather than left as an unstated gap between the
  decorator list and the schematic list, which is where the ROADMAP's first draft put it.
- **Filesystem auto-discovery of ingress classes.** `autoDiscover` covers controllers and services
  and is deliberately not extended: it has no in-repo consumer (M64 recorded this), so widening it
  would add an untested path.
- **Threading tenancy, auth or tracing through the new guards.** M86 made them expressible and
  deliberately did not wire them; that stays true here.
