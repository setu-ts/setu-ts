# Milestone 107b — Outbox relay fencing and multi-relay sweeping (`@setu-ts/messaging-plugin`, `@setu-ts/common`, `@setu-ts/database-plugin`)

> **Status:** Planning. Branch: `feat/m107b-outbox-relay-fencing`. `main` and `develop` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

M107's relay is correct for one relay at a time and only time-bounded for more: a relay paused past
the scheduler lock's TTL — a GC pause, a frozen container, a slow broker call — can publish a row a
second relay has already sent, and `dispatch()` sweeps run on every replica outside any lock
(`outbox-service.ts:223-244`), so an application that calls `dispatch()` already runs overlapping
relays in normal operation, not only after a pause. This milestone makes every row a relay publishes
a row it holds a **claim** on: a per-row lease taken with an M105 conditional write, checked again
immediately before the publish, and required by every status write afterwards. A relay that has lost
its claim cannot publish the row (beyond one bounded, stated window), cannot mark it, and cannot
count a failure against it. Because a claim is per row and is taken by compare-and-set, any number
of relays may sweep one outbox at once without publishing a row twice, and per-key order is kept by
treating a row claimed elsewhere exactly as M107 treats a row in backoff: its key is blocked for the
rest of the lap.

**One mechanism on every supported backend.** The ROADMAP section proposed two arms — a
`FOR UPDATE SKIP LOCKED` claim on SQL and an epoch fence elsewhere. Neither survived the source (§2
C1–C3): the portable surface offers no row lock and no raw SQL inside a transaction, the outbox
cannot see the scheduler's lock to take an epoch from it, and the "deferred-write" backends defer
only INSIDE a transaction, which the relay never opens. Every backend the outbox supports already
implements a native `updateWhere` outside a transaction (§1), so one claim protocol serves all of
them, and a store that cannot write conditionally is refused at startup by name.

- **In scope:**
  - `common` (the `IOutboxStore` port, unreleased — first ships in 0.9.0): two record fields
    (`claimVersion`, `leaseUntil`), two port methods (`claim`, `markInvalid`), a `claimVersion`
    member on the `markSent`/`markFailure` update, a `claim-lost` transition outcome, and the
    removal of `OutboxTransition`'s `sentBy` member, whose only reader is deleted here.
  - `database-plugin`'s `createDatabaseOutboxStore` bridge: the claim, the claim-guarded
    transitions, `markInvalid`, a `verify()` step refusing a store without native conditional
    writes, the deletion of the read-then-write fallback that step makes unreachable, and the DDL.
  - `messaging-plugin`'s relay: claim before publish, the pre-publish fence, claim-aware blocking,
    the claim-lost and duplicate signals, two relay options, and the replacement of the
    `scheduled-overlap` health reason and the `origin` metric label.
  - Real-backend proofs: a paused relay fenced, and N relays draining one outbox with no row
    published twice and per-key order kept, on PostgreSQL, a MongoDB replica set and DynamoDB Local
    in CI, and on D1's engine at unit level.
