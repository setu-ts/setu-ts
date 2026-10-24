# Milestone 119b — Health readiness scope (`@setu-ts/health-plugin` and contributors)

> **Status:** Planning. Branch: `feat/m119b-readiness-scope`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

M113b decided that `/ready` failing means "take this replica out of rotation". Four indicators still
do that for a problem no replica can fix, or report a dependency up when it is not. This milestone
gives every health indicator a readiness membership — whether it counts toward `/ready` — that the
contributing plugin declares and the application can override, takes mail out of readiness by
default, and repairs the three indicators whose probes are unbounded, blind, or stacked.

- **In scope:** V10-49 (per-indicator readiness, maintainer decision 2026-10-24; mail out of
  readiness by default), V10-20 (bounded, cached backplane probe), V10-22 (RabbitMQ queue round-trip
  probe; a queue probe that does not answer reports `'unknown'`), V10-31 (migration ledger read only
  on a reachable connection), and the gRPC health bridge reading readiness so it agrees with
  `/ready`.
- **NOT this milestone:** changing the readiness default of any indicator other than mail (database,
  cache, messaging, queue, storage, service-discovery keep counting; an application excludes them
  through the new option); the kubelet `timeoutSeconds` in generated manifests (M119c owns generated
  defaults); a readiness membership for `/live` (it stays `self` only).

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IHealthIndicator`                    | `packages/common/src/services/health.ts:44-53`                                                            | `{ readonly name: string; check(): Promise<HealthCheckResult> }` — no readiness field.                                                                                                                                                                                                                                                                             |
| `IHealthService`                      | `packages/common/src/services/health.ts:85-115`                                                           | `registerIndicator(name, indicator: HealthIndicatorFn): void`, `check()`, `checkLive()`, `checkReady()`.                                                                                                                                                                                                                                                           |
| `IHealthApi` (plugin context)         | `packages/common/src/plugin.ts:207-215`                                                                   | `register(name: string, indicator: HealthIndicatorFn): void` — the only way a plugin contributes an indicator.                                                                                                                                                                                                                                                     |
| Kernel `ctx.health.register`          | `packages/kernel/src/application/application.ts:595-602`                                                  | Registers `{ name, check: indicator }` under `CAPABILITIES.HEALTH_INDICATOR` with `{ multi: true }`.                                                                                                                                                                                                                                                               |
| HealthPlugin draining contributions   | `packages/health-plugin/src/plugin/health-plugin.ts:158-233`                                              | Registers `self`, then app `indicators` instances (`:164-166`), then at `onInit` factory entries (`:216-224`) and `HEALTH_INDICATOR` contributions read as `{ name, check }` (`:227-233`), each through `service.registerIndicator(name, check)`.                                                                                                                  |
| `/ready` selection                    | `packages/health-plugin/src/services/health-service.ts:242-244`                                           | `checkReady()` runs every indicator except `self`; `checkLive()` runs only `self` (`:233-235`).                                                                                                                                                                                                                                                                    |
| `/ready` status mapping               | `packages/health-plugin/src/plugin/health-plugin.ts:309-326`                                              | `/ready` 200 only when the aggregate is `up`; `/health` 503 only on `down`.                                                                                                                                                                                                                                                                                        |
| `HealthPluginOptions`                 | `packages/health-plugin/src/interfaces/index.ts:156`                                                      | `details`, `endpoints`, `indicators`, then the timeout and diagnostics options — no readiness option.                                                                                                                                                                                                                                                              |
| Unmatched-name warning precedent      | `packages/health-plugin/src/plugin/health-plugin.ts:183-197`                                              | Approved diagnostics names that match no indicator are warned at `onInit` by COUNT, never by name ("indicator names are treated as sensitive topology").                                                                                                                                                                                                           |
| Health-plugin guidance                | `packages/health-plugin/README.md:145-147`                                                                | "A shared problem that does not stop request serving belongs in the indicator's `data`".                                                                                                                                                                                                                                                                           |
| Mail indicator                        | `packages/mail-plugin/src/plugin/mail-plugin.ts:150-163`                                                  | Not ready → `down`; `isHealthy()` `false` → `down`; `undefined` → `up` + `'unknown'`. Registered with `ctx.health.register(CAPABILITIES.MAIL, mailIndicator)`. V10-49 confirmed.                                                                                                                                                                                   |
| Backplane indicator                   | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:135-150`                      | Status always `up` (M113b), but awaits `backplane.isHealthy()` with no bound or cache; the Redis transport's `PING` is bounded only by `commandTimeoutMs` (default `DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000`, `interfaces/index.ts:253`), above health's 5 000 ms indicator timeout, which records `down`. V10-20 confirmed.                                     |
| Queue indicator + probe               | `packages/queue-plugin/src/services/queue-service.ts:278-305`, `:338-351`                                 | `#buildProbe` wraps `adapter.isHealthy` in `createCachedProbe` (TTL 5 000, bound 2 000, boolean form → fallback `false`); `false` → `down`.                                                                                                                                                                                                                        |
| RabbitMQ queue `isHealthy`            | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts:452`                                                | `Promise.resolve(!this.#supervisor.faulted)` — a flag a paused broker never trips. V10-22 confirmed.                                                                                                                                                                                                                                                               |
| Queue adapter port                    | `packages/queue-plugin/src/adapters/queue-adapter.ts:34`, `:91`                                           | Internal `QueueAdapter` (not barrel-exported), optional `isHealthy?(): Promise<boolean>`.                                                                                                                                                                                                                                                                          |
| Messaging precedent (M95b)            | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:610-690`                                        | `reachability()` short-circuits a fault window to `false`, else a cached (5 s) bounded (2 s) throwaway-channel round trip resolving `undefined` on timeout; `#openThrowawayChannel` opens and closes its own channel.                                                                                                                                              |
| `createCachedProbe`                   | `packages/common/src/health/probe.ts:121-137`                                                             | Boolean form defaults `fallback` to `false`; the widened form requires `fallback` (may be `undefined`).                                                                                                                                                                                                                                                            |
| Database + migration readiness        | `packages/database-plugin/src/plugin/database-plugin.ts:270-306`; `src/migrations/migration-readiness.ts` | A probe that does not answer → `degraded`, `reachable: 'unknown'`. The readiness wrapper skips only `down`, then reads the ledger (its own 2 000 ms bound); `'unreadable'` → `down`. A paused database therefore reads `down` after ~4 s. V10-31 confirmed.                                                                                                        |
| gRPC health bridge                    | `packages/grpc-plugin/src/health/grpc-health-bridge.ts:73-95`                                             | `resolveServingStatus` calls `healthService.check()` (all indicators), not `checkReady()`. Its docs (`docs/health-indicators.md:20-21`) say the mapping "agrees with `/ready`".                                                                                                                                                                                    |
| Other implementors of the two methods | grep over `packages/*/src`                                                                                | `IHealthApi.register`: kernel only. `IHealthService.registerIndicator`: `HealthService` only. Adding an optional parameter breaks neither.                                                                                                                                                                                                                         |
| **External frameworks (2026-10-24)**  | Spring Boot, ASP.NET Core, MicroProfile/Quarkus docs (sources in the PR)                                  | All give each check a readiness membership: Spring health groups (`management.endpoint.health.group.readiness.include`; Spring adds no external checks by default and its mail indicator is not in readiness), ASP.NET tags filtered by the `/ready` predicate, MicroProfile `@Readiness`/`@Liveness` (Quarkus puts the datasource check in readiness by default). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                     | Resolution (picked side)                                              | Doc deliverable (same PR)                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `docs/health-indicators.md:20-21` says the gRPC bridge "agrees with `/ready`"; the bridge reads `check()`    | The doc's intent wins: the bridge reads `checkReady()` (§3.6)         | Wording unchanged; `packages/grpc-plugin/README.md` health section states it reads readiness                                                   |
| C2  | Health-plugin README says a shared problem belongs in `data`; mail reports `down` and counts toward `/ready` | Mail keeps an honest `down` but is out of readiness by default (§3.3) | `health-plugin/README.md` gains a "Readiness membership" section; `mail-plugin/README.md` health section; `docs/health-indicators.md` mail row |

## 3. Design decisions

### 3.1 Readiness membership on every indicator

- **Decision:** `@setu-ts/common` gains
  `interface HealthIndicatorOptions { readonly readiness?: boolean }` (`@since 0.11.0`), and three
  additive optional members:
  `IHealthApi.register(name, indicator, options?: HealthIndicatorOptions)`,
  `IHealthService.registerIndicator(name, indicator, options?: HealthIndicatorOptions)`, and
  `IHealthIndicator.readiness?: boolean`. Absent means `true` (today's behaviour). The kernel's
  `ctx.health.register` stores `readiness` on the `HEALTH_INDICATOR` registration only when it is
  supplied (`exactOptionalPropertyTypes`). `HealthPlugin` passes it through for all three sources:
  app `indicators` instances and factory results (read from `IHealthIndicator.readiness`) and
  contributions (read from the registration). `HealthService` stores the declared membership per
  indicator; `checkReady()` runs the indicators that are not `self` and whose effective membership
  (§3.2) is `true`. An indicator out of readiness still runs in `check()` (`/health`) and is ABSENT
  from the `/ready` report. `checkLive()` is unchanged.
- **Why:** the maintainer's choice (2026-10-24). Every framework compared gives each check this
  membership; Setu had none, so the only lever was to change an indicator's status, which hides the
  outage from `/health`.
- **Test home:** `packages/health-plugin/test/unit/health-service-readiness.test.ts` (new: an
  indicator registered with `readiness: false` runs in `check()`, is absent from `checkReady()`, and
  a `down` there leaves `/ready` 200 while `/health` is 503);
  `packages/kernel/test/integration/application.test.ts` (the option reaches the registry; absent
  when not supplied).

### 3.2 Application override: `HealthPluginOptions.readiness`

- **Decision:**
  `HealthPluginOptions.readiness?: { readonly include?: readonly string[]; readonly exclude?: readonly string[] }`
  (`@since 0.11.0`). `include` forces a named indicator into readiness, `exclude` forces it out;
  each overrides the contributor's declared membership. Validated at `HealthPlugin(...)`: each must
  be an array of non-empty strings; a name in both, or the name `self`, throws `TypeError` naming
  the option (never the value). At `onInit`, after every source is registered, names that match no
  indicator are warned once by COUNT through the logger, following the diagnostics precedent at
  `health-plugin.ts:183-197`. The effective membership is computed once at registration time, not
  per request.
- **Why:** the contributor knows the default; the operator knows the deployment. Spring's group
  `include`/`exclude` is the same split. Count-only warnings keep indicator names out of logs.
- **Test home:** `packages/health-plugin/test/unit/health-plugin-readiness-options.test.ts` (new:
  validation table; include pulls mail back in; exclude drops a contributed indicator; the overlap
  and `self` refusals; the count-only warning).

### 3.3 Mail is out of readiness by default (V10-49)

- **Decision:** `MailPlugin` registers its indicator with `{ readiness: false }`. Its status mapping
  is unchanged (`down` when unreachable), so `/health` reports the outage and alerts still fire;
  `/ready` ignores it. An application that wants mail to drain replicas sets
  `HealthPlugin({ readiness: { include: ['mail'] } })`.
- **Why:** an SMTP outage is shared by every replica and does not stop request serving — the case
  the health-plugin README already assigns to "not readiness". Spring's mail indicator is likewise
  outside its readiness group by default.
- **Test home:** `packages/mail-plugin/test/` indicator test (registration carries
  `readiness: false`); an integration test booting `HealthPlugin` + `MailPlugin` with a failing
  provider: `/ready` 200, `/health` 503 with `mail.status: 'down'`; with `include: ['mail']`,
  `/ready` 503.

### 3.4 Bounded, cached backplane probe (V10-20)

- **Decision:** the realtime-backplane indicator reads reachability through `createCachedProbe` with
  the widened form (`fallback: 'unknown'`), TTL 5 000 ms, bound 2 000 ms, timing from
  `resolveProbeTiming(ctx.runtime)`, built once at registration. A transport without `isHealthy`
  stays `'unknown'`; a probe that throws resolves the fallback (the helper never rejects). Status
  stays `up`.
- **Why:** M113b already put fan-out loss in `data`; only the unbounded `PING` broke it, by
  outliving health's 5 000 ms indicator timeout. The bound sits below that timeout, as every other
  M90b indicator's does.
- **Test home:** `packages/realtime-backplane-plugin/test/unit/` health test (a never-settling
  `isHealthy` → `up`, `reachable: 'unknown'` inside the bound; result cached within the TTL);
  `test/integration/` real Redis guarded on `REDIS_URL`: paused Redis → `/ready` 200,
  `reachable: 'unknown'`.

### 3.5 RabbitMQ queue round trip, and an unanswered queue probe is `'unknown'` (V10-22)

- **Decision:** `RabbitMqQueue` replaces the flag read with the messaging M95b mechanism: a fault
  window short-circuits to `false`; otherwise it opens a throwaway channel on the connection and
  closes it in a `finally`, `false` when the open rejects. `QueueService.#buildProbe` switches to
  the widened `createCachedProbe<boolean | undefined>` with `fallback: undefined` (TTL and bound
  unchanged), and the indicator maps `undefined` to `up` with `reachable: 'unknown'` (depths not
  read), `false` to `down`, `true` to `up` with depths. This applies to every queue adapter: a probe
  that does not answer in 2 000 ms now reports `'unknown'` instead of `down`.
- **Why:** a paused broker keeps its socket, so only a real AMQP exchange can tell; a hung probe is
  not evidence the backend is down, which is the rule M95b set for messaging and M90b for the
  database pool. A stopped broker still reads `down` at once.
- **Test home:** `packages/queue-plugin/test/unit/` RabbitMQ adapter test (fault → `false` without a
  channel open; open rejects → `false`; open resolves → `true` and the channel is closed);
  `queue-service` health test (never-settling probe → `up` + `'unknown'`, no depth read);
  `test/integration/` real RabbitMQ guarded on `RABBITMQ_URL`: paused broker →
  `reachable: 'unknown'`, never `true`; stopped → `down`.

### 3.6 gRPC health reads readiness

- **Decision:** `resolveServingStatus` calls `healthService.checkReady()` instead of `check()`; the
  mapping is unchanged. With no readiness indicators the aggregate is `up` → `SERVING`.
- **Why:** gRPC probes stand in for `/ready` in Kubernetes; reading `check()` would let an indicator
  that is out of readiness (mail) still take the replica out through gRPC.
- **Test home:** `packages/grpc-plugin/test/unit/` health bridge test (a fake whose `check()` is
  `down` and `checkReady()` is `up` → `SERVING`; `checkReady()` rejecting → `NOT_SERVING`).

### 3.7 Migration readiness reads the ledger only on a reachable connection (V10-31)

- **Decision:** the readiness wrapper skips the ledger read, and returns the indicator's result
  unchanged with `migrations: { state: 'unknown' }` added to `data`, when the result is `down` or
  its `data.reachable` is `false` or `'unknown'` (this covers a paused database's `degraded` and a
  saturated pool's `up` + `'unknown'`). It reads the ledger, as today, when `data.reachable` is
  `true` or is omitted — omitted is the deliberate M95b shape of an adapter with no reachability
  probe (Cosmos, Bigtable, DynamoDB, an injected client; `database-plugin.ts:224-245`), whose
  healthy `up` must still be checked for pending migrations. The other states (`unreadable`,
  `pending`, `current`) are unchanged.
- **Why:** with the ledger read skipped, a paused database reads `degraded` in one bound (~2 s), the
  same as with readiness off, instead of `down` after two stacked bounds.
- **Test home:** `packages/database-plugin/test/unit/migration-readiness.test.ts` (a table over the
  input shapes: `down`; `degraded` + `'unknown'`; `up` + `'unknown'`; `reachable: false` → unchanged
  status, `state: 'unknown'`, ledger never called; `up` + `true` and `up` with `reachable` omitted →
  ledger read as today).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Each addition is an optional parameter or member; the only
implementors in the repository (kernel, `HealthService`) are updated, and an outside implementor
with fewer parameters stays assignable. Behaviour changes for `0.11.0`, recorded in CHANGELOG and
`docs/upgrading.md`: a mail outage no longer fails `/ready` or gRPC health; gRPC health ignores
out-of-readiness indicators; an unanswered queue probe reports `up` + `'unknown'` instead of `down`.

| Exported symbol                                 | Kind            | Consumer / real code path that READS it                                                                                |
| ----------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HealthIndicatorOptions` (common)               | interface       | Parameter type of `IHealthApi.register` and `IHealthService.registerIndicator`; read by the kernel and `HealthService` |
| `IHealthIndicator.readiness` (common)           | optional member | Read by `HealthPlugin` when registering app `indicators` instances and factory results                                 |
| `HealthPluginOptions.readiness` (health-plugin) | option          | Read by `HealthPlugin` to compute effective membership (§3.2)                                                          |

### 4.1 Options — every option names its consumer

| Option                                               | Consumer                                                                    | Behavior (per implementation)                                                                                  |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `register(..., { readiness })`                       | kernel → `HEALTH_INDICATOR` registration → `HealthPlugin` → `HealthService` | `false` keeps the indicator out of `checkReady()`; absent/`true` counts                                        |
| `HealthPluginOptions.readiness.include` / `.exclude` | `HealthPlugin`                                                              | Override the declared membership by indicator name; validated at construction; unmatched names warned by count |

## 5. Implementation files

| File                                                                                                                                                                             | Purpose                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/health.ts`                                                                                                                                         | `HealthIndicatorOptions`; `IHealthIndicator.readiness`; `IHealthService.registerIndicator` options |
| `packages/common/src/plugin.ts`                                                                                                                                                  | `IHealthApi.register` options                                                                      |
| `packages/common/src/index.ts`                                                                                                                                                   | export `HealthIndicatorOptions`                                                                    |
| `packages/kernel/src/application/application.ts`                                                                                                                                 | pass `readiness` into the registration                                                             |
| `packages/health-plugin/src/services/health-service.ts`                                                                                                                          | store membership; `checkReady()` filter                                                            |
| `packages/health-plugin/src/plugin/health-plugin.ts`                                                                                                                             | read membership from all three sources; apply and validate the override; count-only warning        |
| `packages/health-plugin/src/interfaces/index.ts`                                                                                                                                 | `HealthPluginOptions.readiness`                                                                    |
| `packages/mail-plugin/src/plugin/mail-plugin.ts`                                                                                                                                 | register with `{ readiness: false }`                                                               |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`                                                                                                     | cached, bounded probe                                                                              |
| `packages/queue-plugin/src/adapters/rabbitmq-queue.ts`                                                                                                                           | throwaway-channel round trip                                                                       |
| `packages/queue-plugin/src/services/queue-service.ts`                                                                                                                            | widened probe, `'unknown'` mapping                                                                 |
| `packages/grpc-plugin/src/health/grpc-health-bridge.ts`                                                                                                                          | `checkReady()`                                                                                     |
| `packages/database-plugin/src/migrations/migration-readiness.ts`                                                                                                                 | skip ledger unless reachable                                                                       |
| READMEs of health, mail, queue, realtime-backplane, database, grpc; `PUBLIC_API.md`; `docs/health-indicators.md`; `CHANGELOG.md`; `docs/upgrading.md`; `ROADMAP.md`; `CLAUDE.md` | C1, C2, the 0.11.0 behaviour changes, the M119b status flip; plan archived to `plans/archive/`     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                             | src covered                                   | Key assertions                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/health-plugin/test/unit/health-service-readiness.test.ts` (new)                                                                                             | `health-service.ts`                           | §3.1 membership and report shape                                                          |
| `packages/health-plugin/test/unit/health-plugin-readiness-options.test.ts` (new)                                                                                      | `health-plugin.ts`, `interfaces/index.ts`     | §3.2 table; all three sources carry `readiness`; endpoint status codes through `inject()` |
| `packages/kernel/test/integration/application.test.ts` (extend)                                                                                                       | `application.ts`                              | option stored when supplied, absent otherwise                                             |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                                                                                           | `services/health.ts`, `plugin.ts`, `index.ts` | `HealthIndicatorOptions` exported; optional members type-check                            |
| `packages/mail-plugin/test/unit/mail-plugin.test.ts` (extend) + `test/integration/mail-readiness.test.ts` (new)                                                       | `mail-plugin.ts`                              | §3.3                                                                                      |
| `packages/realtime-backplane-plugin/test/unit/realtime-backplane-plugin.test.ts` (extend) + `test/integration/outage-real.test.ts` (extend, guarded `REDIS_URL`)      | `realtime-backplane-plugin.ts`                | §3.4                                                                                      |
| `packages/queue-plugin/test/unit/rabbitmq-queue.test.ts` + `queue-service.test.ts` (extend) + `test/integration/outage-real.test.ts` (extend, guarded `RABBITMQ_URL`) | `rabbitmq-queue.ts`, `queue-service.ts`       | §3.5                                                                                      |
| `packages/grpc-plugin/test/unit/grpc-health-bridge.test.ts` (extend)                                                                                                  | `grpc-health-bridge.ts`                       | §3.6                                                                                      |
| `packages/database-plugin/test/unit/migration-readiness.test.ts` (extend)                                                                                             | `migration-readiness.ts`                      | §3.7                                                                                      |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119b-readiness-scope
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run test:deno-lane
pnpm run check:docs
# with the local backend containers: the guarded Redis and RabbitMQ health tests
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Behaviour proofs before the PR: boot an app with HealthPlugin, MailPlugin (SMTP pointed at a stopped
Mailpit) and show `/ready` 200 / `/health` 503 on the branch against `/ready` 503 on develop; pause
`he-redis` and `he-rabbitmq` and show the backplane and queue indicators settle inside the bound
with `'unknown'`. Each new unit test fails with its fix reverted. Security audit: not required — no
new input parsing, credential or tenant path; the new option is application configuration.

## 8. Risks & mitigations

- An operator relied on a mail outage failing `/ready` →
  `HealthPlugin({ readiness: { include: ['mail'] } })` restores it; CHANGELOG and upgrade guide say
  so.
- A hung Redis queue now stays in rotation (`'unknown'`) where it used to drain → consistent with
  M95b messaging and M90b database; the stopped case is still `down`; the upgrade guide names the
  change and the `include`/`exclude` lever.
- Indicator names in `readiness` options are topology → never echoed in errors or warnings (count
  only), following the diagnostics precedent.
- `docs/health-indicators.md` indexes `ctx.health.register` sites by line → re-index every row whose
  line moves (the M119a trap); the audit test fails otherwise.

## 9. Out of scope

- Other indicators' readiness defaults — unchanged; the application overrides per deployment.
- Kubelet probe `timeoutSeconds` in generated manifests — M119c.
- A readiness membership for `/live` — `/live` stays `self` only.
