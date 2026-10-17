# Milestone 113j — Outbox and Inbox Signals (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `fix/m113j-outbox-inbox-signals` (a **fix** letter — ROADMAP
> "Milestone 113" table — so a `fix/…` branch, not `feat/…`). `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Three findings from the `v0.9.0` smoke run (X67, `smoke/X67-X73-FINDINGS.md` step 7 and "Other
observations"), one shape: the outbox and inbox tell an operator something other than what happened.
A relay paused past its lease republishes a row another relay already sent, and the documented
`duplicate` overlap never fires — the late `markSent` answer is booked as a store failure (V9-20).
An operator route releasing an inbox row that is not parked answers a masked `500`, the M89b class
(V9-21). And the messaging README teaches an `npm:` import that Node refuses and contradicts itself
about whether the purge deletes parked markers (V9-22).

- **In scope:**
  - **V9-20** — after a publish was actually invoked, `markSent` and `markFailure` report their
    outcome even when they answer after their bound or after the sweep deadline, and are issued even
    when a pause has exhausted the sweep budget. A `markFailure` for a publish the budget refused to
    invoke is still never written (§3.1). A relay paused inside its publish, whose `markFailure`
    then finds the row sent, reports `duplicate` too (§3.2).
  - **V9-21** — the operator `release` refusals carry HTTP status hints: `InboxRowStateError`, its
    sibling `OutboxRowStateError`, and the outbox's missing-id `TypeError`, which becomes an
    `OutboxRowStateError('invalid-id')` (one rule, §3.4).
  - **V9-22** — the README's outbox Drizzle mapping imports the bare `drizzle-orm/pg-core`; the
    custom-inbox-store contract stops claiming `purge` never deletes a parked marker.
  - **V9-22 widened (maintainer decision, 2026-10-17)** — every stale `npm:` specifier in committed,
    non-history Markdown is corrected, not only messaging's. That is the nine fence imports, and
    every prose, table or comment claim that a package is loaded or must be installed as `npm:<pkg>`
    (about 80 lines across ~20 files, §1). The loaders have imported bare names since M111a. One
    JSDoc outside Markdown, `cli/src/templates/full-stack-build-files.ts:20`, is corrected too. This
    takes the `npm:zod` half of **V9-10** from M113l; V9-10's other two halves (`envFilePath` and
    the Deno-only testing section) stay in M113l. The recurrence gate lands here too: the fence
    engine stops rewriting `npm:` specifiers, and `check:docs` refuses a stale one by name (§3.6).
- **NOT this milestone:**
  - V9-10's `envFilePath` and "Testing Your Application" halves — **M113l**.
  - The fence engine's `@hono/hono` → `hono` rewrite — a separate alias, not a module scheme; left
    as it is (§9).
  - Claim-time contention signals — documented as having no signal, unchanged (README "Several
    relays may sweep one store").
  - V9-18/V9-19 from the same X67 run — shipped in M113c/M113b.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                                                                                                                                                                         | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `boundedCall` / `bounded`                 | `packages/messaging-plugin/src/outbox/relay.ts:161-185`                                                                                                                                                                    | `timeoutMs = min(perCallMs, ceil(budget.remaining()))`; when `remaining <= 0` it rejects `RelayCallTimeoutError` **without invoking `run`**. Used by every relay store call and the purge job                                                                                                                                                                                                                                            |
| `SweepBudget.remaining()`                 | `relay.ts:73-102`                                                                                                                                                                                                          | Measured on `runtime.hrtime()` (monotonic); a SIGSTOP'd process's monotonic clock keeps advancing, so a pause past `sweepDeadlineMs` exhausts it                                                                                                                                                                                                                                                                                         |
| `stopReason`                              | `relay.ts:188-195`                                                                                                                                                                                                         | A row starts only while `remaining ≥ publishTimeoutMs + 2 × storeTimeoutMs` — so without a pause the budget always covers the post-publish `markSent`                                                                                                                                                                                                                                                                                    |
| `onMarkSent`                              | `relay.ts:228-245`                                                                                                                                                                                                         | `claim-lost` → `overlap('claim-lost')` + block key; `not-pending`/`sent` → `overlap('duplicate')`; `not-pending`/`failed` → block key                                                                                                                                                                                                                                                                                                    |
| `FaultStore` / `outboxClock`              | `packages/messaging-plugin/test/fixtures/outbox.ts:96-130,199-211`; `test/fixtures/outbox-relay-proofs.ts:21-53`                                                                                                           | `faults[method]` runs BEFORE delegating to the real store; `clock.step()` advances monotonic time firing no timers, `clock.advance()` fires due timers, `advanceWall()` moves wall time; `describeOutboxRelayProofs` runs each case on every configured real backend                                                                                                                                                                     |
| post-publish `markSent` call              | `relay.ts:344-361`                                                                                                                                                                                                         | A rejection (including the deadline) blocks the key and ends the sweep `'store-failure'`; the late answer is discarded — **V9-20's mechanism**                                                                                                                                                                                                                                                                                           |
| post-publish `markFailure` call           | `relay.ts:373-387`                                                                                                                                                                                                         | Same shape: a late `claim-lost` is lost and booked `'store-failure'`                                                                                                                                                                                                                                                                                                                                                                     |
| `withDeadline`                            | `packages/common/src/health/deadline.ts:118-158`                                                                                                                                                                           | Races `run(signal)` against a timer; the call keeps running after expiry (the relay's `run` ignores the signal), so its eventual settlement is observable if the caller keeps the promise. `Promise.race` attaches handlers, so the call's own rejection is handled                                                                                                                                                                      |
| `OutboxRelayObserver.overlap`             | `relay.ts:65`; `outbox-service.ts:120-129`                                                                                                                                                                                 | The service's wrapper stamps `#lastRelayOverlapAt` (feeds `instanceSignals().relayOverlap` → health reason `relay-overlap`, `outbox-service.ts:167-180`) then forwards to the collector                                                                                                                                                                                                                                                  |
| `OutboxCollector.overlap`                 | `packages/messaging-plugin/src/outbox/outbox-collector.ts:172-176`                                                                                                                                                         | Guarded (`#guard`): a failing metrics backend cannot throw out of it                                                                                                                                                                                                                                                                                                                                                                     |
| `instanceSignals().storeWriteFailing`     | `outbox-service.ts:175`                                                                                                                                                                                                    | `lastSweep.endedBy === 'store-failure'` — cleared by the next sweep that does not end that way                                                                                                                                                                                                                                                                                                                                           |
| Existing pause tests                      | `packages/messaging-plugin/test/unit/outbox/outbox-overlap.test.ts:105-137`                                                                                                                                                | Simulate a pause with a slow **publish** while A's clock and timers stand still — a real SIGSTOP advances both. This is why the suite never saw V9-20 (the contract-violating-double class)                                                                                                                                                                                                                                              |
| `OutboxTransition`                        | `packages/common/src/services/outbox.ts:131-155`                                                                                                                                                                           | `applied` / `missing` / `not-pending` (with `status`) / `claim-lost` / `not-failed`                                                                                                                                                                                                                                                                                                                                                      |
| `IInbox.release`                          | `packages/messaging-plugin/src/inbox/inbox-service.ts:397-408`                                                                                                                                                             | Throws `InboxRowStateError('invalid-id' \| 'missing' \| 'not-parked', status?)`; `TypeError` for an unknown action                                                                                                                                                                                                                                                                                                                       |
| `InboxRowStateError`                      | `packages/messaging-plugin/src/inbox/errors.ts:156-192`                                                                                                                                                                    | No status hint. Message quotes only a known status (`processed`/`discarded`/`attempting`)                                                                                                                                                                                                                                                                                                                                                |
| `OutboxRowStateError`                     | `packages/messaging-plugin/src/outbox/errors.ts:77-104`                                                                                                                                                                    | Same shape, no hint; thrown by `IOutbox.release` (`outbox-service.ts:296-298`) for `missing` / `not-failed`                                                                                                                                                                                                                                                                                                                              |
| `withHttpStatusHint` / `httpStatusHintOf` | `packages/common/src/errors/status-hint.ts:141,175`                                                                                                                                                                        | Brand under `Symbol.for('setu.http.status-hint')`; `detail` required; `status` 400–599; `errorHandler` serves the hint unmasked (M89b). Precedent: `cache-plugin/src/errors.ts:9-22` brands in the constructor                                                                                                                                                                                                                           |
| `IInboxStore.purge` contract              | `packages/common/src/services/inbox.ts:222-233`                                                                                                                                                                            | "Deletes rows of every status — `processed`, `discarded`, `attempting` and `parked`"                                                                                                                                                                                                                                                                                                                                                     |
| Database inbox store purge                | `packages/database-plugin/src/inbox/database-inbox-store.ts:98-103`                                                                                                                                                        | `PURGED_STATUSES` includes `'parked'` — the code and the `common` contract agree; only the README's custom-store paragraph disagrees                                                                                                                                                                                                                                                                                                     |
| README sites                              | `packages/messaging-plugin/README.md:1145`, `:1602`, `:1673-1675`, `:1704`, `:1264-1270`                                                                                                                                   | `:1145` `npm:drizzle-orm@^0.45.2/pg-core`; `:1602` and `:1673-1675` say parked rows are purged (true); `:1704` says `purge` never deletes a parked marker (false); `:1264` overlap kinds                                                                                                                                                                                                                                                 |
| Fence engine `npm:` normalisation         | `test/fixtures/snippets/fence-engine.ts:1171-1195`                                                                                                                                                                         | Rewrites `npm:pkg@range/sub` to `pkg/sub` before compiling — why the `package-readme-fence-compiler` gate (`test/package-readme-fence-compiler.test.ts:64`, 16 messaging fences) passed the broken import                                                                                                                                                                                                                                |
| `@setu-ts/exceptions` test dep            | `packages/database-plugin/package.json:71`, `secrets-plugin/package.json:66`                                                                                                                                               | Precedent for an integration test driving a hinted error through `errorHandler`; manifests are derived from test imports by `scripts/node-manifests.ts:214-269`                                                                                                                                                                                                                                                                          |
| `npm:` fence imports (the full set)       | `docs/getting-started.md:193`, `docs/migration-nestjs.md:514`, `PUBLIC_API.md:807,14524`, `packages/config-plugin/README.md:119`, `packages/graphql-plugin/README.md:62,83,84`, `packages/messaging-plugin/README.md:1145` | Nine imports, found by `git ls-files '*.md'` minus history files, matching `from`/`import`/`import(` followed by a quoted `npm:`                                                                                                                                                                                                                                                                                                         |
| `npm:` loader claims in prose/tables      | `PUBLIC_API.md:543,641,1914,1992,4154,8432`; `packages/database-plugin/README.md:518,589,732`                                                                                                                              | Each says a loader runs `import('npm:<pkg>…')`. The source imports the bare name: `logger-plugin/src/loggers/pino-logger.ts:235`, `database-plugin/src/adapters/{mongo/mongo-client.ts:177,dynamo/dynamo-client.ts:199,cosmos/cosmos-client.ts:250,bigtable/bigtable-client.ts:137}`, `realtime-backplane-plugin/src/transports/redis-module.ts:95` (`loadRedisModule`), `feature-flags-plugin/src/providers/launchdarkly-module.ts:198` |
| Bare `zod` / `graphql` resolvable         | root `node_modules` (`zod` 3.25.76); `packages/graphql-plugin/package.json:42,55` (`graphql` ^16)                                                                                                                          | The normaliser already compiled these fences as bare `zod`/`graphql`, so the source edit changes nothing the compiler sees                                                                                                                                                                                                                                                                                                               |
| `normaliseFenceSpecifiers`                | `test/fixtures/snippets/fence-engine.ts:1171-1201`; sole caller `:1103`; pinned by `test/unit/fence-specifiers.test.ts:6-22`                                                                                               | Rewrites `npm:` specifiers AND `@hono/hono` → `hono`, in import/export/`import()`/`import type` positions only                                                                                                                                                                                                                                                                                                                           |
| Toolchain-prose gate                      | `scripts/toolchain-prose.ts:13-18,371-449`; run by `scripts/check-docs.ts:56`                                                                                                                                              | Rules P1–P6 + `stale-allowlist`; skips `history()` paths (CHANGELOG, ROADMAP, plans) and CLAUDE.md's "Current status" section; scans `.md/.ts/…` files from `git ls-files`                                                                                                                                                                                                                                                               |
| CLAUDE.md `npm:` hits                     | `CLAUDE.md:295,2779,3883`                                                                                                                                                                                                  | All inside "Current status" — history the gate already skips                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                       | Doc deliverable (same PR)                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `README.md:1704` ("`purge` never deletes a parked marker") vs `README.md:1602`/`:1673`, `common/src/services/inbox.ts:222-233` and the shipped store                                                                                                                                                                                                                                                                                                                                                                                                    | The code, the `common` contract and the two other README sites | Rewrite the custom-store clause: "`purge` deletes rows of every status, `parked` included, at most `limit` per status"                                                                                                                                      |
| C2  | `README.md:1145` imports `npm:drizzle-orm@^0.45.2/pg-core`; npm-era docs and every package fence elsewhere import bare names (M111f)                                                                                                                                                                                                                                                                                                                                                                                                                    | Bare `drizzle-orm/pg-core`                                     | Fix the import                                                                                                                                                                                                                                              |
| C3  | `README.md:1264-1270` promises `duplicate` "(`markSent` found the row already sent)" — false for a paused relay (V9-20)                                                                                                                                                                                                                                                                                                                                                                                                                                 | The README; the code is changed to honour it (§3.1–§3.3)       | Add: the outcome is recorded even when it answers after the call's bound or the sweep deadline; a paused relay may ALSO report `store-write-failing` for that sweep                                                                                         |
| C4  | `PUBLIC_API.md:6930` (`InboxRowStateError` row) and the `OutboxRowStateError` row name no HTTP status; after this change both are hinted                                                                                                                                                                                                                                                                                                                                                                                                                | Document the statuses                                          | Add the 400/404/409 mapping to both rows and to the README export/error tables                                                                                                                                                                              |
| C5  | Eight more fence imports use `npm:` (§1) while every package is installed from npm and imported bare (M111)                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bare specifiers                                                | `zod`, `graphql` imports; `zod` stays version-unpinned in the import, as every other fence in the repo does                                                                                                                                                 |
| C6  | Every prose/table/comment claim that a package loads or installs as `npm:<pkg>` (PUBLIC_API ~29 lines incl. `:2892`, where `SamlRuntimeLoadError` is said to name `npm:@node-saml/…` but `SAML_SPECIFIER = '@node-saml/node-saml'`; `docs/plugins.md:372-500`; `docs/deployment.md:395`; ARCHITECTURE Rules rows incl. `:1303`, `:1630`; package READMEs of messaging `:8,194-199`, database, secrets `:11-13`, graphql, websocket `:28`, cache, logger, mail, scheduler, telemetry, realtime-backplane, react-router, auth, view, grpc; the CLI JSDoc) | The source (bare names since M111a)                            | Rewrite each to the bare package name, or the bare literal a loader uses (`import('pino')`), dropping version ranges. A line that is legitimately Deno-target or migration history is kept under the P8 rule's exemptions (§3.6) rather than rewritten      |
| C7  | ROADMAP M113l lists V9-10 whole; this branch closes its `npm:zod` half                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Split V9-10                                                    | The M113 table's Rows and Packages columns for M113j and M113l; the M113j section's `Package(s)` line (adds `scripts/`, `test/`, `docs/`, PUBLIC_API, ARCHITECTURE, the other package READMEs, `cli` JSDoc); the M113l section drops V9-10's `npm:zod` half |
| C8  | The sweep deadline is documented as bounding the whole sweep (`messaging-plugin/README.md:1245-1246`, `:1277`; `PUBLIC_API.md:6812`; `src/interfaces/index.ts:1051-1056` `sweepDeadlineMs` JSDoc; `src/outbox/relay.ts:6-8` header); after §3.1 a settlement write may outlive it by one `storeTimeoutMs`                                                                                                                                                                                                                                               | The new behaviour                                              | Rewrite each: the deadline bounds the sweep, except that a write settling an already-invoked publish runs to its own `storeTimeoutMs`; the drain on shutdown is bounded accordingly                                                                         |