- **NOT this milestone:**
  - Exactly-once delivery. The promise stays at-least-once (§3.9); the consumer inbox (M108) absorbs
    what remains.
  - A broker-side fence (a broker refusing a publish carrying a stale token). No supported broker
    offers one; §3.4 states the window that remains because of it.
  - Change-data-capture relays and therefore Bigtable — the later CDC milestone M107 named.
  - Load balancing between relays beyond what claim contention gives for free (no shard assignment,
    no leader election — §9).
  - The inbox and idempotency bridges' own conditional fallbacks — M108/M109b code, untouched.

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                                                                                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IOutboxStore`                              | `packages/common/src/services/outbox.ts:206-305`                                                                                                                                                                                                                                             | `append`, `scanPending`, `failedKeys`, `markSent`, `markFailure`, `release`, `stats`, `purge`, `verify`. No claim. `@since 0.9.0` — 0.9.0 is not cut (`CHANGELOG.md:7` is `[Unreleased]`, kernel at `0.8.0`), so reshaping it is not a released-API break                                                                                                                      |
| `OutboxRecord`                              | `packages/common/src/services/outbox.ts:52-101`                                                                                                                                                                                                                                              | JSON-scalar fields; `sentBy?` is written by `markSent` and read by no code except the overlap classifier below                                                                                                                                                                                                                                                                 |
| `OutboxTransition`                          | `packages/common/src/services/outbox.ts:127-153`                                                                                                                                                                                                                                             | `applied` / `missing` / `not-pending { status, sentBy? }` / `not-failed { status }`                                                                                                                                                                                                                                                                                            |
| Relay sweep                                 | `packages/messaging-plugin/src/outbox/relay.ts:198-205, 265-387, 400-455`                                                                                                                                                                                                                    | `stopReason` reserves `publishTimeoutMs + storeTimeoutMs`; `examine` checks blocked/cap → backoff → decode → publish → `markSent`; an undecodable row goes through `markFailure` with `status: 'failed'`; no claim of any kind                                                                                                                                                 |
| Overlap classification                      | `packages/messaging-plugin/src/outbox/relay.ts:237-260`                                                                                                                                                                                                                                      | `overlapKind` reads `transition.sentBy` to choose `scheduled` / `dispatch` / `stale` — the ONLY reader of `OutboxTransition.sentBy`                                                                                                                                                                                                                                            |
| `dispatch()` runs outside any lock          | `packages/messaging-plugin/src/outbox/outbox-service.ts:223-244`                                                                                                                                                                                                                             | a per-process single-flight only; every replica's dispatch sweep runs concurrently with every other replica's sweeps today                                                                                                                                                                                                                                                     |
| Scheduled relay                             | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:800-806`                                                                                                                                                                                                                           | `scheduler.every(relayJobName, intervalMs, …)`; nothing else coordinates relays                                                                                                                                                                                                                                                                                                |
| `IScheduler` / `IDistributedLock`           | `packages/common/src/services/scheduler.ts:83`; `packages/scheduler-plugin/src/interfaces/index.ts:25-44`                                                                                                                                                                                    | `IScheduler` exposes no lock accessor; `IDistributedLock` (`acquire(key, ttlMs) → token \| null`, `release(key, token)`) lives in `scheduler-plugin`, carries no epoch, and is unreachable from `messaging-plugin` under §2.2                                                                                                                                                  |
| `IUnitOfWork`                               | `packages/database-plugin/src/interfaces/index.ts:198-209`                                                                                                                                                                                                                                   | `getRepository` only — no raw query, no lock option                                                                                                                                                                                                                                                                                                                            |
| `IDatabaseService.query`                    | `packages/database-plugin/src/interfaces/index.ts:247-256`                                                                                                                                                                                                                                   | raw SQL OUTSIDE any transaction only; cannot hold a row lock across a publish                                                                                                                                                                                                                                                                                                  |
| `IDataSource.updateWhere` / `deleteWhere`   | `packages/common/src/services/database.ts:256-284`                                                                                                                                                                                                                                           | optional permanently; omitted only by deferred-write TRANSACTION sources                                                                                                                                                                                                                                                                                                       |
| `WritePrecondition`                         | `packages/common/src/services/write-precondition.ts:17, 103-128`                                                                                                                                                                                                                             | non-empty equality map of strings and FINITE numbers; `null`, booleans and comparisons are refused — so a claim must compare an always-present number, never `IS NULL` or `<`                                                                                                                                                                                                  |
| Native `updateWhere`, outside a transaction | memory `memory-adapter.ts:710-725`; Prisma `prisma-adapter.ts:886-906`; Drizzle `drizzle-adapter.ts:777`; Mongo `mongo-data-source.ts:296`; DynamoDB `dynamo-data-source.ts:311-352`; Cosmos `cosmos-data-source.ts:376-411, 563`; D1 `cloudflare-plugin/src/database/d1-data-source.ts:247` | every outbox-capable backend implements it. Memory checks and writes in one synchronous turn; Prisma is one `update` with `AND: [where]` (P2025 → `null`); DynamoDB is one `UpdateItem` with `attribute_exists(pk) AND …` (no ghost item); Cosmos re-reads and re-evaluates the predicate every round, `IfMatch` on `_etag`, 3 rounds then `CosmosConcurrentModificationError` |
| `BaseRepository.updateWhere`                | `packages/database-plugin/src/repositories/base-repository.ts:116-151`                                                                                                                                                                                                                       | always present; a source lacking the member rejects `UnsupportedQueryFeatureError('conditional-write')` before any I/O                                                                                                                                                                                                                                                         |
| Bridge transitions                          | `packages/database-plugin/src/outbox/database-outbox-store.ts:272-301`                                                                                                                                                                                                                       | native conditional write, classifying re-read, 3 bounded rounds, and a read-then-write fallback when the source answers `unsupported`                                                                                                                                                                                                                                          |
| Bridge `verify()`                           | `packages/database-plugin/src/outbox/database-outbox-store.ts:341-355`                                                                                                                                                                                                                       | `scanPending(undefined, 1)` then a transactional read; reasons from `unavailableReason` (`:146-158`)                                                                                                                                                                                                                                                                           |
| `conditionalUpdate` / `conditionalDelete`   | `packages/database-plugin/src/repositories/conditional-write.ts:21-60`                                                                                                                                                                                                                       | `applied` / `not-matched` / `unsupported`; only the named `conditional-write` refusal maps to `unsupported`                                                                                                                                                                                                                                                                    |
| Health reasons                              | `packages/messaging-plugin/src/outbox/outbox-health.ts:44-50, 156`                                                                                                                                                                                                                           | `scheduled-overlap` is set from `OutboxInstanceSignals.scheduledOverlap` (`outbox-service.ts:65-74, 167-180`)                                                                                                                                                                                                                                                                  |
| Metrics                                     | `packages/messaging-plugin/src/outbox/outbox-collector.ts:45-58, 172-176`                                                                                                                                                                                                                    | `outbox_overlaps_total` labelled `origin` with `'scheduled' \| 'dispatch' \| 'stale'`                                                                                                                                                                                                                                                                                          |
| Option validation                           | `packages/messaging-plugin/src/outbox/options.ts:113-196`                                                                                                                                                                                                                                    | integers only, `NaN`/fractions refused by name; `publishTimeoutMs + storeTimeoutMs > sweepDeadlineMs` refused                                                                                                                                                                                                                                                                  |
| Unit-test fixtures                          | `packages/messaging-plugin/test/fixtures/outbox.ts:1-10, 200`                                                                                                                                                                                                                                | the relay tests drive the REAL bridge over a memory `DatabaseService` with separate manual wall and monotonic clocks; `FaultStore` wraps a store and injects faults at a named call                                                                                                                                                                                            |
| DDL fixtures                                | `packages/database-plugin/test/fixtures/outbox-postgres.sql`, `outbox-sqlite.sql`, `outbox-postgres.ts`; gate `packages/messaging-plugin/test/unit/outbox/readme-ddl.test.ts:20-41`                                                                                                          | both READMEs embed the fixture text verbatim and the gate compares them                                                                                                                                                                                                                                                                                                        |
| Prior art                                   | `ROADMAP.md` M107b section (researched 2026-10-10)                                                                                                                                                                                                                                           | MassTransit claims with `FOR UPDATE SKIP LOCKED` inside the dispatch transaction; Wolverine elects a leader with advisory locks; CAP's storage lock is off by default; none promises more than at-least-once. Cited from the ROADMAP's research, not re-verified here                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                                              |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| C1 | ROADMAP M107b "Arm 1": a relay claims rows inside a transaction with `SKIP LOCKED`                                                                                                                    | Not built. `IUnitOfWork` has no raw query and no lock option (§1), so it needs a `NormalizedQuery` widening that Prisma's builder, MongoDB, DynamoDB, Cosmos and D1 cannot honour. It also gives no stronger fence: a paused relay's session is killed by the server, its lock released, and it can still publish on waking — the same window §3.4 bounds. It holds a pooled connection and an open transaction across every broker call. | ROADMAP M107b section: the two-arm scope replaced by the one claim protocol, with these reasons        |
| C2 | ROADMAP M107b "Arm 2": an epoch "that increases with every lock hand-off"                                                                                                                             | Not buildable: the outbox cannot observe the lock (`IScheduler` has no accessor; `IDistributedLock` is in `scheduler-plugin` and has no epoch). The fence lives in the row (§3.1).                                                                                                                                                                                                                                                        | same ROADMAP edit                                                                                      |
| C3 | ROADMAP M107b: D1, DynamoDB, Cosmos and Bigtable "defer writes to commit", so they need a different arm                                                                                               | They defer only inside a transaction. Every relay write runs outside one through `#repo()` (`database-outbox-store.ts:181-183`), where every supported backend has a native `updateWhere` (§1). Bigtable stays refused by M107's own reason.                                                                                                                                                                                              | same ROADMAP edit                                                                                      |
| C4 | messaging README "One relay per cluster needs a SHARED scheduler lock" and the `sweepDeadlineMs ≤ distributedLock.ttlMs − 10 000` rule (README:1182-1199, `OutboxRelayOptions.sweepDeadlineMs` JSDoc) | Superseded: several relays are safe (§3.6). A shared lock now only saves redundant scans; the TTL rule is no longer a correctness requirement.                                                                                                                                                                                                                                                                                            | messaging README section rewritten; the `sweepDeadlineMs` JSDoc; PUBLIC_API "Overlap detection" bullet |
| C5 | messaging README and PUBLIC_API: on DynamoDB "a stale GSI read can publish a row again and report a false overlap"                                                                                    | Superseded: the claim is a conditional write against the base item, so a stale GSI page can no longer lead to a publish (§3.2). The DynamoDB paragraph is replaced by that statement, marked as from AWS's documented model and exercised against DynamoDB Local (§12).                                                                                                                                                                   | same two sites                                                                                         |
| C6 | messaging README "The promise": "The sweep deadline is a time bound against the lock's TTL, not fencing"                                                                                              | Replaced by the fenced promise and its one stated window (§3.9)                                                                                                                                                                                                                                                                                                                                                                           | README "The promise" and crash table; `IOutbox` JSDoc; PUBLIC_API                                      |
| C7 | database README "When the source lacks conditional support, the two-call fallback retains the stale-overwrite race" (README:180-184)                                                                  | The fallback is deleted (§3.7); such a store is refused at startup                                                                                                                                                                                                                                                                                                                                                                        | database README transitions paragraph and verdict table; PUBLIC_API outbox-store section               |

