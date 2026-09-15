# Milestone 95b — Messaging (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m95b-service-bus-reachability`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

**Three indicators report `up` for a backend that cannot be reached.** A replica that cannot reach
its dependency stays in rotation, takes traffic, and fails every request that needs it. One
mechanism underlies all three: a flag set at `connect()` — or cleared only by a connection fault —
is reported as liveness.

The row this plan was opened for: with the Azure Service Bus broker **stopped** — TCP refused —
`/health` reports `up` and `/ready` answers `200`, while every `publish` throws. Measured as a 2×2
against the emulator `docs/messaging-emulators.md` documents:

|         | broker UP    | broker DOWN  |
| ------- | ------------ | ------------ |
| `0.5.0` | `down` / 503 | `down` / 503 |
| `0.6.0` | `up` / 200   | `up` / 200   |

The indicator discriminates in **neither** version against this emulator. `0.5.0` always said
`down`; `0.6.0` always says `up`. The `v0.6.0` fix for V5-2 was correct for the live case and traded
a false `down` for a false `up`. This milestone makes the indicator report on the plane the
application actually uses, and corrects a release claim that is measurably false.

### The letter is wider than this section was written for

**Two findings were added after this plan was first written, and one of them falsifies its own
out-of-scope clause.** The `v0.6.0` Part 11 run (`smoke/X46-X51-FINDINGS.md`) drove every configured
backend through **three** conditions rather than one — **stopped**, **hung** (`docker pause`: the
socket stays open and nothing answers), and **restored** — and found the same fail-open shape on two
more surfaces:

| backend                | stopped              | hung                 |
| ---------------------- | -------------------- | -------------------- |
| **database** (mongodb) | **`up` / ready 200** | **`up` / ready 200** |
| messaging (rabbitmq)   | `down` / 503         | **`up` / 200**       |
| cache, queue (redis)   | `down` / 503         | `down` / 503         |
| storage (s3)           | `down` / 503         | `down` / 503         |
| mail, notification     | `down` / 503         | `down` / 503         |

**The original clause said the other six broker arms were out of scope because their "probes read
the plane they report on" and their `up → down → up` "is already pinned by
`test/integration/outage-real.test.ts` (M70c §3.7)". Both halves are false for RabbitMQ**, and the
plan's own rule — any claim about code this change does not own must be checked against that code —
is what should have caught it:

- `RabbitMqBroker.isHealthy()` is `Promise.resolve(!this.#supervisor.faulted)`
  (`rabbitmq-broker.ts:269-271`) — a **flag read**, no I/O, measured at `latencyMs: 0.576` against a
  broker that would not complete an AMQP handshake. It does not read the plane it reports on.
- `outage-real.test.ts` drives "a **real** stop and restart, asserting the sequence
  `up → (stop) down → (restart) up`" (its own header, lines 3-4). A **stopped** container drops the
  connection and trips the fault flag; a **paused** one never does. The existing gate covers the
  condition the probe already handles and not the one it does not.

So this letter now carries **three** rows of one mechanism — _a lifecycle or fault flag is reported
as liveness_ — and the design decision in §3.2 is framed across the seam rather than one broker.

**X51-1 is the letter's lead and the milestone's second High.** `DatabaseService.isHealthy()`
returns `this._adapter.isReady()` (`services/database-service.ts:254`), the lifecycle member
inherited from `IOrmAdapter`. Measured with MongoDB stopped and the port provably refused, held 20 s
past the 5 s probe TTL: `/ready` `200`, `/health` `up` at `latencyMs: 0.356` — no I/O — and a real
repository read `500`. The `database` check is also the only one of the seven ports carrying M90b's
seam that publishes **no `reachable` field at all**. This is the probe the CLI's own generated
Kubernetes manifests point at (M95a/D2), so a pod with a dead database passes readiness, keeps its
endpoint, and a rolling deploy rolls forward over it.

**Why nobody had noticed:** the reachability seam has been extended package by package across three
separate merged changes — M70c (six plugins, `CHANGELOG:2409`), PR #269 (service-bus), PR #270
(audit, notification, worker-pool) — and `database-plugin` was in none of them.

- **In scope:** `DatabaseService`/`IDatabaseAdapter`'s reachability signal (X51-1);
  `RabbitMqBroker`'s (X51-2); `ServiceBusBroker`'s (the original row); the false `isReady()`
  safety-net claim in its JSDoc, the `v0.6.0` CHANGELOG entry and `PUBLIC_API.md`; and a guarded
  real-backend matrix that fails if any of the three stops discriminating in a future release.
