# Milestone 13 — CQRS Plugin (`@hono-enterprise/cqrs-plugin`)

> **Status:** Planning. Branch to be created: `feat/m13-cqrs-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide the CQRS (Command Query Responsibility Segregation) capability: a command bus, a query bus,
and a composable pipeline-behavior chain that wraps each terminal handler. Commands mutate state and
return a result; queries return data without side effects. Both buses route a request to its
registered handler by the request's `type` discriminator.

This milestone spans **two packages**:

1. **`@hono-enterprise/common`** — one additive public-API change: a new contracts file
   `src/services/cqrs.ts` (request/handler/bus/facade/behavior interfaces). No such contracts exist
   today (verified — see §1), so this is pure addition with zero existing implementors to break.
2. **`@hono-enterprise/cqrs-plugin`** — the plugin factory, the concrete buses, the
   behavior-pipeline composition, the handler-not-found error, and the facade registered under
   `CAPABILITIES.CQRS`.

Roadmap reference: `ROADMAP.md` → "Milestone 13: CQRS Plugin — Commands, Queries, Buses".

**In-memory, in-process only.** No external dependencies. The plugin does not touch `ctx.runtime`,
the network, or the filesystem. A command handler that wants to publish domain events resolves
`IEventBus` itself; the plugin does not couple to the events capability (ARCHITECTURE notes that as
optional/future — see §9).

- **In scope:** `IRequest`/`ICommand`/`IQuery`/`ICommandHandler`/`IQueryHandler`/`IPipelineBehavior`
  contracts in `common`; `ICommandBus`/`IQueryBus`/`ICqrsFacade` contracts in `common`; `CqrsPlugin`
  factory; concrete `CommandBus`/`QueryBus`; internal `RequestBus` + `composePipeline`; the
  `HandlerNotFoundError`; the `CqrsPluginOptions` type; PUBLIC_API/ARCHITECTURE/ROADMAP/CLAUDE doc
  updates shipped in the same PR.
- **NOT this milestone:** event sourcing, snapshots, projections (not in ROADMAP M13); the
  Events→CQRS coupling (a handler may resolve `IEventBus` itself; the plugin stays decoupled);
  decorator-based `@CommandHandler`/`@QueryHandler` (M9 ships decorator _primitives_ only — no such
  decorators exist; future work built on those primitives, see §9); distributed command dispatch
  (messaging capability, M14).

---

## 1. Contracts verified from SOURCE (not names)

Every design below is checked against the committed source. A name that was not opened is not
verified.

| Reference                          | Source                                                | What it actually is                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.CQRS`                | `packages/common/src/tokens.ts:89`                    | `'cqrs'` — lowercase, no colon; valid under `createCapabilityToken`.                                                                                                                                                                                                                                                                                                       |
| `CAPABILITIES.COMMAND_BUS`         | `packages/common/src/tokens.ts:91`                    | `'command-bus'` — valid kebab-case.                                                                                                                                                                                                                                                                                                                                        |
| `CAPABILITIES.QUERY_BUS`           | `packages/common/src/tokens.ts:93`                    | `'query-bus'` — valid kebab-case.                                                                                                                                                                                                                                                                                                                                          |
| CQRS contracts in `common`         | `packages/common/src/services/` (dir listing)         | **No `cqrs.ts` exists.** `index.ts` exports no `ICommandBus`/`IQueryBus`/`IRequest`. Adding the file is pure addition.                                                                                                                                                                                                                                                     |
| `ICommandBus`/`IQueryBus` users    | workspace grep `ICommandBus\|IQueryBus`               | **None** outside PUBLIC_API.md/ARCHITECTURE.md. No fixtures, no fakes, no implementors. Adding the interfaces breaks nothing (unlike a method addition to an implemented interface).                                                                                                                                                                                       |
| dependency matching                | `packages/kernel/src/registry/plugin-resolver.ts:38`  | `dependencies`/`optionalDependencies` are resolved against the **provider index** built at `plugin-resolver.ts:78`, which indexes **both** `plugin.name` **and** every token in `plugin.provides`. So a consumer's `dependencies: ['cqrs']` resolves ONLY if some plugin lists `'cqrs'` in `provides` (or is named `'cqrs'`). ⇒ CqrsPlugin MUST `provides: ['cqrs', ...]`. |
| duplicate-token detection          | `packages/kernel/src/registry/plugin-resolver.ts:82`  | Two plugins that both advertise the same token (name or `provides`) throw at startup. A single plugin may list several tokens in `provides` safely. ⇒ CqrsPlugin is single-instance; two instances throw (correct kernel behavior, documented, not worked around).                                                                                                         |
| `IPlugin` shape                    | `packages/common/src/plugin.ts:437`                   | `name`, `version`, `dependencies?`, `optionalDependencies?`, `provides?`, `consumes?`, `priority?`, `register(ctx)`.                                                                                                                                                                                                                                                       |
| `IPluginContext.services.register` | `packages/common/src/registry.ts` (via plugin.ts:378) | `register<T>(token, service, options?): void` — used by `events-plugin/src/plugin/events-plugin.ts:76` as `ctx.services.register<IEventBus>(CAPABILITIES.EVENTS, bus)`.                                                                                                                                                                                                    |
| `IPluginContext.health.register`   | `packages/common/src/plugin.ts:163`                   | `register(name: string, indicator: HealthIndicatorFn): void`. Precedent: events-plugin registers `'events'` returning `{ status: 'up', data: {...} }`.                                                                                                                                                                                                                     |
| `IPluginContext.lifecycle.onClose` | `packages/common/src/plugin.ts:304`                   | `onClose(fn: () => void                                                                                                                                                                                                                                                                                                                                                    |
| `IPluginContext.runtime`           | `packages/common/src/plugin.ts:402`                   | Non-optional by contract (a runtime provider is mandatory and registers first). CqrsPlugin does **not** read it, but the integration test must still register a runtime-providing plugin so the kernel starts.                                                                                                                                                             |
| `PLUGIN_PRIORITY.NORMAL`           | `packages/common/src/types.ts`                        | `500` — CQRS is an ordinary capability plugin (precedent: events-plugin uses `NORMAL`).                                                                                                                                                                                                                                                                                    |
| Precedent: bus-pattern plugin      | `packages/events-plugin/src/plugin/events-plugin.ts`  | The factory shape, `provides`, `priority`, service/health/onClose wiring, and optional-logger resolution pattern this milestone mirrors.                                                                                                                                                                                                                                   |
| Precedent: contracts in `common`   | `packages/common/src/services/events.ts:60`           | `IEventBus` etc. are interfaces in `common`; the concrete `InMemoryEventBus` lives in the plugin. CQRS follows the same split: contracts in `common/services/cqrs.ts`, concretes in the plugin.                                                                                                                                                                            |

### 1.1 Why the milestone touches `common`

ROADMAP/PUBLIC_API show consumers resolving `ICommandBus`/`IQueryBus` from the registry and
importing `ICommand`/`IQuery`/`ICommandHandler`/`IQueryHandler`. The owning home for shared
contracts in this framework is `@hono-enterprise/common` (precedent: `IEventBus`, `ICacheStore`,
`IOrmAdapter` all live there, with the plugin re-exporting them for convenience). Defining the
contracts only inside the plugin would force every consumer to depend on the plugin package for type
definitions — the exact cross-plugin coupling CLAUDE.md forbids ("No plugin depends on another
plugin … all shared interfaces live in `@hono-enterprise/common`"). The contracts therefore go in
`common`; the plugin re-exports them for convenience (PUBLIC_API marks them as re-exports, not new
declarations — §8).

`common` is "no runtime behavior beyond constants and pure type utilities" (its `index.ts` header),
so only **interfaces** go there. The runtime `HandlerNotFoundError` class and the concrete buses
stay in the plugin (mirrors how `HttpError` lives in `@hono-enterprise/exceptions`, not `common`).

---

## 2. Committed-doc conflicts — resolved HERE, shipped as named doc deliverables

(CLAUDE.md rule: when two committed documents disagree, the plan picks a side and lists the doc
correction as a PR deliverable — never silent.)

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | PUBLIC_API.md `CqrsPlugin({ behaviors: ['logging','validation','timing'] })` (line 1171, 2289) passes **string names**. ROADMAP M13 shows `behaviors: [loggingBehavior, validationBehavior, timingBehavior]` (functions/instances) and defines `PipelineBehavior.handle(request, next)`. String magic tokens also violate AI_GUIDELINES §11.2 (no magic strings), and "validation"/"timing" would each need a real implementation + dependency (ValidationService, a clock) that is not in the ROADMAP M13 file list.                                                                                                                            | **Typed behaviors win** (user-approved, §3.3). `behaviors` is a `IPipelineBehavior[]` of consumer-supplied instances. No string-named built-ins; no built-in behavior factories shipped (a behavior only its own test calls is dead surface — §4). The integration test supplies an inline behavior to exercise the chain.                                                                                                                                      | PUBLIC_API.md: rewrite the `CqrsPlugin({ behaviors })` examples to typed instances (e.g. `behaviors: [timingBehavior]`) and document `IPipelineBehavior`.                                                                                                                                                                                      |
| C2 | PUBLIC_API.md's `CreateUserCommand implements ICommand` (line 1180) declares `data`, `id`, `createdAt` but **no `type`** — yet `register('CreateUserCommand', h)` routes by a string and `execute(new CreateUserCommand(...))` must recover the type from the instance. Also the example uses `crypto.randomUUID()` / `new Date()` directly (runtime APIs smuggled outside `packages/runtime`).                                                                                                                                                                                                                                                  | **`IRequest` carries `readonly type: string` + `readonly data: TData`** (§3.1). The bus routes on `request.type`; the class sets `readonly type = 'CreateUserCommand'`. **Cut** `id`/`createdAt` from the contract — nothing in the bus reads them, so they are dead surface (CLAUDE.md: every field must be read beyond declare/assign). A behavior that needs correlation data attaches it to `data`. The doc example drops the runtime-API defaults.         | PUBLIC_API.md: rewrite the command/query class examples to set `readonly type` and `readonly data`, drop `id`/`createdAt`/`crypto.randomUUID`/`new Date`.                                                                                                                                                                                      |
| C3 | PUBLIC_API.md shows two `execute` shapes: `execute(new CreateUserCommand(...))` (instance) and `execute({ type, data })` (plain object, CQRS Application example line 2327). ROADMAP shows `execute<CreateUserCommand, string>({ type, data })` (two type params).                                                                                                                                                                                                                                                                                                                                                                               | **Unify on `execute<TResult = unknown>(request: IRequest): Promise<TResult>`.** Both an instance (with `type`+`data`) and a plain `{ type, data }` object satisfy `IRequest`. The request type parameter adds nothing (routing is by `request.type`, not by the static type), so the two-param ROADMAP form collapses to `execute<string>(request)`. The default `<unknown>` keeps the no-param call shape type-checking.                                       | PUBLIC_API.md: standardize the `execute` examples to `execute<string>(...)`; note the request may be a class instance or a plain `{ type, data }` object. (ROADMAP body snippets carry the same two-param form — corrected under C6.)                                                                                                          |
| C4 | ROADMAP M13 file list includes `src/handlers/command-handler.ts`, `src/handlers/query-handler.ts`, and `src/behaviors/pipeline-behavior.ts`. The handler interfaces are contracts (home: `common`). Plugin handler files would be empty re-export shells — dead files.                                                                                                                                                                                                                                                                                                                                                                           | **Handler interfaces live in `common/services/cqrs.ts`** and are re-exported by the barrel. **Omit** `src/handlers/command-handler.ts` and `src/handlers/query-handler.ts` (no real content; creating empty shells violates the dead-surface rule). **Keep** `src/behaviors/pipeline-behavior.ts` as the home of the internal `composePipeline` helper (real consumer: `RequestBus`, §5). This is a deliberate, justified deviation from the ROADMAP file list. | No PUBLIC_API change; the deviation is documented here. ROADMAP file list is a guide, not a contract.                                                                                                                                                                                                                                          |
| C5 | ARCHITECTURE.md cqrs "Public API" row (line 1195) lists only `CqrsPlugin(); ICommandBus; IQueryBus; ICommandHandler; IQueryHandler`. It omits the facade, the behavior contract, the concretes, and the request types added by this milestone.                                                                                                                                                                                                                                                                                                                                                                                                   | **Update the row** to include the full exported surface: `CqrsPlugin(); ICommandBus; IQueryBus; ICqrsFacade; IPipelineBehavior; IRequest; ICommand; IQuery; ICommandHandler; IQueryHandler; CommandBus; QueryBus; HandlerNotFoundError`. Note contracts are owned by `common`, re-exported by the plugin.                                                                                                                                                       | ARCHITECTURE.md: update the `@hono-enterprise/cqrs-plugin` Public API row + note the `common` ownership.                                                                                                                                                                                                                                       |
| C6 | ROADMAP M13's registration example (`ROADMAP.md:1544-1546`) shows `behaviors: [loggingBehavior, validationBehavior, timingBehavior]` and line 1579 asserts "Built-in behaviors are optional and composable." M13 ships **no** built-in behavior factories (Option 1, user-approved; a behavior only its own test calls is dead surface — §4/§9). So the committed ROADMAP body promises importable `loggingBehavior`/`validationBehavior`/`timingBehavior` symbols that this milestone does not export. Also the ROADMAP body's `execute<CreateUserCommand, string>(...)` snippets (`ROADMAP.md:1560,1565`) use the two-param form C3 collapses. | **Consumers supply behaviors; no built-ins shipped** (§9). The ROADMAP milestone-body code samples are **illustrative, not a contract** (same stance as the C4 file-list deviation) — but a stale sample that names non-existent exports is a trap, so it is corrected rather than inherited. The `execute` snippets adopt the C3 single-param form.                                                                                                            | ROADMAP.md: rewrite the M13 registration snippet to a consumer-supplied inline `IPipelineBehavior` (drop `loggingBehavior`/`validationBehavior`/`timingBehavior`), soften line 1579 to "behaviors are consumer-supplied and composable; no built-ins ship in M13", and update the `execute<…>` snippets to the C3 `execute<string>(...)` form. |

All corrections ship **in the same M13 PR** as code edits (never silent, never a follow-up).

---

## 3. Capability-token & plugin-name grammar (passes kernel constraints)

`createCapabilityToken` grammar: lowercase kebab-case, dot namespacing; colons are illegal.
`plugin-resolver.ts` throws at startup on **duplicate plugin names** and on **duplicate capability
providers** (§1).

| Instance | Tokens (`provides`)                                                                                                    | Plugin name     |
| -------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| sole     | `CAPABILITIES.CQRS` (`'cqrs'`), `CAPABILITIES.COMMAND_BUS` (`'command-bus'`), `CAPABILITIES.QUERY_BUS` (`'query-bus'`) | `'cqrs-plugin'` |

**Single instance only — no `name` option.** ROADMAP shows no multi-instance CQRS config. Adding a
`name` option with no ROADMAP consumer would be a dead option (CLAUDE.md) — cut it. Two
`CqrsPlugin()` instances both claim `'cqrs'`/`'command-bus'`/`'query-bus'` and the name
`'cqrs-plugin'` → the second throws at startup (duplicate provider + duplicate name). That is
correct kernel behavior; document it, do not work around it.

All three `provides` tokens are backed by real registered services (command bus, query bus, facade —
§5.4) so `dependencies: ['cqrs']` AND `ctx.services.get('cqrs'|'command-bus'|'query-bus')` all
resolve on a real path.

---

## 4. Design decisions (each behavior a test can assert has a home here)

### 4.1 The request contract — `type` + `data` (common)

`packages/common/src/services/cqrs.ts`. A request is identified by a string `type` and carries typed
`data`. Commands and queries are marker subtypes (semantic separation only — same shape):

```typescript
export interface IRequest<TData = unknown> {
  readonly type: string;
  readonly data: TData;
}
export interface ICommand<TData = unknown> extends IRequest<TData> {}
export interface IQuery<TData = unknown> extends IRequest<TData> {}
```

- Routing is **by `request.type`**, never by constructor name (minification-safe). Both a class
  instance (with `type`/`data` fields) and a plain `{ type, data }` object satisfy `IRequest`
  (resolves C3).
- `type` is required; `execute` throws `TypeError` if `typeof request.type !== 'string'` (testable
  branch — §6), then `HandlerNotFoundError` if no handler is registered for the type.
- `ICommand`/`IQuery` are distinct interfaces (not aliases) so a command handler cannot be
  registered on the query bus at the type level.

### 4.2 Handler + behavior contracts (common)

```typescript
export interface ICommandHandler<TCommand extends ICommand = ICommand, TResult = unknown> {
  handle(command: TCommand): TResult | Promise<TResult>;
}
export interface IQueryHandler<TQuery extends IQuery = IQuery, TResult = unknown> {
  handle(query: TQuery): TResult | Promise<TResult>;
}
export interface IPipelineBehavior<TRequest extends IRequest = IRequest, TResult = unknown> {
  handle(request: TRequest, next: () => Promise<TResult>): TResult | Promise<TResult>;
}
```

- Handlers return `TResult | Promise<TResult>` (sync or async). The bus normalizes with
  `Promise.resolve`.
- `IPipelineBehavior` is constrained to `TRequest extends IRequest` so a logging/timing behavior
  typed `IPipelineBehavior<IRequest>` reads `request.type`/`request.data` **type-safely** — no `any`
  (AI_GUIDELINES bans `any`). The global `behaviors` array is `IPipelineBehavior[]` (defaults to
  `<IRequest, unknown>`), the type-erased form for cross-cutting behaviors.

### 4.3 Bus + facade contracts (common)

```typescript
export interface ICommandBus {
  register<TCommand extends ICommand, TResult>(
    type: string,
    handler: ICommandHandler<TCommand, TResult>,
  ): void;
  execute<TResult = unknown>(command: ICommand): Promise<TResult>;
}
export interface IQueryBus {
  register<TQuery extends IQuery, TResult>(
    type: string,
    handler: IQueryHandler<TQuery, TResult>,
  ): void;
  execute<TResult = unknown>(query: IQuery): Promise<TResult>;
}
export interface ICqrsFacade {
  readonly commandBus: ICommandBus;
  readonly queryBus: IQueryBus;
}
```

- `register`'s first arg is the type string (matches PUBLIC_API
  `commandBus.register('CreateUserCommand', h)`). The registry stores handlers type-erased;
  `register` adapts the typed handler into the erased form with a single justified cast at the
  registry boundary (`req as TCommand` — the same erased-map pattern as
  `ctx.services.get<T>(token)`).
- `execute<TResult = unknown>`: the result type is the caller's assertion (the registry cannot infer
  it); defaults to `unknown` so the no-param call shape type-checks (resolves C3).
- `ICqrsFacade` is registered under `CAPABILITIES.CQRS` so the `'cqrs'` token backs a real service
  and gives consumers a one-stop entry point; the individual buses are also registered under their
  own tokens (resolves the PUBLIC_API `get('command-bus')`/`get('query-bus')` pattern AND the
  facade).

### 4.4 Concrete buses, shared dispatch, and the behavior pipeline (plugin)

**`src/bus/request-bus.ts` (INTERNAL — not exported from the barrel).** A single generic dispatcher
owning the handler map, the behavior list, `execute`, `handlerCount`, and `clear`. Extracted once so
`CommandBus` and `QueryBus` do not duplicate the dispatch/chain logic (CLAUDE.md: duplicated logic
is a defect — route it through a shared helper). Both concrete buses compose a `RequestBus`
instance.

```typescript
class RequestBus {
  private readonly handlers = new Map<string, (request: IRequest) => Promise<unknown>>();
  constructor(private readonly behaviors: readonly IPipelineBehavior[] = []) {}
  registerHandler(type: string, handler: (request: IRequest) => Promise<unknown>): void {
    this.handlers.set(type, handler);
  }
  execute<TResult>(request: IRequest): Promise<TResult> {
    if (typeof request.type !== 'string') {
      throw new TypeError('CQRS request must have a string `type`.');
    }
    const handler = this.handlers.get(request.type);
    if (handler === undefined) throw new HandlerNotFoundError(request.type);
    return composePipeline(request, this.behaviors, () => handler(request)) as Promise<TResult>;
  }
  get handlerCount(): number {
    return this.handlers.size;
  }
  clear(): void {
    this.handlers.clear();
  }
}
```

**`src/behaviors/pipeline-behavior.ts` (INTERNAL).** The chain composition, factored out so it is
unit-testable in isolation:

```typescript
export function composePipeline(
  request: IRequest,
  behaviors: readonly IPipelineBehavior[],
  terminal: () => Promise<unknown>,
): Promise<unknown> {
  let next = terminal;
  for (let i = behaviors.length - 1; i >= 0; i--) {
    const behavior = behaviors[i];
    const prev = next;
    next = () => Promise.resolve(behavior.handle(request, prev));
  }
  return next();
}
```

- Wraps last-to-first so `behaviors[0]` runs first (declared order = execution order). Each
  `behavior.handle` may return a non-promise; `Promise.resolve` normalizes. The final `next()` is
  the terminal handler.
- **Short-circuit is real and asserted** (CLAUDE.md: every dispatch chain needs an explicit
  short-circuit test): a behavior that returns without calling `next()` prevents the terminal
  handler (and all later behaviors) from running. §6 asserts this directly on `composePipeline`.

**`src/bus/command-bus.ts` / `src/bus/query-bus.ts`.** Thin classes implementing `ICommandBus`/
`IQueryBus` by delegating to a private `RequestBus`, adapting the typed handler at `register`:

```typescript
class CommandBus implements ICommandBus {
  private readonly bus: RequestBus;
  constructor(behaviors: readonly IPipelineBehavior[]) {
    this.bus = new RequestBus(behaviors);
  }
  register<TCommand extends ICommand, TResult>(
    type: string,
    handler: ICommandHandler<TCommand, TResult>,
  ): void {
    this.bus.registerHandler(type, (req) => Promise.resolve(handler.handle(req as TCommand)));
  }
  execute<TResult = unknown>(command: ICommand): Promise<TResult> {
    return this.bus.execute<TResult>(command);
  }
  get handlerCount(): number {
    return this.bus.handlerCount;
  }
  clear(): void {
    this.bus.clear();
  }
}
```

- `handlerCount`/`clear` are **concrete-class only** (NOT on the interfaces) — used by the health
  indicator and `onClose`, tested directly on the concrete class (mirrors events-plugin's
  `subscriptionCount`/`clear`).
- `QueryBus` is structurally identical with `IQuery`/`IQueryHandler`. Separate classes keep command
  and query handler registries distinct (a command handler cannot be registered on the query bus).

### 4.5 `HandlerNotFoundError` (plugin; exported)

`src/errors/handler-not-found.ts`. What `execute` throws when no handler is registered for the type:

```typescript
export class HandlerNotFoundError extends Error {
  readonly requestType: string;
  constructor(requestType: string) {
    super(`No handler registered for request type '${requestType}'.`);
    this.name = 'HandlerNotFoundError';
    this.requestType = requestType;
  }
}
```

- Consumed beyond its declaration: `RequestBus.execute` constructs it (real path), tests assert it,
  and callers may catch it by class. Part of the `execute` contract (the documented thrown type) —
  not dead surface.

### 4.6 Plugin lifecycle & health (explicit design home for the tests that assert them)

Mirrors `packages/events-plugin/src/plugin/events-plugin.ts` (verified against source):

- `provides: [CAPABILITIES.CQRS, CAPABILITIES.COMMAND_BUS, CAPABILITIES.QUERY_BUS]`;
  `priority: PLUGIN_PRIORITY.NORMAL`; no `dependencies`, no `optionalDependencies` (the plugin uses
  only non-optional context surfaces — declaring an unused dep would be a dead dependency).
- Construct `CommandBus` + `QueryBus` from `options.behaviors` (default `[]`).
- Register three services: `ICommandBus` under `'command-bus'`, `IQueryBus` under `'query-bus'`,
  `ICqrsFacade` (`{ commandBus, queryBus }`) under `'cqrs'`. All three provided tokens back a real
  service.
- **Health indicator**: `ctx.health.register('cqrs', …)` →
  `{ status: 'up', data: { commands: commandBus.handlerCount, queries: queryBus.handlerCount } }`.
- **Shutdown**: `ctx.lifecycle.onClose(async () => { commandBus.clear(); queryBus.clear(); })`.
- These are asserted by §6 tests; this bullet is their design-decision home (CLAUDE.md: no test may
  assert behavior the design did not specify).
- **Commands are NOT error-isolated like events.** A handler rejection propagates to the `execute`
  caller (commands are expected to fail loudly); behaviors run in the same chain and a behavior
  rejection likewise propagate. There is no `errorHandler` option (unlike events) — a dead option
  here, cut.

### 4.7 Options — every option names its consumer (no dead options)

| Option      | Consumer                    | Behavior                                                                                                                                            |
| ----------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `behaviors` | `CommandBus` and `QueryBus` | `IPipelineBehavior[]` (default `[]`). Applied to every `execute` on both buses, wrapping the terminal handler in declared order. Consumer-supplied. |

(Any option accepted-but-unconsumed is a defect — grep each name beyond declare/assign, per
CLAUDE.md. There is exactly one option and it is consumed by both buses.)

### 4.8 Exported surface — every symbol names its consumer

Every symbol the barrel exports, with the real code path that reads it (CLAUDE.md dead-surface rule:
a symbol whose only reader is its own test is dead). Re-exported common types are owned by `common`;
PUBLIC_API marks them as re-exports, not new declarations.

| Exported symbol                                                                                                                      | Kind                | Consumer / real code path that READS it                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `CqrsPlugin`                                                                                                                         | plugin factory      | `app.register(CqrsPlugin(...))` — §6 integration test registers it and drives command/query through a running kernel.                   |
| `CommandBus`                                                                                                                         | class               | Constructed by `CqrsPlugin`; also constructed directly in unit tests; resolves `ICommandBus`. `handlerCount`/`clear` are concrete-only. |
| `QueryBus`                                                                                                                           | class               | Constructed by `CqrsPlugin`; also constructed directly in unit tests; resolves `IQueryBus`. `handlerCount`/`clear` are concrete-only.   |
| `HandlerNotFoundError`                                                                                                               | class               | Thrown by `RequestBus.execute`; asserted in unit tests; catchable by callers.                                                           |
| `CqrsPluginOptions`                                                                                                                  | option type         | The `CqrsPlugin()` parameter (§4.7).                                                                                                    |
| `IRequest`, `ICommand`, `IQuery`, `ICommandHandler`, `IQueryHandler`, `IPipelineBehavior`, `ICommandBus`, `IQueryBus`, `ICqrsFacade` | re-exports (common) | Convenience only — owned by `common`; consumers implement/resolve them. PUBLIC_API marks them as re-exports.                            |

Internal (NOT exported): `RequestBus`, `composePipeline` — both unit-tested by direct path import.
No symbol is exported without a consumer beyond its own test.

---

## 5. Implementation files

### `packages/common` (additive contract addition)

| File                      | Change                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/cqrs.ts`    | **NEW.** `IRequest`, `ICommand`, `IQuery`, `ICommandHandler`, `IQueryHandler`, `IPipelineBehavior`, `ICommandBus`, `IQueryBus`, `ICqrsFacade` — interfaces with full JSDoc (`@typeParam`, `@since`, `@example`) mirroring `services/events.ts`. |
| `src/index.ts`            | Add `export type { … } from './services/cqrs.ts'`.                                                                                                                                                                                              |
| `test/unit/types.test.ts` | Add type assertions: `ICommandBus` has `register`/`execute`; `IQueryBus` has `register`/`execute`; `IRequest` has `readonly type: string` + `readonly data`; `IPipelineBehavior` has `handle`.                                                  |