## 3. Design decisions

### 3.1 A settlement write for an invoked publish runs under its own bound, never skipped by an exhausted sweep budget

- **Decision:** the relay records whether the publish was actually INVOKED: the `run` closure handed
  to `bounded(..., 'publish', …)` sets a local `publishInvoked = true` before calling the broker.
  `boundedCall` refuses at `remaining <= 0` without calling `run` (`relay.ts:169`), so the flag is
  false exactly when the budget refused the publish. Then:
  - `markSent` (reached only after a publish fulfilled, so always invoked) runs through a new
    internal `boundedSettle(ctx, what, run)` that bounds it by `storeTimeoutMs` **alone**, not
    `min(storeTimeoutMs, remaining)`, and always invokes `run`.
  - `markFailure` runs through `boundedSettle` only when `publishInvoked` is true. When the budget
    refused the publish, it keeps today's `bounded` path, which itself refuses: no write, no attempt
    counted, the claim expires and the next lap retries the row. Otherwise a pause between claim and
    publish would count an attempt (and could reach `failed` at `maxAttempts`) for a publish that
    never ran — reachable with a large `claimLeaseMs` (up to 3 600 000).
  - Every other call (`claim`, `markInvalid`, `failedKeys`, `scanPending`, the purge) keeps
    `boundedCall` unchanged.