- **NOT this milestone:** the four broker arms whose probes DO perform a round trip against the
  plane they report on — verified per arm, not assumed this time: redis-streams and the two
  Redis-backed ports call `ping()`, S3 issues a bucket `head('')`, SMTP calls
  `transport.verify?.()`. Their hung-condition behaviour was measured correct in the table above. No
  capability token is added. M95a owns the generated-deployment crash; M95c owns the
  contract-fidelity rows, including the Mongo injection seam this letter's X51-1 fix will touch the
  same package as.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                    | Source (file:line)                                                                                     | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 the probe reads the WRONG plane                           | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:509-524`                                  | The adapted transport's `isHealthy` calls `readNamespace.call(admin)` — the **administration** client — and classifies a failure with `classifyProbeFailure`. Nothing in that path touches the data plane.                                                                                                                                                                                                                                                                                                                                                                             |
| R2 a network-layer failure is `undefined`                    | `…/service-bus-broker.ts:269-284`                                                                      | `classifyProbeFailure` returns `undefined` for any error carrying no numeric `statusCode`. The emulator ships no TLS listener for administration, so the probe's failure has no status and lands here — by design, and that design is correct for what it was written for.                                                                                                                                                                                                                                                                                                             |
| R3 the fallback is `undefined` too                           | `…/service-bus-broker.ts:668-680`                                                                      | The broker builds its `createCachedProbe` with `fallback: undefined` (the V5-2 correction) and a 2 s bound, so a probe that times out ALSO resolves `undefined`.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| R4 `undefined` maps to `up`                                  | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:427-436`                                     | The indicator: `isReady()` false → `down`; `reachability()` `false` → `down`; `undefined` → **`up`** with `reachable: 'unknown'`; `true` → `up`. Self-consistent with the documented rule. The gap is that nothing else notices the data plane is gone.                                                                                                                                                                                                                                                                                                                                |
| R5 the stated safety net does not hold                       | `…/service-bus-broker.ts:539`, `:685`, `:705`, `:708-710`                                              | `isReady()` returns the private `#ready` flag, set `true` at the end of `connect()` and `false` only inside `disconnect()`. No liveness input reaches it, so it is `true` for a broker dead for minutes and answers in 0 ms. The claim that it gates the probe is false.                                                                                                                                                                                                                                                                                                               |
| R6 the false claim, verbatim, in source                      | `…/service-bus-broker.ts:262-264`                                                                      | "A namespace that is genuinely gone still reports `down`: the data client stops being ready, and the indicator checks `isReady()` before it ever consults this probe." Falsified by R5.                                                                                                                                                                                                                                                                                                                                                                                                |
| R7 the same claim in the release notes                       | `CHANGELOG.md:326-328`                                                                                 | "A namespace that is genuinely gone still reports `down` regardless: the data client stops being ready, and the indicator checks `isReady()` before it consults the probe." Same sentence, shipped in the `v0.6.0` notes.                                                                                                                                                                                                                                                                                                                                                              |
| R8 `HealthStatus` already admits `degraded`                  | `packages/common/src/types.ts:62`                                                                      | `type HealthStatus = 'up' \| 'down' \| 'degraded'`. A third status needs no `common` change — which is why §3.2 can be judged on its merits rather than on whether the contract allows it.                                                                                                                                                                                                                                                                                                                                                                                             |
| R9 the publish path can observe the plane                    | `…/service-bus-broker.ts:748-760`                                                                      | `publishWithHeaders` is the single funnel for every publish (`publish` delegates to it) and already throws on transport failure. It is the one place a data-plane outcome is known without issuing an extra round trip.                                                                                                                                                                                                                                                                                                                                                                |
| R10 the outage suite's shape                                 | `packages/messaging-plugin/test/integration/outage-real.test.ts:1-45`                                  | Drives a REAL backend through a real `docker stop`/`start` asserting `up → down → up`, guarded on the backend's env var, discovering the container by published port. It covers RabbitMQ and Redis and has **no Service Bus arm** — which is why this shipped.                                                                                                                                                                                                                                                                                                                         |
| R12 the TEST guard variable, which is NOT the deployment one | `packages/messaging-plugin/test/e2e/service-bus-emulator.test.ts:27`, `docs/messaging-emulators.md:75` | Both the existing suite and the documented emulator command read **`SERVICEBUS_CONNECTION_STRING`** (no underscore between SERVICE and BUS). The similar **`SERVICE_BUS_CONNECTION_STRING`** is a DIFFERENT variable — the CLI's generated transport wiring (`packages/cli/src/workspace/transport.ts:487`) and `docs/deployment.md:382` — read at runtime by a deployed member, never by a test guard. Using the deployment name as a test guard would make the suite skip under the documented command.                                                                              |
| R13 the retry escape hatch                                   | M90b `ServiceBusRetryOptions` (production arm only)                                                    | `maxRetries: 0` is the documented way to make a publish against an unreachable namespace fail promptly instead of consuming the SDK's default retry schedule. §3.3 needs it to keep the stopped-broker publish inside the test budget.                                                                                                                                                                                                                                                                                                                                                 |
| R14 the database probe is LIFECYCLE-only                     | `packages/database-plugin/src/services/database-service.ts:254`                                        | `isHealthy()` is `this._closed ? false : this._adapter.isReady()`. `isReady()` is the member inherited from `IOrmAdapter` — it reports that `connect()` once succeeded. No adapter performs I/O for it, which is why the indicator answers in `latencyMs: 0.36` for a database that is gone.                                                                                                                                                                                                                                                                                           |
| R15 the database indicator publishes no `reachable`          | `packages/database-plugin/src/plugin/database-plugin.ts:161-170`                                       | The indicator's `data` is `{ adapter, name, capacity? }` — no `reachable` member, alone among the seven ports carrying M90b's seam. Honest about what it does not know, while its `status` still says `up`.                                                                                                                                                                                                                                                                                                                                                                            |
| R16 `IDatabaseAdapter` has no reachability member            | `packages/database-plugin/src/interfaces/index.ts:244`                                                 | The port declares `isHealthy(): Promise<boolean>` on the SERVICE, not the adapter; no adapter-level `isHealthy?()` exists, so there is nothing for the service to delegate to. This is the surface §3.5 adds.                                                                                                                                                                                                                                                                                                                                                                          |
| R17 a liveness command is NOT universally available          | `packages/common/src/services/database.ts` (`IDatabaseAdapter`), and each adapter's `rawQuery`         | **Corrected during verification — the first draft of this row was wrong in two ways.** `IDatabaseAdapter` declares `rawQuery<T>(sql, params?)`, but **five of the seven adapters refuse it by name** (`mongo`, `memory`, `cosmos`, `bigtable`, `dynamo` all throw `UnsupportedRawQueryError`), so `SELECT 1` is not a universal probe. Only `prisma` (`$queryRawUnsafe`, `prisma-adapter.ts:350`) and `drizzle` (`drizzle-adapter.ts:422`) implement it — and drizzle refuses when the instance exposes no `execute()` (a SQLite-Proxy/libsql shape), so even there it is conditional. |
| R18 the Mongo facade exposes NO liveness call                | `packages/database-plugin/src/adapters/mongo/mongo-client-types.ts:246-253`                            | `IMongoDatabase` declares exactly one member: `collection(name): IMongoCollection`. There is **no `command()`**, so `db.command({ ping: 1 })` — which the first draft of R17 assumed — is unreachable through the committed seam. This is the M10 case the plan checklist names: a committed port lacking a surface the design needs. §3.5 resolves it rather than inheriting it.                                                                                                                                                                                                      |
| R19 the RabbitMQ probe is a FAULT FLAG                       | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:269-271`                                     | `isHealthy()` is `Promise.resolve(!this.#supervisor.faulted)`. A stopped container drops the connection and trips the supervisor; a **paused** one keeps the socket open, never faults, and the probe answers `reachable: true` in `latencyMs: 0.576` for a broker that will not complete an AMQP handshake.                                                                                                                                                                                                                                                                           |
| R20 the existing outage gate covers STOP only                | `packages/messaging-plugin/test/integration/outage-real.test.ts:3-4`                                   | Its own header: "drives a **real** broker through a **real** stop and restart, asserting the sequence `up → (stop) down → (restart) up`". The condition the RabbitMQ probe already handles. Nothing drives a hung backend anywhere in `packages/`.                                                                                                                                                                                                                                                                                                                                     |
| R11 the emulator's own caveats                               | `docs/messaging-emulators.md`                                                                          | The Service Bus emulator publishes AMQP on 5673 (5672 is RabbitMQ's), needs `UseDevelopmentEmulator=true` with the port in the endpoint, and is **not repeatable** — a second consecutive run against a persistent emulator fails, so the container is restarted between runs.                                                                                                                                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                                                                                  |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `service-bus-broker.ts:262-264` and `CHANGELOG.md:326-328` both claim `isReady()` gates the probe and therefore catches a namespace that is genuinely gone. R5 measures `isReady()` as a lifecycle flag with no liveness input. | The claim is struck, not softened. It is a statement about behaviour, and the behaviour is absent.                                                                       | Both sites rewritten to say what the gate actually is (lifecycle only), and to name what now catches a dead data plane (§3.2). The published `v0.6.0` section is corrected in place, with the correction also recorded under `Unreleased`. |
| C2 | `PUBLIC_API.md:4810-4816` describes the administration round trip as proving "the namespace is reachable", without distinguishing the management plane from the data plane — the distinction this row turns on.                 | The management round trip proves the **management** plane is reachable, which is evidence about the data plane rather than proof of it. The prose is scoped accordingly. | `PUBLIC_API.md` Health status section — the plane distinction, the data-plane evidence rule from §3.2, and the deployment posture that stays exposed (§8).                                                                                 |
| C3 | The messaging README (`:594-606`) and `PUBLIC_API.md` both present the status table as exhaustive while omitting what a repeatedly unreachable data plane reports.                                                              | The table gains the row §3.2 introduces, in both files, so the two cannot drift.                                                                                         | `packages/messaging-plugin/README.md` and `PUBLIC_API.md` status tables, regenerated together.                                                                                                                                             |