**Breakage check:** adding a new contracts file touches no existing interface; workspace grep
confirms no implementors of `ICommandBus`/`IQueryBus`. Zero fixtures to update.

### `packages/cqrs-plugin`

| File                                 | Purpose                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | Barrel: `CqrsPlugin`, `CommandBus`, `QueryBus`, `HandlerNotFoundError`, `CqrsPluginOptions` (type). **Type-only** re-export of `IRequest`/`ICommand`/`IQuery`/`ICommandHandler`/`IQueryHandler`/`IPipelineBehavior`/`ICommandBus`/`IQueryBus`/`ICqrsFacade` from common — PUBLIC_API marks them as re-exports, common is the owning source. |
| `src/interfaces/index.ts`            | `CqrsPluginOptions` (`{ behaviors?: IPipelineBehavior[] }`).                                                                                                                                                                                                                                                                                |
| `src/bus/request-bus.ts`             | **INTERNAL** `RequestBus` — handler map, behavior list, `execute` (type-guard + not-found throw + pipeline), `handlerCount`, `clear`.                                                                                                                                                                                                       |
| `src/bus/command-bus.ts`             | `CommandBus implements ICommandBus` — composes a `RequestBus`, adapts typed handler at `register`, exposes concrete `handlerCount`/`clear`.                                                                                                                                                                                                 |
| `src/bus/query-bus.ts`               | `QueryBus implements IQueryBus` — mirrors `CommandBus` for queries.                                                                                                                                                                                                                                                                         |
| `src/behaviors/pipeline-behavior.ts` | **INTERNAL** `composePipeline(request, behaviors, terminal)` — the behavior-chain composition, factored for isolated unit testing (real consumer: `RequestBus.execute`). Honors ROADMAP M13 file list with real content.                                                                                                                    |
| `src/errors/handler-not-found.ts`    | `HandlerNotFoundError extends Error` (exported) — thrown by `execute`.                                                                                                                                                                                                                                                                      |
| `src/plugin/cqrs-plugin.ts`          | `CqrsPlugin(options?)` factory (tokens/name fixed per §3; build buses + facade; register three services; health indicator; `onClose` clear). Mirrors events-plugin.                                                                                                                                                                         |
| `deno.json`                          | Already exists (`@hono-enterprise/cqrs-plugin`, exports `./src/index.ts`). **Zero external deps** (pure in-process).                                                                                                                                                                                                                        |