- **Why:** after a pause the sweep budget is exhausted on resume, so `boundedCall` rejects without
  calling the store — the row's outcome is never learned and no overlap can be observed. A publish
  that was invoked has already happened (or may be accepted late); recording its outcome is part of
  that row's work, not new work. `stopReason` already reserves
  `publishTimeoutMs + 2 × storeTimeoutMs` before a row starts, so outside a pause the budget covers
  the write and nothing changes; the only new behaviour is a sweep that overran by a pause
  overrunning by at most one more `storeTimeoutMs`. The drain on shutdown waits for the in-flight
  sweep (`#inflight`), so its bound grows by the same amount — the doc sites in C8. Dropping the cap
  is safe against the scheduler lock: `sweep()` dedupes in process through `#inflight`, and the
  README already states the lock no longer bears on correctness.
- **Test home:** `test/unit/outbox/relay-late-settlement.test.ts`:
  - paused between publish and `markSent` (budget exhausted) → the store IS called and a
    `not-pending`/`sent` answer reports `duplicate`;
  - budget exhausted before the publish → the broker is never called, `markFailure` is never called,
    `attempts` is unchanged;
  - `boundedSettle` arms exactly `storeTimeoutMs` even with `budget.remaining() <= 0`. Negative
    controls 1 and 7.

### 3.2 A settlement write that answers after its bound still reports its overlap

- **Decision:** `boundedSettle` keeps the store's own promise. When the bounded call rejects with
  `RelayCallTimeoutError` (the bound, not the store), the relay still ends the sweep
  `'store-failure'` and blocks the key exactly as today, AND attaches one continuation to the
  store's promise. When it later fulfils, the answer goes through a new
  `observeSettlement(ctx, which, transition, { late: true })` — the SAME function the in-time path
  calls, so the two cannot disagree about what an answer means. Its table:

  | Write         | Answer                                   | Records                                       | In time also           |
  | ------------- | ---------------------------------------- | --------------------------------------------- | ---------------------- |
  | `markSent`    | `not-pending` / `sent`                   | `overlap('duplicate')`                        | —                      |
  | `markSent`    | `claim-lost`                             | `overlap('claim-lost')`                       | block key              |
  | `markSent`    | `not-pending` / `failed`                 | nothing                                       | block key              |
  | `markFailure` | `not-pending` / `sent` (publish invoked) | `overlap('duplicate')` — **new, in time too** | —                      |
  | `markFailure` | `claim-lost`                             | `overlap('claim-lost')`                       | —                      |
  | `markFailure` | `applied` with `status: 'failed'`        | `poisoned(topic)`                             | `budget.poisoned += 1` |
  | both writes   | `applied` (other), `missing`             | nothing                                       | —                      |

  Lap and budget mutations ("In time also") happen only in time; the continuation never touches the
  lap or the budget — the sweep is over. A late rejection is swallowed (it is the same store failure
  already booked).

