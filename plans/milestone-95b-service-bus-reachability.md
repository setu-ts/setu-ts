# Milestone 95b — Messaging (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m95b-service-bus-reachability`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

With the Azure Service Bus broker **stopped** — TCP refused — `/health` reports `up` and `/ready`
answers `200`, while every `publish` throws. The indicator fails **open**: a replica that cannot
reach its broker stays in rotation, takes traffic, and drops every message it is handed.

Measured as a 2×2 against the emulator `docs/messaging-emulators.md` documents:

|         | broker UP    | broker DOWN  |
| ------- | ------------ | ------------ |
| `0.5.0` | `down` / 503 | `down` / 503 |
| `0.6.0` | `up` / 200   | `up` / 200   |

The indicator discriminates in **neither** version against this emulator. `0.5.0` always said
`down`; `0.6.0` always says `up`. The `v0.6.0` fix for V5-2 was correct for the live case and traded
a false `down` for a false `up`. This milestone makes the indicator report on the plane the
application actually uses, and corrects a release claim that is measurably false.

- **In scope:** `ServiceBusBroker`'s reachability signal; the false `isReady()` safety-net claim in
  its JSDoc, the `v0.6.0` CHANGELOG entry and `PUBLIC_API.md`; a guarded real-emulator 2×2 that
  fails if the indicator stops discriminating in a future release.
- **NOT this milestone:** the other six broker arms, whose probes read the plane they report on and
  whose `up → down → up` behaviour is already pinned by `test/integration/outage-real.test.ts` (M70c
  §3.7). Nothing in `common` changes and no capability token is added. M95a owns the
  generated-deployment crash; M95c owns the three contract-fidelity rows.

## 1. Contracts verified from SOURCE (not names)

| Reference                                                    | Source (file:line)                                                                                     | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 the probe reads the WRONG plane                           | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:509-524`                                  | The adapted transport's `isHealthy` calls `readNamespace.call(admin)` — the **administration** client — and classifies a failure with `classifyProbeFailure`. Nothing in that path touches the data plane.                                                                                                                                                                                                                                                   |
| R2 a network-layer failure is `undefined`                    | `…/service-bus-broker.ts:269-284`                                                                      | `classifyProbeFailure` returns `undefined` for any error carrying no numeric `statusCode`. The emulator ships no TLS listener for administration, so the probe's failure has no status and lands here — by design, and that design is correct for what it was written for.                                                                                                                                                                                   |
| R3 the fallback is `undefined` too                           | `…/service-bus-broker.ts:668-680`                                                                      | The broker builds its `createCachedProbe` with `fallback: undefined` (the V5-2 correction) and a 2 s bound, so a probe that times out ALSO resolves `undefined`.                                                                                                                                                                                                                                                                                             |
| R4 `undefined` maps to `up`                                  | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:427-436`                                     | The indicator: `isReady()` false → `down`; `reachability()` `false` → `down`; `undefined` → **`up`** with `reachable: 'unknown'`; `true` → `up`. Self-consistent with the documented rule. The gap is that nothing else notices the data plane is gone.                                                                                                                                                                                                      |
| R5 the stated safety net does not hold                       | `…/service-bus-broker.ts:539`, `:685`, `:705`, `:708-710`                                              | `isReady()` returns the private `#ready` flag, set `true` at the end of `connect()` and `false` only inside `disconnect()`. No liveness input reaches it, so it is `true` for a broker dead for minutes and answers in 0 ms. The claim that it gates the probe is false.                                                                                                                                                                                     |
| R6 the false claim, verbatim, in source                      | `…/service-bus-broker.ts:262-264`                                                                      | "A namespace that is genuinely gone still reports `down`: the data client stops being ready, and the indicator checks `isReady()` before it ever consults this probe." Falsified by R5.                                                                                                                                                                                                                                                                      |
| R7 the same claim in the release notes                       | `CHANGELOG.md:326-328`                                                                                 | "A namespace that is genuinely gone still reports `down` regardless: the data client stops being ready, and the indicator checks `isReady()` before it consults the probe." Same sentence, shipped in the `v0.6.0` notes.                                                                                                                                                                                                                                    |
| R8 `HealthStatus` already admits `degraded`                  | `packages/common/src/types.ts:62`                                                                      | `type HealthStatus = 'up' \| 'down' \| 'degraded'`. A third status needs no `common` change — which is why §3.2 can be judged on its merits rather than on whether the contract allows it.                                                                                                                                                                                                                                                                   |
| R9 the publish path can observe the plane                    | `…/service-bus-broker.ts:748-760`                                                                      | `publishWithHeaders` is the single funnel for every publish (`publish` delegates to it) and already throws on transport failure. It is the one place a data-plane outcome is known without issuing an extra round trip.                                                                                                                                                                                                                                      |
| R10 the outage suite's shape                                 | `packages/messaging-plugin/test/integration/outage-real.test.ts:1-45`                                  | Drives a REAL backend through a real `docker stop`/`start` asserting `up → down → up`, guarded on the backend's env var, discovering the container by published port. It covers RabbitMQ and Redis and has **no Service Bus arm** — which is why this shipped.                                                                                                                                                                                               |
| R12 the TEST guard variable, which is NOT the deployment one | `packages/messaging-plugin/test/e2e/service-bus-emulator.test.ts:27`, `docs/messaging-emulators.md:75` | Both the existing suite and the documented emulator command read **`SERVICEBUS_CONNECTION_STRING`**. The similar `SERVICEBUS_CONNECTION_STRING` is a DIFFERENT variable — the CLI's generated transport wiring (`packages/cli/src/workspace/transport.ts:487`) and `docs/deployment.md:382` — read at runtime by a deployed member, never by a test guard. Using the deployment name as a test guard would make the suite skip under the documented command. |
| R13 the retry escape hatch                                   | M90b `ServiceBusRetryOptions` (production arm only)                                                    | `maxRetries: 0` is the documented way to make a publish against an unreachable namespace fail promptly instead of consuming the SDK's default retry schedule. §3.3 needs it to keep the stopped-broker publish inside the test budget.                                                                                                                                                                                                                       |
| R11 the emulator's own caveats                               | `docs/messaging-emulators.md`                                                                          | The Service Bus emulator publishes AMQP on 5673 (5672 is RabbitMQ's), needs `UseDevelopmentEmulator=true` with the port in the endpoint, and is **not repeatable** — a second consecutive run against a persistent emulator fails, so the container is restarted between runs.                                                                                                                                                                               |

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
  through to today's management probe unchanged. Only failures carrying no `statusCode` count as
  evidence of unreachability — the same test `classifyProbeFailure` already applies (R2) — so a
  rejected topic, a quota error or a serialization failure never moves the indicator.
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
  emulator through a real stop and restart and asserts all four cells of the table in §0: `up` while
  running, `down` while stopped, `up` again after restart, and — the cell that failed in both
  releases — that the two differ. **Each health assertion is preceded by a real publish** that
  populates the window §3.2 reads: a successful publish before the first `up`, a publish against the
  stopped emulator (awaited to its rejection) before the `down`, and another successful publish
  after restart before the recovery `up`. The broker under test is constructed with
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

