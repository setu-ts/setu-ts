# Milestone 89c — The 0.3.0 Ingress Surface (`@setu-ts/messaging-plugin`, `@setu-ts/common`, `@setu-ts/multi-tenancy-plugin`)

> **Status:** Planning. Branch: `feat/m89c-the-0-3-0-ingress-surface`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the two findings against M86's ingress surface. One is a silent startup deadlock whose blast
radius was **measured** before this plan was written, which is what narrows the fix from four
candidates to one: only the in-memory broker's delivery-awaiting `publish` closes the cycle, and the
gate itself is correct on every broker. The other is a capability `0.3.0`'s release notes advertise
and the contract cannot express — a tenant concern in an ingress behaviour — closed by giving
`IMultiTenancyService` the ctx-free entry point its own `prefixCacheKey` already models.

- **In scope:** X16-1 (the in-memory broker resolves `publish` on enqueue-for-dispatch; the gate
  gains a bounded wait with a named failure), X16-2 (`getRepositoryFor(tenantId, entity)` and
  `tenantById(tenantId)` on `IMultiTenancyService`), and the release-note correction C1 below.
- **NOT this milestone:** X18-*/X19-1 — **M89a** and **M89b**. Changing `IMessageBroker.publish`'s
  contract for any broker other than in-memory, or detecting the registration window — §3.1 records
  why both are rejected. A tenant slot on `IngressContext` — §3.5. Behaviour ordering _across_
  plugins — §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                          | Verified surface / fact                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in-memory `publish` contract    | `messaging-plugin/src/brokers/in-memory-broker.ts:131`      | `@returns Resolves when all handlers have been invoked` — the promise this milestone changes, and the only broker whose promise depends on delivery.                                                                                                                   |