- **The new `markFailure` / `sent` row:** a relay paused INSIDE its publish (after SIGCONT the
  publish deadline beats the broker's ack; `relay-budget.test.ts:131` already pins that the late ack
  leaves two copies) takes the failure path, and its `markFailure` then finds the row another relay
  sent. Today that answer is ignored, so a duplicate is produced with no signal. It is recorded as
  `duplicate` because two relays published the same row and this one's publish was invoked; the
  README states that this `duplicate` means "may have duplicated" (the broker may have refused this
  relay's copy), unlike `markSent`'s, which means it did.
- **Why:** under SIGSTOP the call's timer has already expired at resume, so the deadline wins the
  race over the store's real answer. When A's write had not yet reached the store, that answer is
  `not-pending`/`sent` — exactly the observed fact `duplicate` exists to report (if the write had
  reached the store before the stop, it answers `applied` and there is no duplicate). Observing the
  real answer keeps the overlap kinds observed rather than inferred. The sweep's `store-failure`
  stays, because when the sweep ended it genuinely did not know.
- **Late outcome after close:** dropped when `ctx.isClosing()` is true at settlement — nothing in
  the relay runs after the outbox closes. The forward observer is already guarded
  (`outbox-collector.ts:172`), and `observeSettlement` wraps its late observer calls in its own
  `try`/`catch`, so a throwing custom observer cannot surface as an unhandled rejection.
- **Test home:** `relay-late-settlement.test.ts`, one case per table row, late and in time:
  `markSent` answering `not-pending`/`sent` after `storeTimeoutMs` → `overlap-duplicate: 1`, sweep
  `endedBy: 'store-failure'`, `instanceSignals().relayOverlap === true`; late `claim-lost` for both
  writes; late `markFailure` `applied`/`failed` → `poisoned: 1`; `markFailure` finding `sent` after
  a timed-out publish → `duplicate` (in time and late); late `applied`/`missing` → nothing; late
  rejection → no unhandled rejection; closed outbox → nothing; throwing observer → no unhandled
  rejection. Negative controls 2 and 4.

### 3.3 The pause is simulated by advancing the paused relay's clocks, not by a slow publish

- **Decision:** the new tests pause relay A and let relay B take the row while A is stopped, in the
  order a SIGSTOP produces. Three variants on `outboxHarness`/`outboxClock`
  (`test/fixtures/outbox.ts`):
  1. **Inside `markSent`:** `a.store.faults.markSent` (the `FaultStore` hook runs BEFORE delegating,
     `outbox.ts:207-211`) calls `a.clock.advance(storeTimeoutMs)` to fire the call's deadline, moves
     both wall clocks past `leaseUntil + maxClockSkewMs`, awaits `b.sweep()`, and only then lets the
     delegate run (§3.2).
  2. **Between publish and `markSent`:** inside `a.broker.behaviour`, `a.clock.step(…)` (the advance
     that fires NO timers) moves A's monotonic clock past `sweepDeadlineMs`, the wall clocks move
     past the lease, `b.sweep()` runs, and the behaviour then resolves. `advance()` would be wrong
     here: it fires the publish's own deadline and sends the row down the `markFailure` path (§3.1).
  3. **Inside the publish:** inside `a.broker.behaviour`, in this order: move both wall clocks past
     the lease, await `b.sweep()` (B claims, publishes and marks the row sent), and only THEN
     `a.clock.advance(publishTimeoutMs)`, so the publish's deadline fires and A takes the
     `markFailure` path (§3.2's new row). Firing the deadline first lets A's `markFailure` back the
     row off before B sweeps, and B then publishes nothing.

  `boundedSettle` arms its deadline before it invokes the store call
  (`Promise.resolve().then(run)`), so a fault hook that advances A's clock at its start does fire
  the settle's deadline, and a synchronous throw from the store becomes a rejection.

- **Why:** the existing pause tests (`outbox-overlap.test.ts:105-137`) leave A's clock still, so A's
  `markSent` always answers in time — a double that cannot reproduce the defect.
- **Test home:** `relay-late-settlement.test.ts`; plus the real-backend proof in §3.7.

### 3.4 The operator `release` refusals carry a status hint

- **Decision:** `InboxRowStateError` and `OutboxRowStateError` brand themselves in their
  constructors with `withHttpStatusHint` (the `cache-plugin` precedent), and
  `OutboxService.release`'s bare `TypeError('outbox: release needs the row id')`
  (`outbox-service.ts:288-290`) becomes `OutboxRowStateError('invalid-id')` — the analogue of the
  inbox's `invalid-id`. Mapping, with FIXED details that quote nothing from a row:

  | Class                 | `outcome`    | `status` | `detail`                                                  |
  | --------------------- | ------------ | -------- | --------------------------------------------------------- |
  | `InboxRowStateError`  | `invalid-id` | 400      | `The inbox row id is malformed.`                          |
  | `InboxRowStateError`  | `missing`    | 404      | `No inbox row has that id.`                               |
  | `InboxRowStateError`  | `not-parked` | 409      | `The inbox row is not parked, so it cannot be released.`  |
  | `OutboxRowStateError` | `invalid-id` | 400      | `The outbox row id is malformed.`                         |
  | `OutboxRowStateError` | `missing`    | 404      | `No outbox row has that id.`                              |
  | `OutboxRowStateError` | `not-failed` | 409      | `The outbox row is not failed, so it cannot be released.` |

  `title` is the reason phrase (`Bad Request` / `Not Found` / `Conflict`).
  `OutboxRowStateError.outcome` widens to `'invalid-id' | 'missing' | 'not-failed'` (an additive
  union member — a consumer's exhaustive `switch` without a default stops compiling; recorded in
  CHANGELOG and the upgrade guide). The `outbox: release needs the row id` message text is kept.
  `OutboxRowStateError` also starts validating its `status` against the three known values the way
  the inbox class does: today it quotes the stored status unchecked into its message
  (`database-outbox-store.ts:382` returns it raw), so a row edited to carry other text reached the
  log.

- **Why:** the caller caused the condition and it is permanent for that request; a masked `500`
  hides it and reads as a server fault (M89b). `409` rather than `400` for a wrong-state row:
  nothing is wrong with the request's shape, the row's current state conflicts with it. Fixed
  details keep row contents out of the response. The outbox class is included because it is the same
  defect on the sibling `release`.
- **Unchanged on purpose:** the `TypeError` for an unknown `action` (both services) — a value the
  type forbids, which a route must validate before calling; `IInbox.parked(limit)`'s `RangeError` —
  the same reasoning, a numeric argument a route must validate; and `OutboxUnknownTenantError` —
  reached from `write`/`release` with a `tenantId` the application derives from its own tenancy, not
  from operator input, so it is a configuration fault (§9).
- **Test home:** `test/unit/inbox/inbox-release.test.ts` and
  `test/unit/outbox/outbox-release.test.ts` (each outcome → `httpStatusHintOf(error)` field by
  field; an edited unknown outbox status is not quoted); the new
  `test/integration/release-status.test.ts` drives both `release` calls from routes in a real kernel
  app with `errorHandler({ format: 'rfc9457' })`. The route takes the row id in the request BODY,
  because `rfc9457` derives `instance` from the request path. It asserts status, `title`, `detail`,
  `instance`, no `message`, and the ABSENCE of the row id and stored status from the body. Negative
  control 3.

### 3.5 Doc corrections

- **Decision:** C1–C8 as written in §2. In the messaging README, the overlap paragraph gains the
  late-settlement sentences, including that a relay paused inside its publish reports a "may have
  duplicated" `duplicate` (§3.2). Elsewhere each edit changes the stale specifier or deadline claim
  at the site and no more.
- **Why:** each is the finding's own text, a direct consequence of §3.1–§3.4, or a site the §3.6
  gate would otherwise refuse.
- **Test home:** the fence compilers (`guide-fence-compiler`, `package-readme-fence-compiler`; fence
  counts unchanged) compile the fences as written (§3.6), and `check:docs` runs P7 and P8 over every
  Markdown file.

### 3.6 The recurrence gate: a stale `npm:` specifier is refused by name, and no longer rewritten

- **Decision:** three changes.
  1. **Rule P7 in `scripts/toolchain-prose.ts` — import positions.** In a non-history `.md` file
     (the existing `history()` and CLAUDE.md "Current status" exemptions), an `npm:` specifier in
     `'` or `"` quotes in an import position — `from '…'`, `import '…'`, `import type … from '…'`,
     `import('…')` — is reported as
     `P7: Node cannot load an npm: specifier; import the bare package name`. Backtick-quoted text is
     NOT an import position for P7 (ARCHITECTURE's "lazy-loaded from `` `npm:` ``" is P8's
     business). P7 has **no allowlist**.
  2. **Rule P8 — stale `npm:` package references.** In the same files, any `npm:<pkg>` where `<pkg>`
     is not `@setu-ts/…` (governed by P1/P3) and not `@jsr/…` (P1) is reported as
     `P8: packages install and import by bare name since 0.9.0; drop the npm: prefix`, UNLESS the
     line is a Deno install command (`deno add`/`deno install` with the specifier as an argument — a
     legitimate Deno-target instruction, e.g. `docs/upgrading.md:600`,
     `packages/grpc-plugin/README.md:31`). Anything else legitimate gets a P8 allowlist entry with
     the existing category vocabulary and a reason; the ratchet then refuses an unused entry.
     Whether each of the ~83 current lines is corrected (C5, C6) or allowlisted is decided per line
     during implementation against the source, and the plan's §1 list is the starting inventory.
  3. **`normaliseFenceSpecifiers` drops its `npm:` branch** and keeps only the `@hono/hono` → `hono`
     rewrite. A compiled fence that reintroduces `npm:` now fails to resolve (TS2307) instead of
     being silently rewritten. `ToolchainProseFinding['rule']` gains `'P7' | 'P8'`.
- **Why all three:** P7 names the defect that breaks a copied example on Node; P8 covers prose,
  tables and comments the fence compilers never compile (most of C6); the fence compiler's failure
  covers a fence spelled in a way P7's pattern misses. A normaliser that rewrites a refused form is
  dead logic once every site is fixed.
- **Test home:** `test/toolchain-prose.test.ts` — P7 fires for each quoted import spelling at the
  right line and not for a backticked mention; P8 fires for a backticked `npm:ioredis` in a table
  and for prose, not for `npm:@setu-ts/…`, `npm:@jsr/…`, a `deno add npm:hono` line, an allowlisted
  path, a history file, or CLAUDE.md's status section; an unused P8 allowance is refused; the
  real-tree test ("checks the real tree with zero findings") proves every site is fixed or
  allowlisted. `test/unit/fence-specifiers.test.ts` — `npm:` specifiers are left unchanged while
  `@hono/hono` is still rewritten. Negative controls 5 and 6.

### 3.7 Real-backend proof of V9-20

- **Decision:** add one case to the shared fixture `test/fixtures/outbox-relay-proofs.ts`
  (`describeOutboxRelayProofs`), which `test/integration/outbox-fencing-real.test.ts` runs once per
  backend — PostgreSQL, MongoDB replica set, DynamoDB Local — each guarded by its existing env
  variable. The case is §3.3 variant 1 over the REAL store: A's `faults.markSent` hook fires A's
  deadline, moves the wall clocks past the lease, awaits `b.sweep()` (B claims, publishes, marks
  sent on the real backend) and only THEN lets A's real `markSent` run, which answers
  `not-pending`/`sent`; A reports `duplicate`. Holding the hook before delegating is the point: a
  wrapper around the real call's promise would issue A's UPDATE first, A would still hold the claim,
  B would never republish, and the case would prove nothing.
- **Why:** proves each real store's `not-pending`/`sent` answer reaches the late observer. A
  subprocess SIGSTOP harness is not justified for one timing path the unit test already pins.
- **Test home:** `test/fixtures/outbox-relay-proofs.ts`, run by `outbox-fencing-real.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `OutboxRowStateError.outcome` gains `'invalid-id'`. That is an
additive union member, but a consumer's exhaustive `switch` with no default stops compiling; ships
in minor 0.10.0 with the rest of M113, with a CHANGELOG **Changed** entry and a `docs/upgrading.md`
line (add a case for `'invalid-id'`). Behaviour changes, not API:

- An unhandled `release` refusal under `errorHandler` answers `400`/`404`/`409` instead of a masked
  `500`. No reader action is needed; the upgrade guide says "none required" for it, per M90h.
- The `outbox_overlaps_total{kind="duplicate"}` counter and the `relay-overlap` health reason can
  now fire for a paused relay, including from `markFailure` (§3.2).
- `outbox_poisoned_total` now counts a row that a late `markFailure` made `failed`.

`src/index.ts` is **unchanged**; the existing `barrel-exports` tests pin it.

| Exported symbol       | Kind  | Consumer / real code path that READS it                                                                                                                   |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InboxRowStateError`  | class | Unchanged export; its new hint is read by `@setu-ts/exceptions` `errorHandler` (`httpStatusHintOf`, `error-handler.ts:199`)                               |
| `OutboxRowStateError` | class | Same; its new `'invalid-id'` outcome is thrown by `OutboxService.release` for a missing or non-string id, and the integration test's route branches on it |

Internal (not exported): `boundedSettle` and `observeSettlement` in `relay.ts`.

### 4.1 Options — every option names its consumer

None (checked): no option is added or changed.

## 5. Implementation files

| File                                                                                           | Purpose                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                                 | Unchanged                                                                                                                                     |
| `src/outbox/relay.ts`                                                                          | `publishInvoked` flag, `boundedSettle`, `observeSettlement` (replaces `onMarkSent` and the inline `markFailure` handling); module header (C8) |
| `src/outbox/outbox-service.ts`                                                                 | `release`'s missing-id `TypeError` → `OutboxRowStateError('invalid-id')`                                                                      |
| `src/inbox/errors.ts`                                                                          | `InboxRowStateError` brands its status hint                                                                                                   |
| `src/outbox/errors.ts`                                                                         | `OutboxRowStateError` brands its status hint, gains `invalid-id`, validates `status`                                                          |
| `src/interfaces/index.ts`                                                                      | `sweepDeadlineMs` JSDoc (C8)                                                                                                                  |
| `README.md`                                                                                    | C1–C4, C6, C8; overlap paragraph (§3.5)                                                                                                       |
| `package.json`, `deno.json`, `tsconfig.json` (as regenerated), `../../pnpm-lock.yaml`          | `@setu-ts/exceptions` dev dependency, via `scripts/node-manifests.ts`; `--check` must pass                                                    |
| `../../PUBLIC_API.md`                                                                          | C4, C5, C6, C8                                                                                                                                |
| `../../ARCHITECTURE.md`, `../../docs/{getting-started,migration-nestjs,plugins,deployment}.md` | C5, C6                                                                                                                                        |
| the other package READMEs named in C5/C6                                                       | C5, C6                                                                                                                                        |
| `../cli/src/templates/full-stack-build-files.ts`                                               | JSDoc only (C6)                                                                                                                               |
| `../../scripts/toolchain-prose.ts`                                                             | Rules P7 and P8, allowlist entries (§3.6)                                                                                                     |
| `../../test/fixtures/snippets/fence-engine.ts`                                                 | `normaliseFenceSpecifiers` drops the `npm:` branch (§3.6)                                                                                     |
| `test/fixtures/outbox-relay-proofs.ts`                                                         | The real-backend case (§3.7)                                                                                                                  |
| `../../CHANGELOG.md`                                                                           | `Unreleased`: Fixed (V9-20), Changed (V9-21 statuses, `invalid-id`), docs (V9-22, V9-10's `npm:` half, P7/P8)                                 |
| `../../docs/upgrading.md`                                                                      | 0.10.0 / `Unreleased`: the `invalid-id` case; "none required" for the status change                                                           |
| `../../ROADMAP.md`, `../../CLAUDE.md`                                                          | C7; status flip + PR number (in the PR)                                                                                                       |
| `plans/archive/milestone-113j-outbox-inbox-signals.md`                                         | This plan, moved on completion (in the PR)                                                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                            | src covered                             | Key assertions                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/outbox/relay-late-settlement.test.ts` (new)                                               | `relay.ts`                              | §3.1–§3.3: the three pause variants; every §3.2 table row late and in time; publish never invoked → no `markFailure`, `attempts` unchanged; settle bound = `storeTimeoutMs` with budget ≤ 0; closed → nothing; late rejection and throwing observer → no unhandled rejection; sweep still `store-failure` |
| `test/unit/outbox/relay-store-failure.test.ts` (existing)                                            | `relay.ts`                              | Unchanged assertions still pass: an in-time `markSent` rejection blocks the key and republishes first next lap                                                                                                                                                                                            |
| `test/unit/outbox/relay-budget.test.ts` (existing)                                                   | `relay.ts`                              | `:131` ("a publish that times out and is accepted late leaves two copies") still passes, now with the `markFailure`/`sent` → `duplicate` row asserted where it applies                                                                                                                                    |
| `test/unit/outbox/outbox-overlap.test.ts` (existing)                                                 | `relay.ts`, `outbox-service.ts`         | Unchanged                                                                                                                                                                                                                                                                                                 |
| `test/unit/inbox/inbox-release.test.ts` (extended)                                                   | `inbox/errors.ts`                       | Each outcome's hint field by field; the hint carries no row id or stored status                                                                                                                                                                                                                           |
| `test/unit/outbox/outbox-release.test.ts` (extended)                                                 | `outbox/errors.ts`, `outbox-service.ts` | All three outbox outcomes; `release('')`/non-string → `invalid-id`; an edited unknown status is not quoted                                                                                                                                                                                                |
| `test/integration/release-status.test.ts` (new)                                                      | both error files                        | Real kernel app + `errorHandler({ format: 'rfc9457' })`, id in the request body: 400/404/409 bodies field by field (`type`, `title`, `status`, `detail`, `instance`; no `message`); id and status absent                                                                                                  |
| `test/fixtures/outbox-relay-proofs.ts` via `test/integration/outbox-fencing-real.test.ts` (extended) | `relay.ts`                              | §3.7 on real PostgreSQL, MongoDB replica set and DynamoDB Local                                                                                                                                                                                                                                           |
| `../../test/toolchain-prose.test.ts` (extended)                                                      | `scripts/toolchain-prose.ts`            | §3.6 P7 and P8 cases; unused P8 allowance refused; the real-tree zero-findings test                                                                                                                                                                                                                       |
| `../../test/unit/fence-specifiers.test.ts` (changed)                                                 | `fence-engine.ts`                       | `npm:` left unchanged; `@hono/hono` still rewritten                                                                                                                                                                                                                                                       |

**Negative controls** (each observed failing, then reverted):

1. `boundedSettle` reverted to `boundedCall` for `markSent` → the "paused between publish and
   `markSent`" case reports no `duplicate` and the store is never called.
2. The late continuation removed → the "paused inside `markSent`" case reports no `duplicate`, and
   the real-backend case fails on every backend that runs.
3. The hint removed from `InboxRowStateError` → the integration test answers `500` with the masked
   detail.
4. The `isClosing()` check removed → the closed-outbox case records an overlap.
5. One fixed site reverted to `import { z } from 'npm:zod@^3.24.0'` → `check:docs` reports P7 at
   that line, and the fence compiler reports TS2307 for the same fence.
6. A backticked `` `npm:ioredis` `` restored in the messaging broker table → P8 reports it; the
   fence compilers do not (the two rules are independent).
7. `publishInvoked` ignored (always `boundedSettle` for `markFailure`) → the "budget exhausted
   before the publish" case writes an attempt for a publish that never ran.

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/m113j-outbox-inbox-signals, never develop/main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:tooling:coverage   # scripts/toolchain-prose.ts stays ≥90%
pnpm run test:deno-lane
pnpm run check:docs
node scripts/node-manifests.ts --check
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Real backends for §3.7: PostgreSQL, a MongoDB replica set and DynamoDB Local, per the guards in
`outbox-fencing-real.test.ts` (memory: the full-backend env block).

## 8. Risks & mitigations

- **A sweep now outlives `sweepDeadlineMs` by up to one `storeTimeoutMs` after a pause** → confined
  to a settlement write for an invoked publish; `stopReason` keeps every row from starting without
  the full reserve, and C8 corrects every doc site that promised the deadline bounds the whole
  sweep.
- **A slow but healthy store looks like a pause** → harmless: the late continuation records only the
  answers §3.2 lists, each of which means the same thing whenever it arrives.
- **The `markFailure`/`sent` `duplicate` over-reports** when the broker refused the paused relay's
  copy → stated in the README as "may have duplicated"; an operator investigating a `duplicate`
  already has to check the consumer side, and the alternative is the silent duplicate V9-20 is.
- **The late continuation runs after the lap moved on** → it never touches the lap or budget (§3.2);
  the in-time path already blocked the key.
- **P8 is broad (~83 current lines)** → each line is decided against source, legitimate Deno-target
  lines are exempt by rule or allowlisted with a reason, and the ratchet refuses a stale allowance.
  This is mechanical batch work suitable for opencode once the rule is written.
- **M113l edits `docs/getting-started.md` in parallel** → this branch touches only the specifier
  lines; C7 records the split in both ROADMAP sections so neither branch reclaims the other's half.

## 9. Out of scope

- V9-10's `envFilePath` and testing-section halves — **M113l** (C7).
- The fence engine's `@hono/hono` → `hono` rewrite — kept; whether any doc still needs it is not
  this letter's question.
- Hints for `release`'s unknown-`action` `TypeError`, `IInbox.parked(limit)`'s `RangeError` and
  `OutboxUnknownTenantError` — §3.4 "Unchanged on purpose".
- A process-level SIGSTOP harness — the X67 smoke re-run on the next published version is the
  end-to-end check (rows close only on a published re-run).
- An inferred "publish completed after lease expiry" signal — rejected: the overlap kinds report
  store answers, and a new kind would widen `OutboxRelayObserver`.

## 10. Design security review

Recorded before the committed-tree audit and after implementation (the plan's first version carried
only a four-row sketch and judged an audit unnecessary; that judgement is withdrawn — the change
sends new information out of the process on an operator route, so CLAUDE.md requires an audit). This
section is what the audit checks the code against.

### 10.1 Reviewed flows

1. **Operator release (V9-21).** An HTTP route an application writes takes a row id (and an action)
   from the request, calls `IOutbox.release` or `IInbox.release`, and lets a refusal propagate to
   `errorHandler`. The refusal's status-hint brand decides the status, title and detail the client
   receives (`exceptions` `buildErrorFromInit`, M89b); the `Error.message` reaches the log only.
2. **Relay settlement (V9-20).** After an invoked publish, `boundedSettle` runs `markSent` /
   `markFailure` under `storeTimeoutMs`, ignoring an exhausted sweep budget, and keeps the store's
   promise so a late answer feeds `observeSettlement` — metrics (`outbox_overlaps_total`,
   `outbox_poisoned_total`) and the `relay-overlap` health reason.
3. **Documentation gate (V9-22).** `scripts/toolchain-prose.ts` runs regular expressions P7/P8 over
   every tracked Markdown line in `check:docs`; the fence compiler no longer rewrites `npm:`.

### 10.2 Assets

| #   | Asset                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------- |
| A1  | Row contents: envelope payloads, stored status text, row ids, `lastError` text                              |
| A2  | The operator response body and headers (all three `errorHandler` formats)                                   |
| A3  | Log records (the `Error.message` of a refusal, relay reports)                                               |
| A4  | The integrity of the duplicate / claim-lost / poisoned signals an operator acts on                          |
| A5  | Relay availability: the sweep, the shutdown drain, the process itself                                       |
| A6  | The outbox's at-least-once guarantee and `maxAttempts` accounting (no attempt for a publish that never ran) |

### 10.3 Attackers

| #   | Attacker                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | A caller of an operator `release` route — an authenticated operator, or anyone if the application failed to gate it — controlling the id and action |
| T2  | A party able to edit outbox/inbox rows in the shared store (a compromised service on the same database, a hand edit)                                |
| T3  | A slow, hung, or hostile store: never settles, throws synchronously, rejects late, answers late                                                     |
| T4  | Time: a process paused (SIGSTOP, VM freeze) past its lease and budget, or a clock that jumps                                                        |
| T5  | A documentation contributor whose Markdown the gate scans (a very long line, many backticks)                                                        |

### 10.4 Threats and resolutions

| #   | Threat                                                                                                                           | Resolution in the code (each a claim the audit checks)                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | T1 gets row contents (A1) into the response body (A2)                                                                            | The hint's `detail` is a fixed sentence per outcome (`HINT_BY_OUTCOME`, both `errors.ts`); no id, status or envelope is interpolated into the hint                                                       |
| S2  | T1 uses distinct 400/404/409 as an existence/state oracle for row ids                                                            | Accepted residual: ids are 64-hex marker hashes or store UUIDs that only operator APIs list; both READMEs state `release` carries no authorization and must be gated (`README.md:1240`, `:1611`)         |
| S3  | T2 plants text in a row's `status`, which reaches a log (A3) through the refusal's message                                       | Both classes keep `status` only when it is one of three known values (`KNOWN_STATUSES`); anything else reads "not parked/not failed" with no `status` key                                                |
| S4  | A brand is read as an authorization decision (class 10)                                                                          | The hint decides only an error response's status/body; nothing branches on it for access                                                                                                                 |
| S5  | The hint widens what masking lets through: a non-`release` error, or a driver fault, gets an unmasked body                       | Only the two row-state classes are branded; every other error from `release` (store faults, `InboxNotReadyError`, `TypeError` for an action) stays an unhinted, masked 500                               |
| S6  | T3 never settles a settlement write: the sweep or the shutdown drain hangs (A5)                                                  | `boundedSettle` still bounds every write by `storeTimeoutMs` (validated integer ≥ 1); only the sweep-budget cap is dropped, and only for an invoked publish                                              |
| S7  | T3 throws synchronously from `markSent`/`markFailure`: an exception escapes the relay or the process                             | `boundedSettle` invokes the store via `Promise.resolve().then(run)`, so a synchronous throw is a rejection                                                                                               |
| S8  | A late settlement surfaces an unhandled rejection or a throwing observer kills the process (A5)                                  | The late continuation's rejection handler is a no-op; late observer calls run inside `try`/`catch`; the collector is itself guarded                                                                      |
| S9  | A hung store accumulates retained promises/continuations without bound (memory, A5)                                              | At most one late continuation per sweep (the sweep ends at the first settlement timeout); `withDeadline` already retained the call promise before this change — the audit checks no NEW per-row growth   |
| S10 | A late answer after `stop()` writes metrics or health after shutdown                                                             | Dropped when `ctx.isClosing()`                                                                                                                                                                           |
| S11 | T4 pauses between claim and publish and the relay counts an attempt for a publish that never ran, driving a row to `failed` (A6) | `publishInvoked` gates `boundedSettle` for `markFailure`; with the budget refusing the publish, `markFailure` keeps the old refusing path and nothing is written                                         |
| S12 | T2/T3 forge or suppress the duplicate signal (A4)                                                                                | Signals follow only the store's own transition answers; a party controlling the store already controls the rows. Stated, not mitigated: the signals are monitoring, never an access or delivery decision |
| S13 | T5 makes P7/P8 slow (ReDoS) or crash `check:docs`                                                                                | P7 and P8 are linear (no nested quantifiers); the per-match backtick count is O(line length). The audit drives a long hostile line                                                                       |
| S14 | A new dependency reaches a published graph                                                                                       | `@setu-ts/exceptions` is a `devDependencies` entry only (`package.json`); the packed manifest must not list it as a runtime dependency                                                                   |

### 10.5 Obligations on the committed-tree audit

Each probe has a negative half and a positive control (the legitimate path through the same code
still works), per `.roo/skills/security-audit/SKILL.md`.

1. **Canaries through the release route (S1, S3, S5).** Through a real kernel app with
   `errorHandler` under `'default'`, `'rfc9457'` and a custom formatter: plant `canary-id-…` as the
   row id, `canary-status-…` as an edited stored status (T2), and `canary-env-…` in the envelope.
   Search the raw response bytes, headers and the captured logs. Positive control: the 400/404/409
   status and fixed detail arrive; a real parked/failed row releases with `200`.
2. **Unhinted errors stay masked (S5).** A store whose `release` rejects with a driver error
   carrying `canary-driver-…`: the response is `500` with the masked detail and no canary; an
   unknown action still answers `500`.
3. **Hung, sync-throwing and late stores (S6–S10).** A store whose `markSent` never settles: a sweep
   returns within `storeTimeoutMs` of its call even with the budget exhausted, and `app.stop()`
   completes. A store that throws synchronously: no uncaught exception, sweep ends `store-failure`.
   A late answer after `stop()`: no metric or health change. Run 1,000 sweeps against a
   never-settling store and report retained-continuation growth against the pre-change baseline
   (`develop`).
4. **Pause accounting (S11).** Budget exhausted before the publish: the broker is never called and
   `attempts` is unchanged; positive control: a publish that is invoked and times out writes exactly
   one attempt.
5. **Duplicate signal (A4).** The late-settlement case on a real backend (PostgreSQL) reports
   `duplicate`; positive control: an unpaused sweep reports no overlap.
6. **Gate robustness (S13).** A 1 MB Markdown line of backticks and `npm:` fragments runs through
   `scanToolchainProse` in bounded time; positive control: a single real `from 'npm:zod'` is still
   reported.
7. **Packed dependency graph (S14).** `pnpm pack` of `messaging-plugin`: `@setu-ts/exceptions` is
   absent from `dependencies` and `peerDependencies`.
8. **Defect-class sweep.** All fifteen classes in the skill's Step 4, applies or N/A with a reason.
   Expected to apply: 2 (refusal paths), 4 (no header/log value is newly written — confirm), 5, 8
   (`release` with no authorization is documented, not fail-closed — confirm it is not represented
   otherwise), 10, 11, 12 (the edited `status` value), 13 (gate input).
9. **Negative controls.** Revert each control in §6's list (1–7) plus S3's status check and S7's
   deferred invocation, and observe a probe fail.

The audit runs in a fresh context (not this session's), on the committed revision the PR will merge,
and its record goes in the PR description.

## 11. Plan review (one round, fresh-context agent, before implementation)

Thirteen findings, all folded into this plan: the `markFailure` write for a publish the budget never
invoked (§3.1, control 7); four sweep-deadline doc sites (C8); the pause inside the publish (§3.2's
`markFailure`/`sent` row); the stale loader claims beyond `import('npm:…')` (C6, rule P8); the
real-backend case's home and mechanism (§3.7); `instance` carrying the path (§3.4); the outbox
missing-id `TypeError` (§3.4); the unchecked outbox `status` (§3.4, S5); the late `poisoned` count
(§3.2); P7's quote set (§3.6); the M113 table rows (C7); the regenerated manifest files, upgrade
guide and plan archive (§5); and §3.2's overclaim about which late answer arrives.

## 12. Implementation notes

Implemented by opencode (local Qwen 27B) in two runs, then finished by Claude at the maintainer's
direction. Run 1 (20:55–22:32) delivered part 1 and the `relay.ts` change; its new relay tests did
not converge (11 of 14 failing), for three reasons diagnosed outside the run: `boundedSettle`
invoked the store before arming its deadline, the tests expected the internal `'lap-complete'`
instead of the result's `'complete'`, and the inside-the-publish cases fired A's deadline before B
swept (§3.3 now states the order). Run 2 (22:34–01:20) applied those fixes and delivered parts 2–5,
`fmt` and `lint`; it was stopped before the remaining gates. Claude then fixed a `check` error
(`allowNpmRef: true` widened to `boolean` in two test fixtures), marked the `release` entry
**Breaking** in the CHANGELOG, corrected a false upgrade-guide claim (the outbox `invalid-id` is an
empty or non-string id, not a non-UUID one), and ran the gates and controls below.

- **Gates:** `fmt:check`, `lint`, `check`, `check:plan`, `check:docs`, `node-manifests --check`,
  `test:tooling:coverage` (1,347 tests), `test:deno-lane`, `release:verify 0.9.0` and
  `release:publish --dry-run` all exit 0. `pnpm test:coverage messaging-plugin` with PostgreSQL, a
  MongoDB replica set, DynamoDB Local, Redis and RabbitMQ: 1,649 passed, 1 failed —
  `consumer-retry-real.test.ts` "survives a broker restart" (`Channel ended`), which restarts the
  shared broker; the file passes 14/14 alone and touches no M113j code.
- **Coverage (changed `src`):** `relay.ts` 99.49 / 95.45 / 97.05 / 99.41 (statements / branch /
  function / line); `inbox/errors.ts`, `outbox/errors.ts`, `interfaces/index.ts` 100;
  `outbox-service.ts` 100 / 98.57 / 100 / 100.
- **Real backends (§3.7):** `outbox-fencing-real.test.ts` 12/12 on PostgreSQL, MongoDB replica set
  and DynamoDB Local, including the new late-duplicate case.
- **Negative controls:** all seven observed failing, then reverted — (1) `markSent` through
  `boundedCall`: the between-publish case fails; (2) late continuation removed: the
  inside-`markSent` case fails; (3) inbox hint removed: 3 of 7 `release-status` tests fail; (4)
  `isClosing()` check removed: the closing case fails; (5) `npm:zod` restored in
  `docs/getting-started.md`: P7 reports it and the guide fence compiler fails with TS2307; (6)
  `` `npm:ioredis` `` restored in the messaging broker table: P8 reports it; (7) `publishInvoked`
  ignored: the budget-exhausted case fails.
- **`npm:` sweep:** every non-history Markdown hit was rewritten; none needed a P8 allowlist entry.
  Deno install commands (`deno add npm:…`) are exempt by rule. `CLAUDE.md` lines outside "Current
  status" were rewritten too (P8 scans them), keeping each lesson's meaning.