## 3. Design decisions

### 3.1 The claim: a per-row lease taken by compare-and-set

- **Decision:** every outbox row carries two always-present numbers:
  - `claimVersion` — starts at `0` at `append`; increased by exactly one by every successful claim
    and by nothing else, so it never returns to an earlier value (no ABA). **Range and storage
    (corrected at implementation, Codex probe 2026-10-10):** a valid stored version is an integer in
    `[0, Number.MAX_SAFE_INTEGER - 1]` — the upper bound is one below the safe maximum so the
    incremented value the relay sends is still exact. Every backend must store that whole range:
    PostgreSQL `bigint` (an `integer` column refused `2147483647 → 2147483648` with SQLSTATE 22003
    through the Drizzle conditional write, leaving the row unchanged), SQLite/D1 `INTEGER` (64-bit
    already), Drizzle `bigint(…, { mode: 'number' })`, and the JSON-number backends as they are.
    **Exhaustion** is a stored value at `MAX_SAFE_INTEGER` (or anything outside the range): the
    relay never computes an increment for it — it is an invalid claim field, poisoned through
    `markInvalid` (§3.5) and released by an operator like any `invalid-row`. Reaching it honestly
    takes 2^53 claims of one row, so in practice it is reachable only by an edit.
  - `leaseUntil` — epoch milliseconds before which another relay must not take the row; `0` when
    unclaimed. Written by `claim`; reset to `0` by `markFailure`, `markInvalid` and
    `release('retry')`.

  `IOutboxStore.claim(id, { claimVersion, leaseUntil })` writes
  `{ claimVersion: claimVersion + 1, leaseUntil }` only where
  `{ kind, status: 'pending', claimVersion }` still holds, and answers an `OutboxTransition`:
  `applied` (the caller now holds version `claimVersion + 1`), `missing`, `not-pending { status }`,
  or `claim-lost` (still pending, version moved — another relay claimed it first).

  `markSent` and `markFailure` gain a required `claimVersion` (the version the caller holds) and
  write only where `{ kind, status: 'pending', claimVersion }` holds; a pending row at another
  version answers `claim-lost` and nothing is written.
- **Why:** an equality predicate on a monotonic number is the one compare-and-set the portable
  `WritePrecondition` can express on every backend — it refuses `null` and comparisons (§1), so
  "unclaimed" cannot be `leaseUntil IS NULL` and "expired" cannot be `leaseUntil < now`. Expiry is
  therefore decided by the relay from the row it read, and the version in the predicate makes that
  decision safe: if the row moved since the read, the claim misses.
- **Test home:** `packages/database-plugin/test/unit/outbox/outbox-store-ops.test.ts` (claim at the
  read version applies and increments; a stale version answers `claim-lost`; a non-pending row
  answers `not-pending`; a guarded `markSent`/`markFailure` at another version writes nothing);
  `packages/database-plugin/test/integration/outbox-store-real.test.ts` (eight concurrent claims of
  one row at one version on real PostgreSQL: exactly one `applied`).

### 3.2 The relay's examine order

- **Decision:** `examine` runs, per row, in this order:
  1. Blocked key / `capReached` — unchanged (M107 §3.6).
  2. Backoff (`availableAt > now`) — unchanged: skip, and block a keyed row's key.
  3. **Claim fields valid?** `claimVersion` an integer in `[0, MAX_SAFE_INTEGER − 1]` (§3.1),
     `leaseUntil` a safe integer `≥ 0` and not beyond `now + MAX_CLAIM_HORIZON_MS` (§3.10, A1).
     Invalid → `markInvalid` (§3.5).
  4. **Held elsewhere?** `now < leaseUntil + maxClockSkewMs` → skip, and block a keyed row's key.
     This includes this instance's own unexpired claim from an earlier sweep.
  5. Decode — unchanged; undecodable → `markInvalid`.
  6. **Claim** at the read version, bounded by `storeTimeoutMs`, with
     `leaseUntil = now + claimLeaseMs` (`now` read immediately before the call). `claim-lost`, and
     `not-pending` with status `failed`, → skip and block a keyed row's key (an earlier row of the
     key is still unsent). `not-pending` with status `sent` or `discarded`, and `missing`, → skip
     WITHOUT blocking: the row is settled, so a later row of its key may go — blocking there would
     stall a hot key behind every stale page under several relays. A rejected or expired claim →
     block the key, end the sweep (`store-failure`), exactly as a rejected status write does.
  7. `attempted += 1` (the publish budget counts claimed rows and poisoned rows, as before).
  8. **The fence** (§3.4).
  9. Publish, then `markSent` (success) or `markFailure` (failure) at the claimed version.
- **Why:** blocking a key on a row claimed elsewhere is M107's backoff rule applied to a new reason
  — a later row of that key must not overtake the claimed one — so per-key order among first
  publishes is kept across any number of relays. The claim is a conditional write against the stored
  row, never against what a page showed, so a page read from a stale DynamoDB GSI (C5) or from
  before another relay's claim can never lead to a second publish; it leads to `claim-lost`.
  Claiming after decode means no relay ever holds a claim on a row it cannot publish.