---

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                   | Covers                                     | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/types.test.ts`   | `services/cqrs.ts` (type-level)            | `ICommandBus`/`IQueryBus` include `register`/`execute`; `IRequest` has `readonly type: string` + `readonly data`; `IPipelineBehavior` has `handle` (via `assertType<IsExact<…>>` + member-presence, mirroring the existing `IResponse.snapshot` style).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/barrel-exports.test.ts`          | `src/index.ts`                             | Runtime-asserts the **value** exports are present (`CqrsPlugin`, `CommandBus`, `QueryBus`, `HandlerNotFoundError`). The re-exported common **types** (`IRequest`/`ICommandBus`/…) erase at runtime and CANNOT be asserted here — they are verified by `deno task check` (a type-only import in this test fails to compile if a re-export is missing). Mirrors `events-plugin/test/unit/barrel-exports.test.ts`, which makes exactly this value-vs-type split.                                                                                                                                                                                                                                                         |
| `test/unit/handler-not-found.test.ts`       | `errors/handler-not-found.ts`              | `instanceof Error`; `name === 'HandlerNotFoundError'`; `message` includes the type; `requestType` field round-trips.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/pipeline-behavior.test.ts`       | `behaviors/pipeline-behavior.ts`           | `composePipeline` with empty behaviors calls the terminal and returns its value; a single behavior wraps the terminal and `next()` proceeds; multiple behaviors run in **declared order** (assert call order); **short-circuit**: a behavior that returns without calling `next()` → terminal and later behaviors NOT invoked (CLAUDE.md mandatory short-circuit test); a behavior's return value (sync and async) propagates as the final result.                                                                                                                                                                                                                                                                    |
| `test/unit/command-bus.test.ts`             | `bus/command-bus.ts`, `bus/request-bus.ts` | `register` + `execute` round-trip (READ-BACK: the handler's returned value comes back through `execute`); async handler result is awaited; `execute<string>(cmd)` returns the typed value; `execute` for an unknown type throws `HandlerNotFoundError` with the right `requestType`; `execute` on a request with non-string `type` throws `TypeError`; a registered behavior runs around the handler (assert before/after ordering via `next()`); **short-circuit**: a behavior that does not call `next()` → handler NOT run; re-registering a type replaces the handler; `handlerCount` reflects registrations; `clear()` empties the registry. Handler typed against `ICommandHandler<CreateUserCommand, string>`. |
| `test/unit/query-bus.test.ts`               | `bus/query-bus.ts`                         | Mirrors command-bus with an `IQueryHandler<GetUserQuery, User>`; a command handler registered on the command bus is NOT reachable from the query bus (separate registries).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/cqrs-plugin.test.ts`             | `plugin/cqrs-plugin.ts`                    | `name === 'cqrs-plugin'`, `provides` is exactly `['cqrs','command-bus','query-bus']`, `priority === PLUGIN_PRIORITY.NORMAL`, no `dependencies`; registers an `ICommandBus` under `'command-bus'`, `IQueryBus` under `'query-bus'`, `ICqrsFacade` under `'cqrs'` (READ-BACK: resolve each + `execute` works; `facade.commandBus === get('command-bus')`); health indicator registered as `'cqrs'` reporting `status: 'up'` with `commands`/`queries` counts; `onClose` calls `clear()` on both buses (counts drop to 0); the `behaviors` option is wired (a supplied behavior fires on `execute`). Harness mirrors `events-plugin/test/unit/events-plugin.test.ts` (fake `IPluginContext`).                            |
| `test/integration/cqrs-integration.test.ts` | end-to-end via kernel `app.inject()`       | CqrsPlugin + a runtime-providing plugin + a handlers plugin that registers a `CreateUser` command and a `GetUser` query; `POST /users` → `commandBus.execute<string>(...)` → response 201 with the returned id (READ-BACK through the public API — CLAUDE.md "read it back"); `GET /users/:id` → `queryBus.execute<User>(...)` → returns the created user (READ-BACK: the command's write is observable through the query); a behavior supplied via `CqrsPlugin({ behaviors })` fires around the handler on the running app; a command whose handler rejects propagates the error (commands are not isolated like events).                                                                                            |
| `test/fixtures/fake-runtime.ts`             | integration bootstrap                      | `IRuntimeServices` fake so the kernel's mandatory-runtime-first check passes (the kernel requires a runtime provider to start — `plugin-resolver.ts:23`). Mirrors existing fake-runtime fixtures.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

No external optional dependency ⇒ **no guarded REAL-import test** needed (unlike M11 ioredis). The
buses are pure in-process and fully exercised by fakes. `src/interfaces/index.ts` is type-only with
no runtime lines (covered transitively by usage, as in events-plugin).

---

## 7. Public API / doc deliverables (ship in same PR)

- `PUBLIC_API.md`: (C1) rewrite the `CqrsPlugin({ behaviors })` examples to typed
  `IPipelineBehavior` instances and add an `IPipelineBehavior` explanation; (C2) rewrite the
  command/query class examples to set `readonly type` + `readonly data`, drop
  `id`/`createdAt`/`crypto.randomUUID`/`new Date`; (C3) standardize `execute<string>(...)` and note
  the request may be a class instance or a plain `{ type, data }` object; add `ICqrsFacade`,
  `IRequest`/`ICommand`/`IQuery`, `CommandBus`, `QueryBus`, `HandlerNotFoundError`,
  `IPipelineBehavior` to the CQRS section; mark the re-exported common types as re-exports (common
  owns them).
- `ARCHITECTURE.md`: (C5) update the `@hono-enterprise/cqrs-plugin` Public API row to the full
  surface and note `common` ownership of the contracts.
- `ROADMAP.md`: M13 — (C6) rewrite the registration snippet to a consumer-supplied inline
  `IPipelineBehavior` (drop `loggingBehavior`/`validationBehavior`/`timingBehavior`), soften the
  "Built-in behaviors are optional and composable" line to "behaviors are consumer-supplied; no
  built-ins ship in M13", and update the `execute<…>` snippets to the C3 `execute<string>(...)`
  form; mark deliverables `[x]` (`CqrsPlugin`, `Command and query buses`, `Pipeline behaviors`,
  `Full test coverage`); note the handler-file omission (C4) is intentional.
- `CLAUDE.md`: flip "Current status" M13 → complete (PR pending), "Next milestone" → M14 (in the PR,
  before merge).
- JSDoc on every new export (AI_GUIDELINES §10).

---

## 8. Verification gates (must all pass; per-file 90% enforced by reading the table)

```bash
git branch --show-current   # MUST be feat/m13-cqrs-plugin, never main
deno task check:plan        # this plan lints clean (required sections, no unresolved seams)
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage   # read ANSI-stripped per-file table; >=90% branch/function/line every src file in common + cqrs-plugin
```

End-of-task grep (must be empty, comments excepted):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/cqrs-plugin/src packages/common/src
```

---

## 9. Risks & mitigations

- **`as Promise<TResult>` / `req as TCommand` casts at the type-erased registry boundary.**
  Mitigation (DECIDED in §4.3/§4.4, not left open): casts are confined to exactly two lines — the
  handler adapter in `register` and the return of `execute` — the same erased-map pattern as
  `ctx.services.get<T>(token)`. No `any` is used (`unknown` throughout); `deno task check` and the
  type tests confirm the public signatures are sound.
- **Behavior short-circuit silently swallowing the terminal handler.** Mitigation: `composePipeline`
  is factored out and unit-tested in isolation, including the explicit short-circuit case (CLAUDE.md
  mandatory); a behavior returning without `next()` is asserted to skip the terminal.
- **`'cqrs'` token advertised but unused.** Mitigation (DECIDED in §3/§4.3): the facade is
  registered under `'cqrs'`, so the token backs a real, get-able service; the integration test
  resolves and uses it. All three `provides` tokens are service-backed.
- **Duplicate-token throw on two CqrsPlugin instances.** Mitigation: this is correct kernel behavior
  (§1/§3); documented, not worked around. Single-instance by design.
- **Cutting ROADMAP's handler files reads as a deviation.** Mitigation (DECIDED in C4): the handler
  interfaces' home is `common`; plugin handler files would be empty shells (dead files). The
  deviation is documented in the plan and the ROADMAP deliverable note.

## 10. Out of scope

- Event sourcing, snapshots, projections — not in ROADMAP M13.
- CQRS↔Events coupling — a command handler may resolve `IEventBus` (`ctx.services.get`) and publish
  itself; the plugin stays decoupled. ARCHITECTURE marks events consumption as optional/future.
- Decorator-based `@CommandHandler` / `@QueryHandler` — M9 ships decorator _primitives_
  (`createDecorator`/`createParameterDecorator`) only; no such decorators exist. A decorator-based
  registration layer is future work built on those primitives; M13 ships only the programmatic
  `register(type, handler)` surface.
- Built-in behavior factories (logging/timing/validation) — not shipped (a behavior only its own
  test calls is dead surface; §4.7). Consumers supply behaviors; the integration test demonstrates
  an inline behavior. The ROADMAP body samples that named these are corrected in the same PR (C6).
- Distributed / cross-process command dispatch — messaging capability (M14).
- Per-bus behavior configuration (`commandBehaviors` / `queryBehaviors`) — not in ROADMAP; the
  single global `behaviors` option is applied to both buses. Adding per-bus options with no ROADMAP
  consumer would be dead surface.