| the gate                        | `messaging-plugin/src/pipeline/pipelined-broker.ts:67-84`   | `#chainReady?: Promise<void>`, `undefined` when no behaviour factory is configured; cleared on settle; **a REJECTED gate is deliberately left in place**.                                                                                                              |
| **the handler-failure channel** | `messaging-plugin/src/pipeline/pipelined-broker.ts:167-171` | "The deferred result is **RETURNED**, not discarded: a handler rejection must still reach the broker's own failure path (a nack/redelivery), never become an unhandled rejection." The destination already exists; §3.1b keeps observing it rather than inventing one. |
| the gate's own rationale        | `messaging-plugin/src/pipeline/pipelined-broker.ts:58-62`   | It exists because a LATER plugin may subscribe in its own `register()`, "which no amount of deferral inside this plugin can reach". Gating delivery closes both doors.                                                                                                 |
| where the gate is armed         | `messaging-plugin/src/plugin/messaging-plugin.ts:329`       | `new PipelinedBroker(broker, behaviorChain, chainReady)` **only** on the factory arm — which is why the measurement's factory/no-factory control discriminates.                                                                                                        |
| where the gate opens            | `messaging-plugin/src/plugin/messaging-plugin.ts:152`       | `openChainGate` "is called at the end of `onInit`, once `behaviorChain` is final".                                                                                                                                                                                     |
| the anticipated adjacent hazard | `messaging-plugin/src/plugin/messaging-plugin.ts:157`       | `failChainGate` exists so held work fails "instead of hanging on a promise that can never settle" **when `onInit` fails** — it does not cover `onInit` never running.                                                                                                  |
| `IngressContext`                | `common/src/services/ingress.ts:43-62`                      | `kind`, `name`, `payload`, `attempt?`. Explicitly **no `state`, no `services`**: "a behaviour needing a capability closes over it via its `RegistryFactory` arm".                                                                                                      |
| `IIngressBehavior`              | `common/src/services/ingress.ts:112-123`                    | One method: `handle(ctx, next): void                                                                                                                                                                                                                                   |
| `IMultiTenancyService`          | `common/src/services/tenancy.ts:50-75`                      | `getCurrentTenant(ctx: IRequestContext)`, `getRepository<E,I>(ctx: IRequestContext, entity)`, `prefixCacheKey(tenantId, key)`. **Only the last is ctx-free.**                                                                                                          |
| the tenant resolvers            | `multi-tenancy-plugin/src/resolvers/*.ts`                   | All four take `IRequest` (`jwt-resolver.ts:40` is representative). Nothing on a non-HTTP path can produce one.                                                                                                                                                         |
| `IAuditLogger.log`              | `common/src/services/audit.ts:55`                           | `log(entry: AuditEntry): Promise<void>` — takes no context, which is why the audit concern IS expressible and the tenant one is not.                                                                                                                                   |
| `prefixCacheKey`'s own JSDoc    | `common/src/services/tenancy.ts:66-73`                      | "The separator is deliberately NOT a per-call argument: this method is the single home for separator resolution" — the precedent for a ctx-free, id-taking member.                                                                                                     |
| the measurement                 | `smoke/X16-FINDINGS.md` (X16-1, measured 2026-09-03)        | memory+awaited hangs; memory+unawaited boots AND delivers complete; memory+`queue.add` boots; rabbitmq and redis-streams both boot AND deliver through the full chain.                                                                                                 |
| §10.2 / §16.1 / §16.2 approval  | `AI_GUIDELINES.md` §10.2, §16.1, §16.2                      | A `common` export change requires approval and a same-PR `PUBLIC_API.md` edit; a plugin-contract change requires approval.                                                                                                                                             |
| §9 prerelease rule              | `AI_GUIDELINES.md` §9 scope note                            | At `0.x`, a required-member addition to a published interface is a breaking change needing CHANGELOG migration text, not a deprecation cycle.                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                            |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `CHANGELOG.md`'s `0.3.0` entry says the ingress chain lets "an authorization, **tenant** or audit concern" be expressed once per ingress kind. Measured, the tenant one cannot be written at all.                                                        | The **claim** is the thing to fix, and this milestone makes it true rather than retracting it — §3.4 adds the ctx-free members. The CHANGELOG entry for `0.3.0` is history and stays; the new entry states what changed. | `CHANGELOG.md` gains the `common` addition and says plainly that the tenant concern became expressible in this release, not `0.3.0`. |
| C2 | `common/src/services/ingress.ts:36-38` says a behaviour "needing a capability closes over it via its `RegistryFactory` arm" — true, and it does not say that closing over `IMultiTenancyService` yields a service whose useful methods cannot be called. | Both are right; the gap is that the envelope's JSDoc reads as though any capability is reachable.                                                                                                                        | `IngressContext`'s JSDoc gains a sentence pointing at the ctx-free members as the way a tenant concern is written.                   |
| C3 | `pipelined-broker.ts:78-83` documents that a REJECTED gate is left in place deliberately. §3.2's bounded wait must not contradict that.                                                                                                                  | The existing behaviour wins: a rejected gate still refuses delivery forever. The bound applies only to a gate that has neither settled nor rejected — the `onInit`-never-ran case.                                       | The `#chainReady` JSDoc states the two cases separately.                                                                             |

## 3. Design decisions

### 3.1 X16-1's fix: the in-memory broker resolves on enqueue-for-dispatch

- **Decision:** `InMemoryBroker.publish` resolves once every matching subscription's work item has
  been **handed to** dispatch, not once every handler has returned. `PipelinedBroker` is unchanged
  in this respect: it still holds the work.
- **Why:** the measurement settles it. `publish` returns before delivery on rabbitmq and
  redis-streams, and on both the gate holds a register-time message and then releases it through the
  **complete** chain — so the gate is correct and only the in-memory promise closes the cycle. The
  two larger candidates are rejected with cause: changing `publish`'s contract _broadly_ would alter
  behaviour that is already right on four brokers, and detecting the registration window adds a
  state machine to fix a case the promise change removes outright.
- **Cost, stated rather than hidden:** this is a **behaviour change to a documented contract** —
  `in-memory-broker.ts:131`'s "Resolves when all handlers have been invoked" becomes "…has been
  dispatched". Any test that awaited `publish` and then asserted a handler side-effect without
  awaiting anything else will need one `await` more. That is exactly the guarantee real brokers
  never gave, so the change also makes in-memory the _faithful_ default it is used as.
- **Test home:** `test/integration/register-time-publish.test.ts` (boots) and
  `test/unit/in-memory-dispatch-timing.test.ts` (the contract itself).

### 3.1b Where a handler failure goes once `publish` no longer carries it

- **Decision:** `publish` resolves once each subscriber's callback has been **invoked**, and
  `InMemoryBroker` **retains every returned promise** and routes a rejection to its own failure path
  — it does not drop them. For this broker that path terminates in a report through an injected
  `onDispatchError?(error, meta)`, which `MessagingPlugin` supplies backed by `ctx.logger` read at
  **call** time.
- **This is not a new mechanism, and the first draft of this plan wrongly described it as one.**
  `pipeline/pipelined-broker.ts:167-171` already names the destination: "The deferred result is
  **RETURNED**, not discarded: a handler rejection must still reach the broker's own failure path (a
  nack/redelivery), never become an unhandled rejection." The subscription callback the broker calls
  **is** `PipelinedBroker`'s wrapper, and the promise it returns is what carries the rejection
  upward. So the requirement is not "invent a sink" but "keep observing the promise you already
  receive after you stop awaiting it in line". Describing it as a new sink is what made the first
  draft look like it duplicated an existing channel (§11.1) and diverged in-memory from every real
  broker.
- **The asymmetry between brokers is real and is documented rather than hidden.** On RabbitMQ a
  rejection reaching the broker's failure path can nack and redeliver. `InMemoryBroker` has no
  redelivery and no ack model at all, so its failure path is terminal and reporting is the whole of
  it. That is a property of the double, not a behaviour this milestone chooses, and it belongs in
  the broker's own JSDoc beside the changed `@returns`.
- **Why not Qodo's alternative — "retain a completion promise":** that is the current behaviour, and
  it is what closes the deadlock cycle (`register()` → publish → delivery → gate → `onInit` →
  `register()`). Retaining it keeps X16-1 open, so it is rejected rather than deferred.
- **Reading `ctx.logger` at call time** rather than capturing it at `register()` is the M52b lesson,
  where a captured logger silenced every later report. The reporter is injected rather than resolved
  because `InMemoryBroker` is a broker, not a plugin, and holds no `IPluginContext`.
- **Also settled by this:** the first `await`ing subscriber no longer blocks the rest. Today one
  slow or throwing fan-out handler delays or aborts delivery to its siblings, because the loop
  awaits in sequence — which is not how any real broker behaves.
- **Test home:** `test/unit/in-memory-dispatch-timing.test.ts` — a throwing handler reaches
  `onDispatchError`, `publish` still resolves, siblings still receive the message, and the test
  asserts **no unhandled rejection** was raised (`addEventListener('unhandledrejection')`, the only
  assertion that catches this failure mode). A second case asserts the promise the subscription
  callback returns is the one whose rejection is observed, so a future refactor that drops it fails
  here rather than in production.

### 3.2 The bounded wait, and what it reports

- **Decision:** a dispatch held on `#chainReady` waits at most `chainReadyTimeoutMs` (default
  10 000) and then **rejects** with a named error stating that the behaviour chain never opened and
  that a plugin publishing during `register()` is the likely cause. The gate itself is not cleared —
  later dispatches get the same refusal.
- **Why:** §3.1 removes the only cycle we have measured, and this is the backstop for one we have
  not: a custom `MessageBrokerAdapter` whose `publish` awaits delivery would reproduce X16-1
  exactly, and a silent hang is the worst possible failure for it. A bound turns that into a
  diagnosis. It does not contradict C3: a **rejected** gate already refuses forever, and this adds a
  reason for a gate that never settles at all.
- **Test home:** `test/unit/chain-gate-timeout.test.ts` — with an injected clock, a never-opened
  gate rejects with the named error and the message names `register()`.

### 3.3 What is NOT changed about the gate

- **Decision:** the gate stays armed only on the factory arm; a rejected gate still blocks forever;
  registration timing is untouched for every plugin.
- **Why:** `pipelined-broker.ts:58-62` and `:78-83` give the reasons, and the measurement confirms
  the design works. M86's review reached this shape after a first fix that closed one of two doors;
  re-opening it is not in this milestone's remit.
- **Test home:** `messaging-plugin`'s existing behaviour-chain suites stay green unmodified — the
  regression guard.

### 3.4 X16-2's fix: ctx-free members on `IMultiTenancyService`

- **Decision:** add **one** member —
  `getRepositoryFor<Entity, Id>(tenantId: string, entity: string): ITenantRepository<Entity, Id>`,
  required.
- **`tenantById` was in the first draft of this plan and is CUT, because nothing can implement it.**
  `MultiTenancyService` holds only `store: ITenantDataStore` and `separator`
  (`multi-tenancy-service.ts:22-28`); `getCurrentTenant(ctx)` does not look anything up, it forwards
  `ctx.request.tenant` (`:31-33`); and `ITenantDataStore` is entity-row CRUD keyed by tenant id —
  `findAll`/`findById`/`find`/`create`/`update`/`delete` (`interfaces/index.ts:147-180`) — with **no
  tenant catalog and no tenant lookup**. So the behaviour §3.4 originally asserted ("returns the
  tenant, `undefined` for an unknown id") has no source that could produce it. That is the M10
  defect class the plan checklist names — assuming a committed surface carries data access it does
  not — and it is caught here rather than at implementation time. A tenant catalog port is a
  separate design and is named in §9.
- **Why:** `prefixCacheKey(tenantId, key)` is already exactly this shape in the same interface, and
  its JSDoc argues for a single home per concern — so the pattern is established rather than
  invented. Required rather than optional because an optional member returning `undefined` cannot
  distinguish "no such tenant" from "this implementation does not offer the read", the ambiguity
  M70k had to invent `IWorkerHost.reportsExit?` to resolve. The tenant id comes from the payload,
  which the publisher supplies whether or not this milestone lands; what this removes is the
  hand-rolling of everything downstream.
- **Cost:** **breaking for out-of-repo implementors** of `IMultiTenancyService`. The framework's own
  service is the only in-repo implementor; CHANGELOG migration text names the two members. §9's
  prerelease rule makes this a CHANGELOG obligation, not a deprecation cycle.
- **Test home:** `multi-tenancy-plugin/test/unit/ctx-free-members.test.ts` and
  `messaging-plugin/test/integration/tenant-behaviour.test.ts`, the latter being the one that proves
  the release-note claim.

### 3.5 No tenant slot on `IngressContext`

- **Decision:** the envelope is unchanged.
- **Why:** a slot would make the dispatch site resolve the tenant, and no dispatch site has a
  request to resolve one from — so it would carry whatever the publisher put in the payload, which
  the behaviour can read itself. The envelope's own JSDoc argues against growing members
  (`ingress.ts:36-38`), and §3.4 is the smaller change.
- **Test home:** `common/test/unit/ingress-context-shape.test.ts` pins the member set, so a later
  addition is deliberate.

### 3.6 Which behaviour arm the tenant concern uses

- **Decision:** the `RegistryFactory<IIngressBehavior>` arm, closing over the resolved
  `IMultiTenancyService`, reading the tenant id from `ctx.payload`.
- **Why:** it is the only channel the envelope offers, by design, and §3.4 is what makes the closed-
  over service useful once it is held.
- **Test home:** `messaging-plugin/test/integration/tenant-behaviour.test.ts` — a behaviour resolves
  the service through the factory arm, reads the tenant from the payload, and obtains a
  tenant-scoped repository whose write is invisible to the other tenant.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                              | Kind   | Consumer / real code path that READS it                                                                                             |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `IMultiTenancyService.tenantById`            | method | An ingress behaviour or any non-HTTP caller; exercised by `messaging-plugin/test/integration/tenant-behaviour.test.ts`.             |
| `IMultiTenancyService.getRepositoryFor`      | method | Same; the member the tenant-scoped write in that test goes through.                                                                 |
| `ChainGateTimeoutError`                      | class  | Thrown by `PipelinedBroker`'s bounded wait; caught by `chain-gate-timeout.test.ts` and by an application's own dispatch error path. |
| `MessagingPluginOptions.chainReadyTimeoutMs` | option | Read by `messaging-plugin.ts` when constructing `PipelinedBroker`; see §4.1.                                                        |

`InMemoryBroker`'s promise change adds **no** symbol. `barrel-exports.test.ts` in `common`,
`messaging-plugin` and `multi-tenancy-plugin` pins that nothing else moved (the M56 defect class).

### 4.1 Options — every option names its consumer

| Option                                       | Consumer                                           | Behavior (per implementation)                                                                                                                                                                                                                                          |
| -------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessagingPluginOptions.chainReadyTimeoutMs` | `messaging-plugin.ts` → `new PipelinedBroker(...)` | Bounds a held dispatch (default 10 000). `0` disables the bound and restores the pre-M89c wait-forever behaviour, for an application that would rather hang than fail. Ignored entirely when no behaviour factory is configured, because the gate is then `undefined`. |
| No new tenancy option                        | —                                                  | Checked: §3.4 adds members, not configuration. A `tenantById` cache option was considered and cut — the memory store is already a map read.                                                                                                                            |

## 5. Implementation files

| File                                                                    | Purpose                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/in-memory-broker.ts`             | `publish`/`publishWithHeaders` resolve on enqueue-for-dispatch; the `@returns` JSDoc restated. |
| `packages/messaging-plugin/src/pipeline/pipelined-broker.ts`            | The bounded wait; the `#chainReady` JSDoc separating never-settled from rejected (C3).         |
| `packages/messaging-plugin/src/errors.ts`                               | `ChainGateTimeoutError`.                                                                       |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`              | `chainReadyTimeoutMs` resolution and pass-through.                                             |
| `packages/messaging-plugin/src/interfaces/index.ts`                     | The option's declaration and JSDoc.                                                            |
| `packages/messaging-plugin/src/index.ts`                                | Barrel re-export of `ChainGateTimeoutError`.                                                   |
| `packages/common/src/services/tenancy.ts`                               | `tenantById`, `getRepositoryFor`.                                                              |
| `packages/common/src/services/ingress.ts`                               | C2's JSDoc sentence.                                                                           |
| `packages/multi-tenancy-plugin/src/services/*.ts`                       | The two members on the concrete service.                                                       |
| `packages/multi-tenancy-plugin/README.md`, `messaging-plugin/README.md` | The tenant-in-a-behaviour recipe; the publish-timing note.                                     |
| `PUBLIC_API.md`                                                         | The two `common` members, `ChainGateTimeoutError`, `chainReadyTimeoutMs`.                      |
| `CHANGELOG.md`                                                          | Two breaking changes with migration text (the in-memory promise, the required members).        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                 | src covered                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging-plugin/test/unit/in-memory-dispatch-timing.test.ts`            | `brokers/in-memory-broker.ts`               | `publish` resolves before a slow handler completes; the handler still runs; `publishWithHeaders` behaves identically (both against `IMessageBroker` in `common/src/services/messaging.ts`).                           |
| `messaging-plugin/test/integration/register-time-publish.test.ts`         | the whole path                              | A second plugin awaiting `publish` in its own `register()` **boots**, and the message is delivered through the COMPLETE chain — instance AND factory behaviours, then the handler. **Control:** reverting §3.1 hangs. |
| `messaging-plugin/test/unit/chain-gate-timeout.test.ts`                   | `pipeline/pipelined-broker.ts`, `errors.ts` | A never-opened gate rejects with `ChainGateTimeoutError` naming `register()`; a **rejected** gate still refuses forever (C3); `chainReadyTimeoutMs: 0` waits indefinitely; no gate is armed without a factory.        |
| `messaging-plugin/test/integration/tenant-behaviour.test.ts`              | the §3.4/§3.6 composition                   | A `RegistryFactory` behaviour resolves `IMultiTenancyService`, reads the tenant from `ctx.payload`, and writes through `getRepositoryFor` — tenant A's row invisible to tenant B. **This is C1's proof.**             |
| `messaging-plugin/test/integration/outage-real.test.ts` (extend)          | the real-broker guarantee                   | Guarded on `RABBITMQ_URL`: a register-time publish on a REAL broker still boots and still delivers complete, so §3.1 cannot regress the path the measurement showed was already correct.                              |
| `common/test/unit/ingress-context-shape.test.ts`                          | `services/ingress.ts`                       | The envelope's member set is exactly `kind`/`name`/`payload`/`attempt?` (§3.5), so a later slot is deliberate.                                                                                                        |
| `multi-tenancy-plugin/test/unit/ctx-free-members.test.ts`                 | `services/*.ts`                             | `tenantById` returns the tenant and `undefined` for an unknown id; `getRepositoryFor` scopes writes; both against the `common` signatures from §1.                                                                    |
| `common/test/unit/barrel-exports.test.ts` (extend), plus the two plugins' | the three `src/index.ts`                    | Only the four §4 symbols moved.                                                                                                                                                                                       |
| `test/fixtures/snippets/*`, package-README fences                         | the new recipes                             | The M38/M70k fence gates compile the tenant-in-a-behaviour example, so the recipe cannot ship uncompilable.                                                                                                           |

The guarded real-broker extension is required rather than optional: §3.1's whole justification is a
measurement on real brokers, so the fix has to be pinned against one.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m89c-the-0-3-0-ingress-surface, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.3.0
```

Then the measurement that produced this plan, re-run as a regression: the `x16-ops` project at
`~/Projects/hono-enterprise-published-smoke/` repointed at the workspace, `EARLY_PUBLISH=1` across
`BROKER=memory|rabbitmq|redis-streams`, all three booting and all three delivering through the
complete chain.

## 8. Risks & mitigations

- **The in-memory promise change breaks a test that awaited `publish` and asserted a side-effect.**
  → Intended and CHANGELOG'd; the repo's own suites are the first consumers and are fixed in this
  PR. It also makes in-memory faithful to the brokers it stands in for, which is the argument for
  doing it rather than working around it.
- **A custom broker still deadlocks**, since §3.1 only fixes the bundled one. → That is what §3.2's
  bounded wait is for, and it is why the bound is not optional even though the measured cycle is
  gone.
- **The bound fires on a slow but legitimate startup**, refusing work that would have been
  delivered. → 10 000 ms against an `onInit` that does no I/O by contract; `0` disables it; and the
  error names the likely cause rather than asserting it.
- **A required member breaks an out-of-repo implementor.** → §3.4 states the cost, CHANGELOG carries
  the migration, and the ambiguity an optional member would create is the reason the cost is
  accepted rather than avoided.
- **`getRepositoryFor` invites use on the HTTP path**, bypassing the resolved tenant and reading an
  id from user input. → Its JSDoc says the id is trusted input and that `getRepository(ctx, …)` is
  the HTTP-path member; the README recipe shows it only in a behaviour.

## 9. Out of scope

- **X18-*/X19-1** — **M89a** and **M89b**.
- **Behaviour ordering across plugins.** Each ingress plugin owns its own chain, so four chains
  exist and nothing composes them; whether a concern can be expressed once for the _application_
  rather than once per plugin is a design question X16 raised and did not answer. Unowned.
- **A tenant slot on `IngressContext`** — §3.5.
- **`tenantById` and a tenant catalog.** Cut from this milestone in §3.4 because no committed
  surface can implement it: neither `MultiTenancyService` nor `ITenantDataStore` retains a tenant
  record. Adding one is a new port plus an implementation plus a source of truth for "which tenants
  exist", which is its own design. Unowned. `getRepositoryFor` alone closes X16-2, whose blocking
  problem was that a tenant-scoped **repository** is unreachable from background work.
- **`InMemoryBroker` gaining at-least-once or persistence semantics.** It is a test and
  single-process double; §3.1 changes only when its promise settles.
- **The `queue`/`scheduler`/`websocket` gates.** Measured: `queue.add` in `register()` boots, and a
  frame cannot arrive before its socket is open. Only the messaging gate had a reachable cycle.