## 4. Exported surface — every symbol names its consumer

**No change to `packages/messaging-plugin/src/index.ts`.** This milestone ships a corrected signal
and corrected prose, not an API. Pinned by the package's existing barrel-exports assertion (the M56
defect class).

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                              |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| None            | —    | No symbol is added to the barrel. The evidence window is private state on `ServiceBusBroker`, read only by its own `reachability()`. |

### 4.1 Options — every option names its consumer

| Option                                | Consumer                          | Behavior (per implementation)                                                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPlaneEvidenceMs` (new, optional) | `ServiceBusBroker.reachability()` | How long a recorded data-plane outcome stays authoritative. Default chosen to match the existing 5 s probe TTL so the two signals age together. Below that age the window answers; above it, the management probe answers exactly as it does today. |

The option is added ONLY if §3.2 is approved, and it is added as a `ServiceBusBroker` option rather
than a plugin-wide one, because no other broker has two planes to choose between. No other option is
introduced: a switch to disable the window would be a way to ask for the defect back.

## 5. Implementation files

| File                                                          | Purpose                                                                                                                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/index.ts`                      | Unchanged — no barrel export moves (§4).                                                                                                            |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts` | C1 JSDoc correction (§3.1); the data-plane evidence window and its use in `reachability()` (§3.2); the recording call in `publishWithHeaders` (R9). |
| `packages/messaging-plugin/README.md`                         | C3 status table and the plane distinction.                                                                                                          |
| `PUBLIC_API.md`                                               | C2 plane distinction, C3 status table, and the exposed posture from §8.                                                                             |
| `CHANGELOG.md`                                                | C1 correction of the published `v0.6.0` entry, plus an `Unreleased` entry recording both the correction and the behaviour change.                   |
| `docs/messaging-emulators.md`                                 | How to run the §3.3 suite locally, beside the existing Service Bus instructions.                                                                    |
| `ROADMAP.md`                                                  | The §3.2 approval record, and the M95b status flip in this same PR.                                                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                          | src covered                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/test/unit/service-bus-reachability.test.ts` (new)       | `brokers/service-bus-broker.ts`      | Against an injected `IServiceBusTransport`: (a) the C1 proof — a status-less probe failure leaves `isReady()` `true` and `reachability()` `undefined`; (b) a recorded publish failure with no `statusCode` makes `reachability()` resolve `false` while the management probe still resolves `undefined`; (c) a publish failure WITH a `statusCode` leaves it `undefined`; (d) a successful publish resolves `true`; (e) past the window, the management probe answers again. All calls type-check against `reachability(): Promise<boolean \| undefined>` (R3) and `publishWithHeaders<T>(topic, message, headers)` (R9). |
| `packages/messaging-plugin/test/unit/messaging-plugin-health.test.ts` (extended)   | `plugin/messaging-plugin.ts`         | The indicator maps the new `false` to `down` with `reachable: false` through the EXISTING mapping (R4) — asserting the mapping is untouched, so §3.2 adds evidence rather than a second code path.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/messaging-plugin/test/integration/service-bus-outage-real.test.ts` (new) | the broker end to end, real emulator | The §0 2×2, all four cells, plus the discriminating assertion that the running and stopped answers DIFFER. Each cell is preceded by the publish §3.2 reads — success, then a rejected publish against the stopped emulator, then success again — with `retryOptions: { maxRetries: 0 }` (R13); a poll-only variant cannot pass, per §3.3. Guarded with `ignore:` on `SERVICEBUS_CONNECTION_STRING` (§3.3); container restarted between runs per R11.                                                                                                                                                                      |
| `test/apps-gate.test.ts` (extended)                                                | CI wiring                            | Pins that the new suite is deliberately local-only and names the doc that says how to run it (§3.4), so its absence from CI is a recorded decision rather than a silent gap.                                                                                                                                                                                                                                                                                                                                                                                                                                              |

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
4. Restore the struck `isReady()` sentence → no test fails, which is the honest result and the
   reason C1 needs the (a) unit proof rather than a prose review.
5. Drop the three publishes from the real-emulator suite, leaving it polling `/health` alone → the
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