## 3. Design decisions

### 3.1 The false claim is corrected on its own, independently of §3.2

- **Decision:** the C1 correction is a separate commit landing first, touching only prose. It does
  not depend on §3.2 being approved.
- **Why:** R5 makes it measurably false today, and a reader relying on it believes a dead namespace
  is caught when it is not. That correction has no behavioural risk and no approval gate, so
  coupling it to a contract change would leave a known-false release claim standing while a design
  decision is discussed.
- **Test home:** `packages/messaging-plugin/test/unit/service-bus-reachability.test.ts` — a broker
  whose transport rejects with a status-less error reports `isReady() === true` AND
  `reachability() === undefined`, which is the two-line proof the JSDoc's claimed gate does not
  exist.

### 3.2 Reachability prefers recent DATA-plane evidence over the management probe

- **Decision:** the broker records the outcome of real data-plane operations in a small evidence
  window and `reachability()` consults it FIRST: a recent data-plane **success** resolves `true`, a
  recent data-plane **network-layer failure** resolves `false`, and with no recent evidence it falls
  through to today's management probe unchanged. The evidence predicate is its OWN function,
  narrowed twice, and it is deliberately NOT `classifyProbeFailure`: that one maps `404`/`410` to
  `false`, so a publish to a deleted topic would record an unreachable data plane, which §6(c)
  asserts must stay `undefined`. **Narrowed by origin** — only a rejection from `transport.send`
  counts. `publishWithHeaders` can throw before reaching the transport at all (the not-connected
  guard at `service-bus-broker.ts:752-757`, and the `serializer.serialize` call below it), and
  neither says anything about the network, so a serialization bug must never mark the broker down.
  **Narrowed by shape** — of those, only a rejection carrying no numeric `statusCode` is evidence,
  which is the network-layer signature R2 describes. A rejected topic, a quota error and a
  serialization failure therefore all leave the indicator untouched.