- **Test home:** `packages/messaging-plugin/test/unit/outbox/relay-claim.test.ts` (each step; a
  stale page whose row was claimed meanwhile answers `claim-lost` and blocks the key, and the row's
  later row is not published in that lap; a stale page whose row was SENT meanwhile answers
  `not-pending`, and the later row IS published in that lap; one whose row was poisoned meanwhile
  blocks the key).

### 3.3 Expiry, takeover and the clock

- **Decision:** a row is claimable when `now ≥ leaseUntil + maxClockSkewMs` on the examining relay's
  wall clock (`runtime.now()`). The claim takes it at the read version; a takeover is an ordinary
  claim. `claimLeaseMs` (default 30 000) and `maxClockSkewMs` (default 5 000) are relay options.
  Construction refuses `claimLeaseMs < publishTimeoutMs + 2 × storeTimeoutMs + maxClockSkewMs`, so a
  relay that is not paused always reaches its status write inside its own lease.
- **Why:** expiry must be judged against a time another process wrote, so it is wall-clock, as
  `availableAt` already is; the monotonic clock is per process. `maxClockSkewMs` is the stated
  assumption — the same kind M107 already states for `position` (writers' clocks agree). A takeover
  delay is the cost: a row whose relay crashed after claiming waits up to
  `claimLeaseMs + maxClockSkewMs` (35 s by default) rather than one lap.
- **Test home:** `relay-claim.test.ts` (a lease one millisecond short of expiry plus skew is
  skipped; at expiry plus skew it is taken over; a relay's own unexpired claim is skipped);
  `outbox-options.test.ts` (the relation refused at construction, naming both options).

### 3.4 The fence before the publish, and the window that remains

- **Decision:** after a successful claim and before the publish, the relay re-reads `runtime.now()`
  and publishes only if `now + publishTimeoutMs + storeTimeoutMs + maxClockSkewMs ≤ leaseUntil` —
  room for the publish AND the `markSent` that must follow it. Otherwise it is **fenced**: it
  publishes nothing and writes nothing (the claim expires and another relay takes it), blocks the
  key, reports `overlap('fenced')`, and continues.
- **Why:** a pause between claim and publish is exactly the paused-relay case; the wall clock keeps
  moving through a freeze, so the woken relay sees its lease gone. The margin must cover the status
  write too: with only `publishTimeoutMs` in it, a relay that is NOT paused but whose publish and
  `markSent` both run long could lose the row to a takeover between the two and cause a duplicate
  with no pause at all. With both bounds in it, the fence agrees with §3.3's construction relation:
  the claim call, the publish and the status write all fit in the lease.

  Two windows remain, stated, not implied, and both are duplicates with the same envelope and
  deduplication id, never a loss:
  1. **A pause after the fence check and before the broker receives the publish** can deliver that
     one row after its lease expired — at most one row per relay, never a batch.
  2. **A publish abandoned at `publishTimeoutMs` that the broker accepts late** (M107's existing
     "late publish" crash row): the relay records the failure, which releases the lease, and the row
     is retried after its backoff, so the broker holds two copies.

  No portable broker accepts a fencing token, so nothing closes them (§0).
- **Test home:** `relay-claim.test.ts` — a `FaultStore` whose `claim` advances the relay's wall
  clock past `leaseUntil` before resolving: the relay publishes nothing, writes nothing, and the row
  is taken over once its lease and the skew have passed; the boundary is pinned on both sides (a
  remaining lease of exactly `publishTimeoutMs + storeTimeoutMs + maxClockSkewMs` publishes, one
  millisecond less is fenced); and `outbox-fencing-real.test.ts` (§3.8).

### 3.5 `markInvalid`: poisoning a row nobody can claim

- **Decision:** a row that fails step 3 or step 5 of §3.2 is poisoned through
  `IOutboxStore.markInvalid(id, now)`, which writes
  `{ status: 'failed', lastError: 'invalid-row', availableAt: now, leaseUntil: 0 }` only where
  `{ kind, status: 'pending' }` holds — no version in the predicate. `attempts` is left as stored.
  `markFailure` no longer has an invalid-row path.
- **Why:** an undecodable row is never claimed (§3.2 claims after decode), and a row with unreadable
  claim fields cannot be claimed (the predicate needs a finite number), so no relay can hold a claim
  the status-only guard would overrule; two relays poisoning one row write the same thing. Keeping
  the claim out of this path is what lets an edited `claimVersion` still surface as a loud `failed`
  row instead of a key blocked in silence.
- **Test home:** `outbox-store-ops.test.ts`; `relay-claim.test.ts` (a `claimVersion` of `'x'`, of
  `-1`, of `1.5`, of `Number.MAX_SAFE_INTEGER`, and a `leaseUntil` past the horizon each become
  `failed` with `invalid-row`, and `MAX_SAFE_INTEGER − 1` is claimed normally);
  `relay-blocking.test.ts` (the existing undecodable cases, re-pointed at `markInvalid`).

### 3.6 Several relays, and what the scheduler lock is still for

- **Decision:** no relay coordination beyond the claim. `relay.schedule` is unchanged; every replica
  may sweep every interval, and `dispatch()` sweeps keep running outside any lock. The README states
  that a shared scheduler lock now only saves redundant scans, and that the
  `sweepDeadlineMs ≤ ttlMs − 10 000` rule no longer bears on correctness. The construction relation
  becomes `publishTimeoutMs + 2 × storeTimeoutMs ≤ sweepDeadlineMs` (the claim is a third bounded
  call per row; the defaults, 5 000 + 2 × 5 000 = 15 000, still pass), and `stopReason` reserves the
  same sum.
- **Why:** with a per-row compare-and-set nothing else is needed for safety, and relays contending
  for the head of the pending set spread across rows by losing claims. No shard assignment is added
  (§9).
- **Test home:** `relay-multi.test.ts` (§3.8); `relay-budget.test.ts` (no row starts below the new
  reserve).

### 3.7 The bridge: verify refuses a store that cannot write conditionally; the fallback goes

- **Decision:**
  - `verify()` gains a third step:
    `repo.updateWhere(CLAIM_PROBE_ID, { kind, status: 'pending',
    claimVersion: 0 }, { claimVersion: 1 })`
    on the fixed id `'setu-outbox-claim-probe'`, which no envelope id can equal (envelope ids are
    UUIDs). A `null` answer passes; a rejection with `UnsupportedQueryFeatureError` whose `feature`
    is `'conditional-write'` becomes `OutboxStoreUnavailableError` with the new reason
    `'conditional-writes-unsupported'`; any other rejection keeps M107's classification. Because the
    probe's predicate names `claimVersion`, it also refuses an SQL table created from the M107 DDL,
    which lacks the column: Drizzle refuses a column its table definition does not map, and the
    database refuses one the table does not have — both `'entity-unavailable'`, at startup rather
    than at the first claim.
  - `#transition` loses its `unsupported` fallback: after `verify`, an `unsupported` answer can only
    mean a store driven before `onInit`, which the outbox never does, so it throws the same
    `OutboxStoreUnavailableError` with reason `'conditional-writes-unsupported'` — one owner for
    that refusal. The bounded three-round classifying loop stays (Cosmos can miss on `_etag` and
    re-match).
  - `markSent` with `deleteNow` (`retainSentMs: 0`) uses `conditionalDelete` with the same
    claim-guarded predicate.
  - `claim`, `markSent` and `markFailure` put `claimVersion` in the predicate; a miss is re-read and
    classified: missing → `missing`; not pending → `not-pending { status }`; pending at another
    version → `claim-lost`; pending at the expected version → another round.
  - `release('retry')` writes `leaseUntil: 0` with `status`, `attempts` and `availableAt`;
    `release('discard')` is unchanged. Neither touches `claimVersion`.
  - `toRow`/`fromRow` treat `claimVersion` and `leaseUntil` as required fields.
- **Why:** a store without a native conditional write could only claim by read-then-write, which is
  no claim at all; refusing it at startup by name is the M52c binding-guard shape and is what the
  ROADMAP asked for ("a store capability, refused by name"). Deleting the fallback also removes
  M107's residual stale-overwrite window for good.
- **Test home:** `packages/database-plugin/test/unit/outbox/outbox-verify.test.ts` (a source without
  `updateWhere` is refused with the new reason; the probe writes nothing on memory; a Drizzle table
  definition without `claimVersion` is refused as `'entity-unavailable'`);
  `outbox-store-real.test.ts` (a real PostgreSQL table built from the M107 DDL is refused at
  `verify()`); `outbox-store-ops.test.ts` (each classification; release resets the lease and keeps
  the version); `outbox-store-contract.test.ts` (the contract extended with the claim semantics).

### 3.8 The real-backend proofs

- **Decision:** a new `packages/messaging-plugin/test/integration/outbox-fencing-real.test.ts`, one
  table over PostgreSQL through Drizzle (`OUTBOX_POSTGRES_URL`), a MongoDB replica set
  (`MONGODB_RS_URI`) and DynamoDB Local with the outbox GSI (`DYNAMODB_ENDPOINT`), each guarded with
  `ignore:` on its variable (never an early return). Two cases per backend:
  1. **Paused relay fenced.** Two `OutboxService` instances share one real store, each on its own
     manual wall clock. R1's store is a `FaultStore` whose `claim` applies for real, then advances
     both wall clocks past `leaseUntil + maxClockSkewMs` and runs R2's whole sweep before resolving.
     Assert: R2 published the row once and marked it `sent`; R1 published nothing and wrote nothing;
     R1 reported `fenced`. The freeze is modelled by moving the wall clock across the claim→publish
     gap, because a real freeze cannot be placed at that point deterministically; the claims and
     transitions are real.
  2. **N relays drain one outbox.** Four `OutboxService` instances on the real runtime sweep
     concurrently, in loops, until 200 rows over 10 ordering keys are all `sent`, publishing through
     a recording broker that yields between calls. Assert: each envelope id was published exactly
     once by the relays (broker redelivery is excluded by construction — the recorder is the
     broker); and for every key the first publishes follow `position` order.

  D1 gets both cases at unit level over `SqliteD1` (the real SQLite engine) in
  `outbox-workers.test.ts`. Cosmos gets case 2 in the local-only `outbox-backends-real.test.ts`
  emulator block.
- **Why:** the claim is only as good as each backend's compare-and-set, which no fake can prove
  (M53's thesis); the existing CI services already cover the three, so CI gains no service.
- **Test home:** as named. `test/apps-gate.test.ts` already pins all three variables in the
  workflows (`:26-31`, `:351`, `:715-732`), so dropping a service or variable fails that gate rather
  than silently skipping the new file; no pin changes.

### 3.9 The promise, restated

- **Decision:** README "The promise", the `IOutbox` JSDoc and PUBLIC_API state: at-least-once
  delivery of every committed row; at most one relay holds a claim on a row at a time, provided the
  relays' wall clocks agree within `relay.maxClockSkewMs`; a relay starts a publish only while it
  holds the claim with room for the publish and its status write, and the two windows of §3.4 (a
  pause after the fence check; a publish the broker accepts after it was abandoned) are the only
  ways a row reaches the broker twice from the relays; per-key order among first publishes across
  any number of relays, under M107's two existing conditions. Crash table changes:
  - "after publish, before the status write" and "the status write rejects after a successful
    publish" are republished after the claim expires (up to `claimLeaseMs + maxClockSkewMs`), not at
    the next lap;
  - "the application stops mid-sweep": a row whose publish failed because of the shutdown keeps its
    claim (a failure while closing writes nothing, M107 §3.7), so it is retried by another process
    only once that claim expires;
  - new: "a relay pauses past its claim" — fenced, publishes nothing.
- **Why:** a promise stated once and nowhere stronger is M107 §3.13's rule.
- **Test home:** `outbox-crash.test.ts` (the two changed rows assert the lease delay with the manual
  wall clock); `outbox-plugin.test.ts` (a publish rejected after `closing` leaves the claim in place
  and writes no attempt).

### 3.10 Signals: `relay-overlap`, and the overlap kinds

- **Decision:**
  - `OutboxRelayObserver.overlap(kind)` takes `'fenced' | 'claim-lost' | 'duplicate'`: `fenced`
    (§3.4); `claim-lost` — a `markSent` or `markFailure` answered `claim-lost`, so another relay
    took over a row this one held (after a publish, a duplicate is likely); `duplicate` — a
    `markSent` found the row `sent`, so this relay's publish was a second one. A claim LOST AT CLAIM
    TIME is contention, not an overlap, and is not reported — no counter, metric or result field
    carries it. The contention ratio §8 asks review to see is counted by the tests' own store
    wrapper, not by shipped code.
  - `OutboxTransition`'s `not-pending.sentBy` is removed: `overlapKind`, its only reader, is
    deleted, and `duplicate` needs only `status === 'sent'`. The `sentBy` COLUMN stays — it is an
    operator diagnostic like `lastError`, documented as such.
  - The health reason `scheduled-overlap` becomes `relay-overlap`: this instance reported any of the
    three kinds inside `health.overlapWindowMs` (option name kept; JSDoc re-worded). The metric
    `outbox_overlaps_total` keeps its name; its label `origin` becomes `kind`.
  - `retainSentMs: 0` still disables `duplicate` (a deleted row reads as `missing`); `fenced` and
    `claim-lost` still work.
  - `MAX_CLAIM_HORIZON_MS` = the largest legal `claimLeaseMs` plus the largest legal
    `maxClockSkewMs` (3 600 000 + 60 000). It is a constant, not derived from this relay's options,
    so replicas running different lease settings during a rollout never poison each other's live
    claims.
- **Why:** "two scheduled sweeps overlapped" is no longer evidence of a misconfigured lock — under
  claims it is harmless. What an operator needs is "a relay paused past its lease or found a
  duplicate", which is what all three kinds mean.
- **Test home:** `outbox-overlap.test.ts` (rewritten: each kind, the window, `retainSentMs: 0`);
  `outbox-health.test.ts`; `outbox-collector.test.ts` (the `kind` label).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — every changed member is on surface that first ships in 0.9.0,
which is not cut (§1).

| Exported symbol                                                                           | Kind         | Consumer / real code path that READS it                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OutboxRecord.claimVersion` (common)                                                      | field        | the relay's step 3 and the claim predicate (`relay.ts`); the bridge's `fromRow`                                                                                                                     |
| `OutboxRecord.leaseUntil` (common)                                                        | field        | the relay's steps 3–4 and the fence (`relay.ts`)                                                                                                                                                    |
| `IOutboxStore.claim` (common)                                                             | method       | `relay.ts` step 6; implemented by `DatabaseOutboxStore`                                                                                                                                             |
| `IOutboxStore.markInvalid` (common)                                                       | method       | `relay.ts` §3.5; implemented by `DatabaseOutboxStore`                                                                                                                                               |
| `markSent`/`markFailure` `claimVersion`                                                   | parameter    | the bridge's predicate                                                                                                                                                                              |
| `OutboxTransition` `claim-lost` (common)                                                  | union arm    | `relay.ts` (blocks the key; `overlap('claim-lost')` on a status write)                                                                                                                              |
| `OutboxStoreUnavailableError.reason` `'conditional-writes-unsupported'` (database-plugin) | union member | thrown by `verify()` and by `#transition`; the messaging plugin propagates it unread (`start()` rejects with it), so its reader is an application switching on `reason`, as for M107's four reasons |
| `OutboxRelayOptions.claimLeaseMs` (messaging-plugin)                                      | option       | `resolveOutboxOptions` → the claim's `leaseUntil` and the fence                                                                                                                                     |
| `OutboxRelayOptions.maxClockSkewMs` (messaging-plugin)                                    | option       | `resolveOutboxOptions` → steps 4 and 8                                                                                                                                                              |

Removed (unreleased, so a CHANGELOG note in the M107 entry rather than a migration):
`OutboxTransition` `not-pending.sentBy`; the `scheduled-overlap` reason; the `origin` metric label.

### 4.1 Options — every option names its consumer

| Option                   | Consumer                    | Behavior (per implementation)                                                                                                       |
| ------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `relay.claimLeaseMs`     | `relay.ts` claim and fence  | Default 30 000, integer in [1, 3 600 000]; must be ≥ `publishTimeoutMs + 2 × storeTimeoutMs + maxClockSkewMs`. Same on every store. |
| `relay.maxClockSkewMs`   | `relay.ts` steps 4 and 8    | Default 5 000, integer in [0, 60 000]. `0` assumes perfectly agreeing clocks — accepted and documented as unsafe across hosts.      |
| `health.overlapWindowMs` | `outbox-service.ts` signals | Unchanged default 600 000; now windows `relay-overlap`.                                                                             |
| `relay.sweepDeadlineMs`  | `stopReason`, construction  | Unchanged default; the relation now includes the claim call (§3.6).                                                                 |

## 5. Implementation files

| File                                                                                                    | Purpose                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/outbox.ts`                                                                | the record fields, `claim`, `markInvalid`, the `claimVersion` update members, `claim-lost`, `sentBy` removed  |
| `packages/database-plugin/src/outbox/database-outbox-store.ts`                                          | claim, guarded transitions, `markInvalid`, verify step 3, fallback deleted, row mapping                       |
| `packages/database-plugin/src/outbox/errors.ts`                                                         | the new reason and its message (names no row content)                                                         |
| `packages/messaging-plugin/src/outbox/relay.ts`                                                         | the examine order (§3.2), the fence, the overlap kinds, the reserve                                           |
| `packages/messaging-plugin/src/outbox/record-codec.ts`                                                  | `encodeOutboxRecord` writes `claimVersion: 0`, `leaseUntil: 0`; an internal `claimStateOf` validator (step 3) |
| `packages/messaging-plugin/src/outbox/options.ts`                                                       | the two options and both relations                                                                            |
| `packages/messaging-plugin/src/outbox/outbox-service.ts`                                                | `relayOverlap` signal in place of `scheduledOverlap`                                                          |
| `packages/messaging-plugin/src/outbox/outbox-health.ts`                                                 | the `relay-overlap` reason                                                                                    |
| `packages/messaging-plugin/src/outbox/outbox-collector.ts`                                              | the `kind` label                                                                                              |
| `packages/messaging-plugin/src/interfaces/index.ts`                                                     | the two options' JSDoc; `sweepDeadlineMs` and `overlapWindowMs` JSDoc; `IOutbox` promise                      |
| `packages/database-plugin/test/fixtures/outbox-postgres.sql`, `outbox-sqlite.sql`, `outbox-postgres.ts` | `claim_version`/`claimVersion` bigint NOT NULL (64-bit — §3.1), `lease_until`/`leaseUntil` bigint NOT NULL    |
| `packages/database-plugin/test/fixtures/outbox-store.ts`, `outbox-store-contract.ts`                    | `record()` carries the two fields; the contract gains the claim cases a custom store must pass                |
| `packages/messaging-plugin/test/fixtures/outbox.ts`                                                     | `FaultStore` delegates and faults `claim` and `markInvalid`; `countingObserver` records the three kinds       |

No `src/index.ts` barrel changes in any package: every changed symbol is already exported.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                   | src covered                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/outbox/outbox-store-ops.test.ts` (extended)      | `database-outbox-store.ts`              | `claim(id, { claimVersion: number, leaseUntil: number }): Promise<OutboxTransition>` each outcome; guarded `markSent`/`markFailure`; `markInvalid(id, now)`; release resets `leaseUntil`                                                                                                        |
| `database-plugin/test/unit/outbox/outbox-verify.test.ts` (extended)         | `database-outbox-store.ts`, `errors.ts` | a data source without `updateWhere` → `reason: 'conditional-writes-unsupported'`; the probe leaves the store unchanged                                                                                                                                                                          |
| `database-plugin/test/unit/outbox/outbox-store-contract.test.ts` + fixture  | `database-outbox-store.ts`              | the claim contract a custom store must meet: compare-and-set, monotonic version, `claim-lost` classification                                                                                                                                                                                    |
| `database-plugin/test/unit/outbox/outbox-columns.test.ts` (extended)        | `database-outbox-store.ts`              | the two fields round-trip as numbers; a row missing one reads back without it (so the relay's step 3 poisons it)                                                                                                                                                                                |
| `database-plugin/test/integration/outbox-store-real.test.ts` (extended)     | bridge on real PostgreSQL               | eight concurrent claims at one version → exactly one `applied`; a row seeded at `2147483647` claims to `2147483648`, and one at `MAX_SAFE_INTEGER − 1` claims to `MAX_SAFE_INTEGER`, each read back exactly                                                                                     |
| `messaging-plugin/test/unit/outbox/relay-claim.test.ts` (new)               | `relay.ts`, `record-codec.ts`           | §3.2 steps 3–8, §3.3 expiry boundaries, §3.4 fence, §3.5 invalid claim fields                                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/outbox/relay-multi.test.ts` (new)               | `relay.ts`, `outbox-service.ts`         | four services over one memory bridge with interleaving publishes: each id published once; per-key first-publish order                                                                                                                                                                           |
| `messaging-plugin/test/unit/outbox/relay-budget.test.ts` (extended)         | `relay.ts`                              | a hung `claim` ends the sweep at its bound; the new reserve                                                                                                                                                                                                                                     |
| `messaging-plugin/test/unit/outbox/relay-blocking.test.ts` (re-pointed)     | `relay.ts`                              | undecodable rows through `markInvalid`                                                                                                                                                                                                                                                          |
| `messaging-plugin/test/unit/outbox/relay-store-failure.test.ts` (extended)  | `relay.ts`                              | a rejected `claim` blocks the key and ends the sweep; the republish waits for the lease                                                                                                                                                                                                         |
| `messaging-plugin/test/unit/outbox/outbox-overlap.test.ts` (rewritten)      | `outbox-service.ts`, `relay.ts`         | `fenced`, `claim-lost`, `duplicate`; the window; `retainSentMs: 0`                                                                                                                                                                                                                              |
| `messaging-plugin/test/unit/outbox/outbox-health.test.ts` (extended)        | `outbox-health.ts`                      | `relay-overlap`; `scheduled-overlap` no longer produced                                                                                                                                                                                                                                         |
| `messaging-plugin/test/unit/outbox/outbox-collector.test.ts` (extended)     | `outbox-collector.ts`                   | `outbox_overlaps_total{kind}`                                                                                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/outbox/outbox-options.test.ts` (extended)       | `options.ts`                            | both options' ranges and `NaN`/fraction refusals; both relations refused naming the options                                                                                                                                                                                                     |
| `messaging-plugin/test/unit/outbox/record-codec.test.ts` (extended)         | `record-codec.ts`                       | encode writes `0`/`0`; `claimStateOf` accepts and refuses each case                                                                                                                                                                                                                             |
| `messaging-plugin/test/unit/outbox/outbox-crash.test.ts` (extended)         | `relay.ts`                              | the two crash rows whose republish now waits for the lease                                                                                                                                                                                                                                      |
| `messaging-plugin/test/unit/outbox/readme-ddl.test.ts` (unchanged)          | —                                       | the READMEs carry the new fixtures verbatim                                                                                                                                                                                                                                                     |
| `messaging-plugin/test/integration/outbox-fencing-real.test.ts` (new)       | everything above, real backends         | §3.8 cases 1 and 2 on PostgreSQL, a MongoDB replica set, DynamoDB Local; per backend, a row seeded at `2147483647` and one at `MAX_SAFE_INTEGER − 1` claim and read back exactly (MongoDB stores a number past int32 as a double, so this is the case that proves equality still matches there) |
| `messaging-plugin/test/integration/outbox-workers.test.ts` (extended)       | D1 path                                 | §3.8 cases 1 and 2 over `SqliteD1`                                                                                                                                                                                                                                                              |
| `database-plugin/test/unit/outbox-store-conditional.test.ts` (rewritten)    | `database-outbox-store.ts`              | the native-miss classification cases kept, with `claim-lost` added; the fallback cases DELETED with the fallback, replaced by the named refusal                                                                                                                                                 |
| `database-plugin/test/unit/outbox/outbox-discriminator.test.ts` (extended)  | `database-outbox-store.ts`              | `claim` and `markInvalid` never touch a business document carrying `status: 'pending'`                                                                                                                                                                                                          |
| `messaging-plugin/test/unit/outbox/outbox-release.test.ts` (extended)       | `relay.ts`, bridge                      | a retried row is claimable at once (`leaseUntil: 0`) and keeps its `claimVersion`                                                                                                                                                                                                               |
| `messaging-plugin/test/unit/outbox/outbox-retention.test.ts` (extended)     | bridge                                  | `retainSentMs: 0` deletes only at the held version                                                                                                                                                                                                                                              |
| `messaging-plugin/test/unit/outbox/outbox-dispatch.test.ts` (extended)      | `outbox-service.ts`                     | a dispatch sweep and a scheduled sweep of two instances never publish one row twice                                                                                                                                                                                                             |
| `messaging-plugin/test/integration/outbox-plugin.test.ts` (extended)        | plugin, relay                           | §3.9 shutdown row                                                                                                                                                                                                                                                                               |
| `messaging-plugin/test/integration/outbox-real.test.ts` (adjusted)          | real PostgreSQL + RabbitMQ / Redis      | `FAST_BUDGET` gains a short `claimLeaseMs` and `maxClockSkewMs`; the crash case's republish waits for the lease and still yields `[1, 2, 2, 3, 4]`                                                                                                                                              |
| `messaging-plugin/test/integration/inbox-real.test.ts` (adjusted)           | M108's outbox end-to-end case           | its forced re-send must also reset `lease_until`, or the row stays held by the first sweep's claim and is (correctly) not re-sent                                                                                                                                                               |
| `messaging-plugin/test/integration/outbox-backends-real.test.ts` (extended) | Cosmos path                             | §3.8 case 2 on the local-only emulator                                                                                                                                                                                                                                                          |

**Negative controls**, each observed failing and reverted during verification:

1. Remove the fence (§3.4) → `relay-claim` and `outbox-fencing-real` case 1 publish twice.
2. Claim without `claimVersion` in the predicate → `relay-multi` and case 2 publish ids twice.
3. Treat a row held elsewhere as claimable without blocking its key → per-key order fails in
   `relay-multi` (a later row of the key is published while the earlier is claimed).
4. Derive the horizon from this relay's own `claimLeaseMs` → a replica with a shorter lease poisons
   a live claim written by one with a longer lease (`relay-claim`).
5. Keep the read-then-write fallback and skip verify step 3 → a source without `updateWhere` starts
   and `relay-multi` duplicates.
6. Drop `leaseUntil: 0` from `markFailure` → a failed-then-backed-off row stays blocked for the
   whole lease after its backoff ends (`relay-claim`).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m107b-outbox-relay-fencing, never main or develop
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test              # with OUTBOX_POSTGRES_URL, MONGODB_RS_URI, DYNAMODB_ENDPOINT set
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the committed tree
deno task release:verify 0.8.0
```

## 8. Risks & mitigations

- **An extra write per published row** (claim + mark, where M107 had mark only) → measured during
  verification on real PostgreSQL (sweep of 1 000 rows, before and after, interleaved runs) and
  recorded in the PR; no budget is promised, the number is reported.
- **Takeover latency after a relay crash** grows from one lap to `claimLeaseMs + maxClockSkewMs` →
  stated in the crash table; `claimLeaseMs` is configurable down to the relation's floor.
- **Clocks disagreeing by more than `maxClockSkewMs`** let two relays hold one row → stated as the
  promise's condition (§3.9); the duplicate it causes is inside at-least-once.
- **Contention at the head of the pending set** with many relays → each lost claim costs one
  conditional write; `relay-multi` and case 2 record lost-claim counts so a pathological ratio is
  visible in review.
- **Cosmos's three-round bound** could reject a claim under unrelated concurrent writes to the same
  item → it surfaces as `store-failure`, which already ends the sweep with the key blocked.
- **Read load multiplies with replicas.** Without a shared scheduler lock every replica now scans
  the pending set every `intervalMs`, and the README stops calling the shared lock necessary → the
  README says the lock is still the way to keep scans at one per interval, and the verification
  measurement records scan queries per second at one and four relays.
- **Rows written on `develop` before this milestone** carry no claim fields and are poisoned as
  `invalid-row` on first sight → acceptable only because the outbox is unreleased; the CHANGELOG
  M107b entry says so, and the M107 DDL is refused at `verify()` (§3.7) before any such row is read
  on SQL.

## 9. Out of scope

- Exactly-once delivery and a broker-side fence (§0).
- Shard assignment or leader election between relays (Wolverine's model) — no milestone owns it; it
  is a throughput optimisation the claim makes unnecessary for safety.
- Change-data-capture relays and Bigtable — the CDC milestone M107 named.
- The read-then-write fallbacks in the tenant, inbox and idempotency bridges — their milestones'
  code; this plan deletes only the outbox's.
- Renaming `health.overlapWindowMs` — kept to avoid churn on an option whose meaning only widens.

## 10. Design security review (recorded before implementation)

Trust boundary: anyone with write access to the outbox entity can edit any row (M107 §10 A3). The
relay must never crash, spin, leak row content, or block a key silently because of an edited row.

| #  | Threat                                                                                       | Control                                                                                                                                                                                       | Test                                   |
| -- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A1 | `leaseUntil` set far in the future to block a key indefinitely                               | beyond `now + MAX_CLAIM_HORIZON_MS` the row is poisoned (`failed`, loud in health); within the horizon the block lasts at most ~61 minutes and `oldest-pending-age` degrades health meanwhile | `relay-claim.test.ts`                  |
| A2 | `claimVersion` set to a non-number, negative, fractional, unsafe or `MAX_SAFE_INTEGER` value | poisoned through `markInvalid`; never incremented, never used in a predicate                                                                                                                  | `relay-claim.test.ts`                  |
| A3 | `claimVersion` edited while a relay holds the claim                                          | the holder's status write answers `claim-lost` and writes nothing; the row is republished after the lease — a duplicate, inside the promise                                                   | `relay-claim.test.ts`                  |
| A4 | a refusal or log line quoting a row's content                                                | the new reason, error message and overlap kinds are fixed vocabulary; nothing quotes a row value or id                                                                                        | `outbox-verify.test.ts`, `relay-claim` |
| A5 | the verify probe writing into a business entity sharing the outbox's container               | the probe's predicate requires `kind: 'setu-outbox'` and a fixed non-UUID id, so it matches no row and writes nothing                                                                         | `outbox-verify.test.ts`                |
| A6 | a misconfigured `maxClockSkewMs: 0` or a lease below the publish path                        | the relation is refused at construction; `0` skew is accepted and documented as unsafe across hosts                                                                                           | `outbox-options.test.ts`               |

A committed-tree security audit runs before merge, in a fresh context, per
`.roo/skills/security-audit/SKILL.md`, and its record goes in the PR.

## 11. Documentation deliverables

- ROADMAP M107b section (C1–C3) and the Progress row at completion; `CLAUDE.md` status entry.
- messaging README: "The promise", crash table, the lock section (C4), the DynamoDB paragraph (C5),
  the health and metrics tables, the two options.
- database README: the transitions paragraph (C7), the verdict table's new reason, the DDL.
- PUBLIC_API: the outbox store port, the bridge, the messaging outbox section.
- CHANGELOG `[Unreleased]`: an M107b entry, and the M107 entry amended where it names
  `scheduled-overlap`, the `origin` label or the scheduler-lock rule (unreleased text, corrected in
  place). No `docs/upgrading.md` entry: nothing here changes released surface.

## 12. Claims NOT verified at plan time

- DynamoDB evaluates a conditional `UpdateItem` against the item's latest state even when the page
  that led to it came from an eventually consistent GSI — from AWS's documented model; exercised
  against DynamoDB Local by §3.8, which is not the service.
- The MassTransit, Wolverine and CAP descriptions are the ROADMAP's research, not re-read here.
- The claim's cost per row (§8) is unmeasured until verification.
- Cloudflare Workers advances `Date.now()` only across I/O, not during CPU work. The claim and the
  fence check are separated by I/O (the claim itself), so the fence should read a fresh time there,
  but no workerd run of the relay exists (M107 left the D1 binding undriven on workerd, and this
  milestone does not add it).
