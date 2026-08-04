# Milestone 37b — DI, database, and messaging examples (`apps/*`)

> **Status:** Complete. Branch: `feat/m37-examples` — M37b rides M37's branch at the maintainer's
> direction (the M47 precedent for combined scope on one branch), so both milestones merge in a
> single PR. `main` is protected; all work stays on that branch until it merges.

## 0. Objective & scope

M37 shipped eleven runnable examples covering 16 packages. Three capabilities a reader is most
likely to reach for are absent from every one of them: dependency injection, decorators, and the
database plugin — `grep` for `DiPlugin|DecoratorPlugin|DatabasePlugin|@Controller|@Injectable` over
`apps/` returns nothing. Messaging is present but only as an in-process self-reply. This milestone
adds two examples and upgrades one, and fixes the defect that blocks the upgrade: every plugin that
loads `npm:ioredis` through its lazy path fails at `app.start()`.

- **In scope:** `apps/di-decorators`; `apps/database`; a cross-service brokered exchange in
  `apps/microservices`; the ioredis eager-connect fix in `cache-plugin`, `queue-plugin`, and
  `messaging-plugin`; the doc and status deliverables in §2.
- **NOT this milestone:** per-plugin prose docs and the runtime matrix — M38. Docker/compose/k8s for
  the examples — M39. Cloud broker backends (SQS/SNS, GCP Pub/Sub, Azure Service Bus) — unowned; §9
  records the finding that the messaging plugin has no extension point for them.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ioredis eager connect                | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:70,152`; `packages/queue-plugin/src/adapters/redis-queue.ts:72,111`; `packages/cache-plugin/src/stores/redis-store.ts:66,106` | All three do `new RedisCtor(url)` then `await client.connect()`. ioredis connects eagerly on construction, so the second call throws `Redis is already connecting/connected`. Driven against real Redis 7: all three fail `start()`. |
| The intent was already lazy          | `packages/cache-plugin/src/stores/redis-store.ts:104`                                                                                                                                        | The comment reads "Only call connect() if the client exposes it (lazy ioredis clients do)" — the code constructs an eager client, so the comment describes behaviour that never happens.                                             |
| `lazyConnect` is the fix             | probed with the real `npm:ioredis@5.x`                                                                                                                                                       | `new Ctor(url, { lazyConnect: true })` type-checks against `typeof import('npm:ioredis@5.x').Redis` and yields `status === 'wait'`, then `'ready'` after an explicit `connect()`.                                                    |
| Unaffected Redis users               | `packages/realtime-backplane-plugin`, `packages/scheduler-plugin`                                                                                                                            | The backplane's Redis transport ran green in the M37 realtime smoke against real Redis; `SchedulerPlugin({ distributedLock: { enabled: true, redisUrl } })` starts clean. Neither is touched.                                        |
| DI lifetimes                         | `packages/di-plugin/src/container/container.ts:121-151`, probed                                                                                                                              | `singleton` → one instance across root and every scope; `scoped` → one per `createScope()`; `transient` → new on every resolve. Observed serials `1 1 1` / `2 2 3` / `4 5`.                                                          |
| Nothing opens a per-request scope    | `packages/di-plugin/src/container/container.ts:142` is the only `createScope` in `packages/`                                                                                                 | Neither `kernel` nor `decorator-plugin` calls it, and `IRequestContext` has no container member. A controller is instantiated ONCE at registration (`decorator-plugin/src/plugin/decorator-plugin.ts:309`).                          |
| `Provider<T>` is an object, not a fn | `packages/common/src/container.ts:36-71`                                                                                                                                                     | `ClassProvider` (`useClass`/`inject`), `FactoryProvider` (`useFactory`), `ValueProvider` (`useValue`). A bare arrow is NOT a provider — it fails at runtime with `ctor is not a constructor`.                                        |
| Decorator wiring that works          | `packages/cli/src/templates/nest.ts:94-118`                                                                                                                                                  | `DecoratorPlugin({ controllers: [...], services: [...] })` plus `DiPlugin()`; `@Injectable({ token })` names the token, and parameter `@Inject('token')` binds by position.                                                          |
| Memory database adapter persists     | `packages/database-plugin/src/services/database-service.ts:70,79`, probed                                                                                                                    | `getRepository(entity)` then `create`/`findById`/`findAll`/`update`/`count` read real data back, and a throwing `transaction(work)` leaves `count()` unchanged — rollback is real, not a stub.                                       |
| `DatabasePluginOptions` is a union   | `packages/database-plugin/src/interfaces/index.ts:223-271`                                                                                                                                   | `BuiltInDatabaseOptions` (`type?: 'prisma' \| 'drizzle' \| 'memory'`) or `CustomDatabaseOptions` (`type: 'custom'` + required `adapter`). A missing backend is a compile error.                                                      |
| Memory broker is per plugin instance | probed with two apps in one process                                                                                                                                                          | Two `MessagingPlugin({ broker: 'memory' })` instances each build their own `InMemoryBroker`, so a cross-app `request`/`respond` times out. A cross-service exchange REQUIRES a networked broker.                                     |
| Skip protocol                        | `scripts/check-apps.ts:4,16`                                                                                                                                                                 | Exit code 77 is `'skipped'`; anything else non-zero fails the gate. The realtime example already uses it for `REDIS_URL`.                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                               | Resolution (picked side)                                                                                                               | Doc deliverable (same PR)                                                                                    |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| C1 | `packages/cache-plugin/src/stores/redis-store.ts:104` documents a lazy client; the code constructs an eager one. The comment is a claim the code path never satisfies. | The comment is right and the code is wrong — construct lazily. Same correction in the other two packages, which carry no such comment. | The fix itself, plus a `CHANGELOG.md` entry recording that Redis-backed cache/queue/messaging never started. |
| C2 | `ROADMAP.md` has no M37b section and no `37b` Progress row, exactly as M36b did before it was corrected.                                                               | Add both, mirroring the M36b entry's shape.                                                                                            | New M37b section and Progress row in `ROADMAP.md`.                                                           |
| C3 | `apps/README.md` claims to index every example and would omit the two new ones.                                                                                        | Add both rows with their smoke proofs.                                                                                                 | Two new rows in `apps/README.md`.                                                                            |
| C4 | The M37 CLAUDE.md entry records the microservices example as proving "brokered request/reply" without saying the responder is the caller itself.                       | The upgrade makes the claim true; the entry is amended rather than left to imply more than it did.                                     | Amend that clause in the M37 status entry.                                                                   |

## 3. Design decisions

### 3.1 The ioredis fix is one line per package, at construction

- **Decision:** each of the three loaders changes `new RedisCtor(url)` to
  `new RedisCtor(url, { lazyConnect: true })`. The existing
  `if (typeof client.connect === 'function') await client.connect()` guard stays exactly as it is.
- **Why:** it restores the behaviour the cache store's own comment already describes (C1), keeps the
  lifecycle the plugins document — connect during `register()`, disconnect on close — and leaves an
  injected client untouched, since the guard still decides whether to call `connect()` on it. Not
  calling `connect()` at all was rejected: it would make readiness depend on the first command, so a
  bad URL would surface as a failed request rather than a failed startup.
- **Test home:** `redis-client-factory.test.ts` in each of the three packages (§6).

### 3.2 The construction site becomes an internal seam so the fix is unit-testable

- **Decision:** each package gains a module-local `createLazyRedisClient(Ctor, url)` that its
  `resolveClient` calls. It is exported from its module for its test, and NOT from `src/index.ts`.
- **Why:** the defect survived because every existing test injects a fake client, so the real
  construction path was never exercised — the "test doubles must honor the real contract" failure. A
  seam makes the decidable part (which options object reaches the constructor) assertable with no
  Redis running, which is the prescribed technique for a branch behind an optional dependency. The
  real path is additionally covered by a guarded test and by the examples' smoke checks.
- **Test home:** the same three `redis-client-factory.test.ts` files.

### 3.3 `apps/di-decorators` proves lifetimes, and documents that request scopes are manual

- **Decision:** one example registers a `@Controller` with a parameter-level `@Inject`, and its
  smoke check asserts three things: the decorated route answers through the injected service; a
  `singleton` resolves to the same instance from two different scopes; and a `scoped` resolves to
  one instance within a scope and a different one in another. The scope is created explicitly by the
  route handler via `container.createScope()`, and the README states plainly that the framework
  opens no per-request scope for you.
- **Why:** §1 establishes that nothing in the kernel or `decorator-plugin` ever calls `createScope`
  and that controllers are instantiated once at registration. An example asserting "a scoped service
  is per-request" would therefore be asserting a fiction; documenting the manual step is both true
  and the more useful thing for a reader arriving from NestJS.
- **Test home:** `apps/di-decorators/smoke.ts`.

### 3.4 `apps/database` proves persistence by reading writes back, and proves rollback

- **Decision:** the example uses the `'memory'` adapter so it runs with no service, and its smoke
  check writes a row, reads it back through `findById`, updates it, then runs a `transaction()` that
  throws and asserts the row count is unchanged.
- **Why:** M10 shipped Prisma and Drizzle adapters whose `create()` echoed input without persisting
  and whose `findAll()` returned `[]`, at 90% coverage with deliverables ticked. Reading a write
  back through the public surface is the exact guard CLAUDE.md prescribes for that class, and
  rollback is the one repository behaviour a stub cannot fake. §1 confirms the memory adapter
  satisfies both.
- **Test home:** `apps/database/smoke.ts`.

### 3.5 `apps/microservices` moves the responder onto service B over a real broker

- **Decision:** service B registers `MessagingPlugin({ broker: 'redis-streams', url })` and owns the
  `respond` handler; service A issues the `request`. The brokered half of the smoke check runs only
  when `REDIS_URL` is set and exits 77 otherwise; the discovery half continues to run
  unconditionally.
- **Why:** §1 establishes that two memory brokers in one process cannot reach each other, so the
  current self-reply is the only thing the memory transport can demonstrate — the same weakness the
  M37 realtime example had before its fix. This makes the README's claim true and gives the tree its
  first example that crosses a real broker, which is what would have caught the §1 defect.
- **Test home:** `apps/microservices/smoke.ts`.

### 3.6 A skipped half reports, and never silently shrinks the check

- **Decision:** when `REDIS_URL` is absent the microservices smoke prints a `SKIP:` line naming the
  brokered half, runs the discovery half, and exits 77 so the walker reports the example as skipped.
- **Why:** the alternative — passing with a quieter assertion set — is the failure mode this whole
  gate exists to remove, and 77 already means "a prerequisite was unavailable" (§1).
- **Test home:** `apps/microservices/smoke.ts`, exercised both ways during verification.

## 4. Exported surface — every symbol names its consumer

No `apps/*` module is published, none is a workspace member, and nothing under `packages/` imports
one, so the examples add no exported surface. The fix adds no symbol to any `src/index.ts`.

| Exported symbol              | Kind     | Consumer / real code path that READS it                                                                                                                                                             |
| ---------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createLazyRedisClient` (×3) | function | Module-local only: each package's own `resolveClient`, plus its `redis-client-factory.test.ts`. Deliberately NOT re-exported from `src/index.ts`, so it is an internal seam rather than public API. |

### 4.1 Options — every option names its consumer

This milestone adds no plugin, no factory, and no option bag. The examples configure existing
plugins through their committed option types, and the fix changes an argument at one call site per
package rather than introducing a setting.

| Option                                | Consumer                                                      | Behavior (per implementation)                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `lazyConnect: true` (constructor arg) | `npm:ioredis` in all three `createLazyRedisClient` call sites | Defers the socket until `connect()` is called, which each caller then does — so startup order is unchanged and a bad URL still fails `start()`. |

## 5. Implementation files

| File                                                                                           | Purpose                                                                |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/redis-streams-broker.ts`                                | `createLazyRedisClient` seam; construct with `lazyConnect`.            |
| `packages/queue-plugin/src/adapters/redis-queue.ts`                                            | Same seam and fix.                                                     |
| `packages/cache-plugin/src/stores/redis-store.ts`                                              | Same seam and fix; its stale comment becomes true.                     |
| `apps/di-decorators/{deno.json,main.ts,smoke.ts,README.md}`                                    | The DI and decorator example and its proof.                            |
| `apps/di-decorators/src/{app.ts,greeting-service.ts,greeting-controller.ts,report-service.ts}` | Decorated controller, injected service, and the scoped/singleton pair. |
| `apps/database/{deno.json,main.ts,smoke.ts,README.md}`                                         | The database example and its proof.                                    |
| `apps/database/src/app.ts`                                                                     | Repository routes over the memory adapter.                             |
| `apps/microservices/{src/app.ts,smoke.ts,README.md}` (edit)                                    | Responder moves to service B over a networked broker (§3.5).           |
| `apps/README.md` (edit)                                                                        | Two new index rows (C3).                                               |
| `ROADMAP.md`, `CLAUDE.md`, `CHANGELOG.md` (edit)                                               | C1, C2 and C4 doc deliverables plus the status flip.                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

The 90% per-file bar does not apply to `apps/*` — coverage measures `packages`, and these are demo
applications (the M37 §3.3 decision). It DOES apply to the three `packages/` files the fix touches,
all of which are already at or above it and must not regress.

| Test file                                                          | src covered               | Key assertions (and the signature each call type-checks against)                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/test/unit/redis-client-factory.test.ts` | `redis-streams-broker.ts` | `createLazyRedisClient(FakeCtor, url)` passes `{ lazyConnect: true }` as the second constructor argument and the url as the first. Fails against the pre-fix single-argument call.                |
| `packages/queue-plugin/test/unit/redis-client-factory.test.ts`     | `redis-queue.ts`          | Same, against that package's seam.                                                                                                                                                                |
| `packages/cache-plugin/test/unit/redis-client-factory.test.ts`     | `redis-store.ts`          | Same, against that package's seam.                                                                                                                                                                |
| `apps/di-decorators/smoke.ts`                                      | that example              | The decorated route answers via the injected service; one `singleton` instance across two scopes; two distinct `scoped` instances, one per scope (§3.3).                                          |
| `apps/database/smoke.ts`                                           | that example              | A written row reads back by id and appears in `findAll`; an update is visible on re-read; a throwing `transaction()` leaves `count()` unchanged (§3.4).                                           |
| `apps/microservices/smoke.ts`                                      | that example              | A resolves B through discovery and calls it; A's `request` is answered by the handler registered on B, over a networked broker; absent `REDIS_URL` the brokered half reports a skip (§3.5, §3.6). |

Each smoke check must be verified to **discriminate**: break the thing it proves, confirm it fails,
restore it. The ioredis fix must additionally be shown to fail without the change, against real
Redis, through `app.start()` for all three plugins.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m37-examples, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:apps        # every example type-checks and smoke-runs
REDIS_URL=redis://127.0.0.1:6379 deno task check:apps   # with the skipped halves actually running
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.4
```

## 8. Risks & mitigations

- The fix changes startup behaviour for three published plugins → the guard around `connect()` is
  untouched and injected clients take the same path they always did; the three seam tests plus a
  real-Redis run of all three plugins through `app.start()` cover both paths.
- A reader copies the DI example expecting per-request scoping → §3.3 makes the manual
  `createScope()` the visible part of the example and the README states the limitation directly.
- The microservices brokered half is skipped in CI (no Redis) and rots → it is the same 77-skip the
  realtime example already uses, and both are exercised locally against a real container before the
  PR; the skip is named in the CI log rather than silent.
- Two new examples plus a three-package fix is a wide PR → the examples are independent by
  construction (one directory and one index row each) and the fix is one line per package behind a
  named seam, so a blocked piece does not hold the others.

## 9. Out of scope

- **Cloud broker backends** — SQS/SNS, GCP Pub/Sub, Azure Service Bus. Verified absent:
  `MessagingBrokerType` is `'memory' | 'redis-streams' | 'rabbitmq' | 'nats' | 'kafka'`
  (`packages/messaging-plugin/src/interfaces/index.ts:205`) and the factory is a closed switch that
  throws on anything else (`plugin/messaging-plugin.ts:145`), with no `'custom'` arm and no way to
  inject a broker — unlike `feature-flags`, `database`, `realtime-backplane` and
  `service-discovery`, which all have one. Unowned; needs its own milestone.
- **A `'custom'` arm for `MessagingPluginOptions`** — the natural prerequisite for the above, and a
  `common`-adjacent public API change that does not belong in an examples milestone.
- **Per-plugin prose documentation and the deploy matrix** — M38.
- **Dockerfiles, compose, and Kubernetes manifests** for the examples — M39.