- **Why:** the stated gap is that the thing reported on is not the thing being used. This closes it
  by observing the plane the application already exercises (R9), at **zero extra round trips**, and
  it needs no new status value (R8 notwithstanding) because a data-plane failure resolves `false`,
  which the existing indicator already maps to `down` (R4). The two candidates the ROADMAP floats
  are both rejected with cause: **degrading on repeated probe failure** still reports on the
  management plane, so a firewalled management endpoint with a healthy data plane would be drained —
  reintroducing V5-2, the defect `v0.6.0` fixed; and **a cheap receiver open per probe** costs an
  AMQP link establishment every TTL against a service billed per operation, to learn something a
  real publish already knows. Falling back to the management probe when the broker is idle keeps the
  change strictly additive: a deployment that publishes nothing behaves exactly as it does today.
- **Approval gate:** this changes a published health contract, so it ships only with the
  maintainer's explicit §10.2 sign-off recorded in the ROADMAP section, exactly as M74 recorded its
  three additions. The ROADMAP frames this row as "a design decision for the maintainer, not a
  prescribed fix"; this plan makes the recommendation concrete so the decision is a yes or a no
  rather than an open question, and the plan is fixed as a plan if the answer differs.
- **Test home:** `service-bus-reachability.test.ts` for the window's arms, and the §3.3
  real-emulator 2×2 for the end-to-end claim.

### 3.3 The gate is the 2×2 against a real emulator, not a unit assertion

- **Decision:** a guarded `test/integration/service-bus-outage-real.test.ts` drives the real
  emulator through a real stop and restart and asserts the **`0.6.0` row** of the table in §0 — `up`
  while running, `down` while stopped, `up` again after restart — plus the assertion that the
  running and stopped answers DIFFER. It does not assert the `0.5.0` row and cannot: those two cells
  are a historical measurement of a shipped release, not something a suite running against this
  implementation can execute. **Each health assertion is preceded by a real publish** that populates
  the window §3.2 reads: a successful publish before the first `up`, a publish against the stopped
  emulator (awaited to its rejection) before the `down`, and another successful publish after
  restart before the recovery `up`. The broker under test is constructed with
  `retryOptions: { maxRetries: 0 }` (R13) so the stopped publish fails inside the test budget.
- **Why:** the defect is precisely that the indicator returns the same answer in both states, so any
  gate asserting one state passes vacuously. Asserting the DIFFERENCE is what discriminates, and it
  is what neither `0.5.0` nor `0.6.0` had. R10 shows the existing outage suite already has the
  container-stop machinery and simply has no Service Bus arm. **The publishes are load-bearing
  rather than setup**, and omitting them is the one way this gate could be written and still be
  unable to pass: against this emulator the management probe resolves `undefined` whether the
  container is running or stopped (R2/R3), so with an empty window every cell falls through to it
  and reports `up`. A poll-only version of this suite therefore fails its own `down` assertion —
  which is the honest signal, but it would read as the FIX being wrong rather than the test, so the
  sequence is specified here instead of being discovered at implementation time. It is also what
  makes the suite match the deployment §8 names: the window carries a signal only for a broker that
  is actually being used.
- **Test home:** the new suite, guarded on `SERVICEBUS_CONNECTION_STRING` with the `ignore:` form
  rather than an early return — the M70c trap, where a suite reports _passed_ while asserting
  nothing.

### 3.4 The suite is local-only, and `test/apps-gate.test.ts` records why

- **Decision:** the new suite is not added to CI's service containers. It is documented in
  `docs/messaging-emulators.md` beside the existing Service Bus instructions, and
  `test/apps-gate.test.ts` gains an assertion naming it as deliberately local.
- **Why:** R11 — the emulator is not repeatable against a persistent container, so a CI job would
  need a restart between runs, and the image is large. The Cosmos suite (M81) is local-only for the
  same reason and set the precedent. What keeps a local-only suite honest is that its absence from
  CI is asserted rather than implicit, so a later reader does not mistake it for an oversight.
- **Test home:** `test/apps-gate.test.ts`.

### 3.5 The fix for the High is the MAPPING; the per-adapter probe is what the facade already admits

> **This decision was rewritten during plan verification.** Its first draft assumed every adapter
> had a cheap liveness command (`db.command({ ping: 1 })`, `SELECT 1`) and that `unknown` would be a
> rare fallback. R17 and R18 falsify both: five of seven adapters refuse `rawQuery` by name, and the
> committed `IMongoDatabase` facade has no `command()` at all. The design below is what survives the
> source.

**Separate the two things the first draft conflated.** X51-1 is not "the database never pings" — it
is "**the indicator says `up` for a backend it cannot vouch for**, so `/ready` answers 200 and the
pod keeps taking traffic". Those have different fixes, and only the first one is the High:

1. **The mapping** — an adapter that cannot answer must never produce `up`. This alone closes the
   finding, on every adapter, with no client facade widened.
2. **The probe** — an adapter that CAN answer should say so, which upgrades `degraded` to `up`.

**`IDatabaseAdapter` lives in `packages/common/src/services/database.ts:367`, not in
`database-plugin`** — M52c promoted it, and `database-plugin/src/interfaces/index.ts` only imports
it (`:9`). Corrected after review (PR #309, finding 8): the first draft's implementation table named
the importing file, so following the plan literally would have left the contract every adapter
implements unchanged. **This letter therefore carries a `common` change**, and the package list in
§0 and the ROADMAP umbrella say so.

`IDatabaseAdapter` gains an OPTIONAL `isHealthy?(): Promise<boolean>` there (the `fs?`/`workers?`/
`dns?` precedent, so no out-of-repo adapter breaks). **The indicator needs two reads, not one, and
the first draft's single boolean could not carry both** (PR #309, finding 3): `Promise<boolean>`
cannot distinguish "this adapter has no probe" from "the probe did not answer in time", which the
table below maps to different statuses. So `DatabaseService` exposes:

- `hasReachabilityProbe: boolean` — a synchronous read of `typeof adapter.isHealthy === 'function'`,
  which is the only way absence is observable at all once the call is wrapped.
- `reachability(): Promise<boolean | undefined>` — the bounded probe, `undefined` on timeout. This
  mirrors `IMessageBroker.reachability()` exactly (M70c's tri-state), so the two capabilities report
  through one shape rather than two.

`DatabaseService.isHealthy()` keeps its lifecycle gate and its published `Promise<boolean>`
signature unchanged; `reachability()` is the new member the indicator reads. The indicator publishes
`reachable`:

| adapter probe  | `reachable` | `status`   |
| -------------- | ----------- | ---------- |
| resolves true  | `true`      | `up`       |
| resolves false | `false`     | `down`     |
| times out      | `'unknown'` | `degraded` |
| member absent  | `'unknown'` | `degraded` |

**`degraded` rather than `up` for an unanswerable probe is the load-bearing line**, and it needs no
`common` change — `HealthStatus` already admits it (R8). It is the narrowest change that fixes the
finding, because `up` is the claim that put a dead-database pod back in rotation.

#### The mapping applies where a probe EXISTS; absent keeps today's behaviour

> **Corrected a second time during verification, and this is the correction that mattered.** The
> draft above mapped a missing probe to `degraded`. `health-plugin.ts:214` computes readiness as
> `report.status === 'up' ? 200 : 503` — **`degraded` already answers 503**. So that mapping would
> have taken **every** Mongo, Cosmos, Bigtable and DynamoDB application out of rotation on upgrade:
> a guaranteed outage for healthy applications, which is strictly worse than the finding. The plan
> instruction to check the aggregation before deciding is what caught it.

| adapter probe            | `reachable` | `status`   | `/ready` |
| ------------------------ | ----------- | ---------- | -------- |
| resolves true            | `true`      | `up`       | 200      |
| resolves false           | `false`     | `down`     | 503      |
| times out (probe EXISTS) | `'unknown'` | `degraded` | 503      |
| member absent            | omitted     | `up`       | 200      |

**A timeout is `degraded` and a missing member is not**, and that distinction is the whole decision.
A probe that exists and did not answer is evidence of trouble; a probe that was never written is
evidence of nothing, and must be reported as neither health nor failure.

| adapter    | `isHealthy?()`                       | Why                                                                                                                                                                        |
| ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mongo`    | `db.command({ ping: 1 })`            | **X51-1's own reproduction — it must be fixed here or the letter closes nothing.** Needs one optional `command?()` on `IMongoDatabase` (R18); see below.                   |
| `prisma`   | `rawQuery('SELECT 1')`               | `$queryRawUnsafe` (`prisma-adapter.ts:350`) — verified present.                                                                                                            |
| `drizzle`  | `rawQuery('SELECT 1')`, else OMITTED | Works through `execute()`; a SQLite-Proxy/libsql instance has none and already refuses `rawQuery` (`drizzle-adapter.ts:426-435`), so the member is omitted for that shape. |
| `memory`   | resolves `true`                      | The process IS the backend. Honest, not a special case.                                                                                                                    |
| `cosmos`   | omitted — behaviour UNCHANGED        | Refuses `rawQuery`; its client facade's liveness surface is unverified and this letter does not widen it.                                                                  |
| `bigtable` | omitted — behaviour UNCHANGED        | As above.                                                                                                                                                                  |
| `dynamo`   | omitted — behaviour UNCHANGED        | As above.                                                                                                                                                                  |

**`IMongoDatabase` gains an optional `command?(spec): Promise<unknown>`.** R18 established the
facade has only `collection(name)`, so there is no way to reach a ping without it; it is OPTIONAL,
so an injected double that omits it simply has no probe and lands in the last row. **This edits
`mongo-client-types.ts`, which M95c also edits** (`IMongoClient.connect` → `Promise<unknown>`) — the
two letters must rebase rather than merge blind, and §0 records it.

**What stays exposed, stated plainly rather than buried:** a Cosmos, Bigtable or DynamoDB
application keeps reporting `up` for an unreachable backend after this letter. That is the status
quo rather than a regression, and it is preferred to the alternative — a mapping that fails
readiness for every one of them on upgrade. Each needs one optional member on its own client facade,
which is a follow-on this letter names rather than performs.

### 3.6 The RabbitMQ probe opens its OWN channel, and the indicator bounds it

> **Redesigned after review (PR #309, findings 1 and 2). The first draft was unimplementable**, and
> both halves were falsified by source this plan should have read:
>
> - It said `checkQueue` on "a queue the broker declared at connect". **`connect()` declares no
>   queue** — it is `resolveClient` → `#createChannel` → `#reassertExchange`
>   (`rabbitmq-broker.ts:189-199`), an EXCHANGE only, and a producer-only application never declares
>   one. Worse, a passive declare against a missing queue raises an AMQP **channel exception**,
>   which closes the channel — and `#channel` is the single shared channel every `publish` and every
>   subscription uses. Running the health check would have disabled the broker it was reporting on.
> - It said the round trip runs "inside the bound the probe already has". **There is no bound.** The
>   indicator does `const reachable = await broker.reachability()` (`messaging-plugin.ts:427`) — a
>   direct await, no `createCachedProbe`. Service Bus builds its own internally; RabbitMQ's
>   `reachability()` (`:258`) just reads the flag, so it never needed one. An unbounded round trip
>   there means a paused broker hangs `/health` and `/ready` indefinitely, which is worse than the
>   `up` it currently reports.

**The probe opens a throwaway channel and closes it.** `connection.createChannel()` is a real round
trip that a paused broker cannot answer and a stopped one fails immediately; it needs no queue, no
exchange and no permissions beyond those the broker already holds; and because the channel is its
own, a failure cannot touch `#channel`. The probe closes it in a `finally` — a leaked channel per
poll would be its own defect.

```
isHealthy():
  if (this.#supervisor.faulted) return false      // short-circuit, no round trip
  if (this.#connection === null) return false
  ch = await this.#connection.createChannel()     // the round trip
  try { return true } finally { await ch.close() }
  // on throw: return false
```

**The bound is added at the indicator, not inside the broker**, because that is where every other
probe in this letter is bounded and where the finding's blast radius sits. `messaging-plugin.ts`
wraps `broker.reachability()` in the same `createCachedProbe` (5 s TTL, 2 s bound) the Service Bus
broker builds internally, with `fallback: undefined` → `reachable: 'unknown'`. **This changes
behaviour for all seven broker arms**, so it is stated as such rather than slipped in under the
RabbitMQ row: a probe that exceeds the bound now reports `'unknown'` instead of hanging the
endpoint. No arm's success or failure mapping changes.

**No facade widening is needed** — `IAmqpConnection` already declares
`createChannel(): Promise<unknown>` (`messaging-plugin/src/interfaces/index.ts:66`), verified rather
than assumed. The returned channel is `unknown`, so the probe closes it through a narrow structural
check (`{ close(): Promise<void> }`) rather than a cast.

## 4. Exported surface — every symbol names its consumer

**No change to `packages/messaging-plugin/src/index.ts`.** This milestone ships a corrected signal
and corrected prose, not an API. Pinned by the package's existing barrel-exports assertion (the M56
defect class).

| Exported symbol      | Kind | Consumer / real code path that READS it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (no NEW symbol) | —    | No symbol is added to the barrel. The evidence window is private state on `ServiceBusBroker`, read only by its own `reachability()`. **The published surface still changes, though**: `src/index.ts:49` exports `ServiceBusBroker` and `:122` exports `ServiceBusOptions`, so §4.1's new option is a public contract change even with the barrel untouched. It gets a `PUBLIC_API.md` entry naming its default, and a compile-time assertion declared against the barrel in the package's `barrel-exports` test — the M70m lesson that a type pinned by nothing can be dropped with the whole suite still green. |

### 4.1 Options — every option names its consumer

| Option                                | Consumer                          | Behavior (per implementation)                                                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlaneEvidenceMs` (new, optional) | `ServiceBusBroker.reachability()` | How long a recorded data-plane outcome stays authoritative. Default chosen to match the existing 5 s probe TTL so the two signals age together. Below that age the window answers; above it, the management probe answers exactly as it does today. |

The option is added ONLY if §3.2 is approved, and it is added as a `ServiceBusBroker` option rather
than a plugin-wide one, because no other broker has two planes to choose between. No other option is
introduced: a switch to disable the window would be a way to ask for the defect back.

## 5. Implementation files

| File                                                          | Purpose                                                                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/index.ts`                      | Unchanged — no barrel export moves (§4).                                                                                                                    |
| `packages/common/src/services/database.ts`                    | §3.5 — the optional `isHealthy?()` member on `IDatabaseAdapter`, which is declared HERE (`:367`), not in `database-plugin` (X51-1).                         |
| `packages/database-plugin/src/services/database-service.ts`   | §3.5 — the new `hasReachabilityProbe` read and the bounded `reachability()`; `isHealthy()`'s published signature is unchanged.                              |
| `packages/database-plugin/src/plugin/database-plugin.ts`      | §3.5 — the indicator publishes `reachable` from the bounded probe; `up` is never the answer for an unanswerable one.                                        |
| `packages/database-plugin/src/adapters/**`                    | §3.5 — a per-adapter `isHealthy?()` using the cheap command R17 names; omitted where an injected client cannot answer.                                      |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`    | §3.6 — a throwaway-channel round trip replacing the fault-flag read, with the flag kept as a short-circuit (X51-2).                                         |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`    | §3.6 — the indicator wraps `broker.reachability()` in `createCachedProbe`; today it awaits directly (`:427`) and nothing bounds it. Affects all seven arms. |
| `packages/database-plugin/README.md`                          | The `database` health payload gains `reachable`; state what `unknown` means.                                                                                |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts` | C1 JSDoc correction (§3.1); the data-plane evidence window and its use in `reachability()` (§3.2); the recording call in `publishWithHeaders` (R9).         |
| `packages/messaging-plugin/README.md`                         | C3 status table and the plane distinction.                                                                                                                  |
| `PUBLIC_API.md`                                               | C2 plane distinction, C3 status table, and the exposed posture from §8.                                                                                     |
| `CHANGELOG.md`                                                | C1 correction of the published `v0.6.0` entry, plus an `Unreleased` entry recording both the correction and the behaviour change.                           |
| `docs/messaging-emulators.md`                                 | How to run the §3.3 suite locally, beside the existing Service Bus instructions.                                                                            |
| `PUBLIC_API.md` (Messaging health + options)                  | §4.1's `dataPlaneEvidenceMs` and its default — reachable through the exported `ServiceBusOptions`.                                                          |
| `ROADMAP.md`                                                  | The §3.2 approval record, and the M95b status flip in this same PR.                                                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                          | src covered                                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/test/unit/service-bus-reachability.test.ts` (new)       | `brokers/service-bus-broker.ts`                             | Against an injected `IServiceBusTransport`: (a) the C1 proof — a status-less probe failure leaves `isReady()` `true` and `reachability()` `undefined`; (b) a recorded publish failure with no `statusCode` makes `reachability()` resolve `false` while the management probe still resolves `undefined`; (c) a publish failure WITH a `statusCode` leaves it `undefined`; (d) a successful publish resolves `true`; (e) past the window, the management probe answers again. All calls type-check against `reachability(): Promise<boolean \| undefined>` (R3) and `publishWithHeaders<T>(topic, message, headers)` (R9).                                                                                                                                                              |
| `packages/messaging-plugin/test/unit/messaging-plugin-health.test.ts` (extended)   | `plugin/messaging-plugin.ts`                                | (a) The indicator maps the new `false` to `down` with `reachable: false` through the EXISTING mapping (R4) — asserting the mapping is untouched, so §3.2 adds evidence rather than a second code path. (b) **The bound is asserted, not assumed** (finding 2): a `reachability()` that NEVER settles resolves `reachable: 'unknown'` and the indicator's promise SETTLES, driven through a fake `IRuntimeServices` whose `setTimeout` fires on command via `resolveProbeTiming`, so the assertion is deterministic rather than wall-clock. Reverting the `createCachedProbe` wrapper leaves this case pending forever, which is the finding's own reproduction. (c) Two polls inside the TTL issue ONE probe call, so the wrapper does not multiply round trips across the seven arms. |
| `packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts` (new) | the broker end to end, real emulator                        | The §0 table's `0.6.0` row — the three states this implementation can be driven through — plus the discriminating assertion that the running and stopped answers DIFFER. Each cell is preceded by the publish §3.2 reads — success, then a rejected publish against the stopped emulator, then success again — with `retryOptions: { maxRetries: 0 }` (R13); a poll-only variant cannot pass, per §3.3. Guarded with `ignore:` on `SERVICEBUS_CONNECTION_STRING` (§3.3); container restarted between runs per R11.                                                                                                                                                                                                                                                                     |
| `packages/database-plugin/test/unit/adapter-reachability.test.ts` (new)            | `services/database-service.ts`, `plugin/database-plugin.ts` | Against an injected adapter: (a) a probe resolving `true` → `reachable: true` / `up`; (b) resolving `false` → `down`; (c) a probe that EXISTS and never settles → `degraded` and `/ready` 503 inside the 2 s bound; (d) an adapter with NO `isHealthy?()` → `up`, `reachable` OMITTED, `/ready` 200 — the deliberate no-change row, asserted so a later edit cannot silently fail every probe-less adapter's readiness; (e) a Mongo adapter whose `IMongoDatabase` omits `command?()` lands in (d) rather than throwing; (f) the lifecycle gate still wins after `close()`. Type-checks against `isHealthy?(): Promise<boolean>` (§3.5, R16).                                                                                                                                          |
| `packages/database-plugin/test/integration/outage-real.test.ts` (new)              | the adapter end to end, real MongoDB                        | The X51-1 reproduction as a gate: `up` with the container running; after `docker stop`, **`/ready` must answer 503 and the indicator must not say `up`**; after `docker start`, `up` again. Guarded on `MONGODB_URL`, container discovered by published port, mirroring the messaging suite's shape (R10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/messaging-plugin/test/integration/outage-real.test.ts` (extended)        | `brokers/rabbitmq-broker.ts`                                | A **hung** arm beside the existing stop arm: `docker pause` → the indicator must not answer `up`, **and must answer at all within the bound** — the elapsed time of the `/health` request is asserted under a ceiling well below the suite's own timeout, since "not `up`" alone passes for a request that never returns (finding 2); `docker unpause` → `up`. Plus the §3.6 shared-channel guard: after N health polls against the RUNNING broker, a publish and a subscription still round-trip, which fails if the probe ever touches `#channel` or leaks one channel per poll. This is the condition R20 shows nothing in `packages/` drives today, and it is the gate for §3.6.                                                                                                   |
| `test/apps-gate.test.ts` (extended)                                                | CI wiring                                                   | Pins that the new suite is deliberately local-only and names the doc that says how to run it (§3.4), so its absence from CI is a recorded decision rather than a silent gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Coverage.** `service-bus-broker.ts` is the only `src` file with new branches, and every arm of the
evidence window is reachable through the injected transport, so the unit table above takes it to the
per-file bar without relying on the guarded suite.

**Negative controls** (each observed failing, then reverted, and the result recorded in the PR):

1. Revert the §3.2 window → the real-emulator 2×2 fails on the broker-DOWN cell with `up`/200,
   reproducing the finding exactly.
2. Widen the evidence rule to count ANY publish rejection → the status-carrying-failure unit case
   fails, proving the narrow rule is load-bearing rather than decorative.
3. Delete the window's expiry so evidence never ages out → the fall-through case fails, proving an
   idle broker still reaches the management probe.
4. Remove `MongoAdapter.isHealthy?()` → the real-Mongo outage gate fails with `up`/200 against a
   stopped container, reproducing X51-1 exactly. This is the control proving the letter closes its
   own High rather than only adding a mapping. 4b. Map a MISSING probe to `degraded` instead of `up`
   → the unit case (d) fails and, more usefully, a Cosmos/Bigtable/Dynamo application's `/ready`
   drops to 503 with every backend healthy. That is the outage the §3.5 correction exists to avoid,
   and it is observed once so the reasoning is evidence rather than assertion.
5. Revert §3.6's round trip to the fault-flag read → the new hung arm fails while the existing
   stopped arm still passes, which is the precise shape of X51-2 and proves the new arm
   discriminates rather than merely duplicating the old one.
6. Restore the struck `isReady()` sentence → no test fails, which is the honest result and the
   reason C1 needs the (a) unit proof rather than a prose review.
7. Drop the three publishes from the real-emulator suite, leaving it polling `/health` alone → the
   broker-DOWN cell reports `up` and fails, proving the publishes are load-bearing rather than setup
   (§3.3) and that the window, not the management probe, is what carries the signal here.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m95b-service-bus-reachability, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # README / PUBLIC_API / CHANGELOG edits
deno task publish:check     # committed tree
deno task release:verify 0.6.0
```

Plus, locally, with the emulator running per `docs/messaging-emulators.md`:

```bash
deno test -A packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts
```

## 8. Risks & mitigations

- **A deployment whose management plane is unreachable but whose data plane is used stays exposed
  until it publishes.** This is the exact posture the V5-2 fix was written for — a firewalled
  management endpoint is an ordinary production stance. Mitigation: the window closes it on the
  first real publish, and the residual gap (an idle broker with an unreachable management plane) is
  stated in `PUBLIC_API.md` rather than implied, so an operator can choose a synthetic publish. It
  is not silently narrowed.
- **Against real Azure the management endpoint answers, so this row may look theoretical.** Stated,
  not hidden: the emulator is where it was measured, and the scope caveat goes in the docs verbatim.
  The evidence window is an improvement in both environments because it reports on the used plane.
- **The emulator is not repeatable (R11), so the new suite can fail for reasons unrelated to the
  change.** Mitigation: the suite restarts the container itself rather than assuming a clean one,
  and it is local-only (§3.4) so a flake cannot redden CI.
- **§3.2 may not be approved.** Mitigation: §3.1 is independent and lands regardless, so the
  measurably false claim is corrected regardless of the outcome. If the recommendation is declined,
  the plan is fixed as a plan before implementation rather than during it.

## 9. Out of scope

- **The other six broker arms.** Their probes read the plane they report on, and `up → down → up` is
  already pinned for RabbitMQ and Redis by the existing outage suite (R10).
- **A `degraded` status for messaging.** R8 shows the union allows it; §3.2 shows it is not needed,
  because a data-plane failure is a `false`, which already maps to `down`. Recorded so its absence
  reads as a decision.
- **Changing `isReady()` into a liveness signal.** It is a released lifecycle member with that
  documented meaning elsewhere in the framework; redefining it would change every broker's indicator
  and several plugins that read it. The fix is to stop CLAIMING it is liveness, not to make it so.
- **A synthetic keep-alive publish.** It would make the window always fresh at the cost of traffic
  the application did not ask for, and it is an operator's choice rather than a framework default.
- **M95a** (the generated deployment that cannot start) and **M95c** (three contract-fidelity rows)
  — separate letters, separate branches.
