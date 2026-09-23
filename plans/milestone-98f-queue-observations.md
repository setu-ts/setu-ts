# Milestone 98f — Queue Attempt, Outcome and Depth Observations

> **Status:** Planning on `docs/m98-capability-diagnostics`. Implementation and fixes belong on
> `feat/m98f-queue-observations`; `main` remains protected.

## 0. Objective & scope

Expose bounded, payload-free observations of actual queue attempts and supported queue depths.
Collection lives at QueueService/runJob settlement boundaries and adapter depth seams; diagnostic
reads never reserve, acknowledge, retry, dead-letter, enumerate, or mutate a job.

- **In scope:** per-instance typed sources, approved queue aliases, ephemeral job aliases, processor
  outcome and durable settlement state, separately scheduled depths, `/v1/queues`, native
  `queues(after, limit)`, tests/docs, and both security gates.
- **NOT this milestone:** job/dead-letter listing, payload/header/error display, retry/purge/replay
  controls, exact depth support for RabbitMQ/SQS, or tenant switching.

Implementation starts from main containing M98d's fixed inspector-support manifest; HealthPlugin
itself remains optional and is not required for queue observations.

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                         | Verified surface / fact                                                                                     |
| ------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `IQueue`                  | `packages/common/src/services/queue.ts:131`                | Only add/process/recurring operations; no listing or dead-letter reads.                                     |
| `ProcessOptions.onFailed` | `packages/common/src/services/queue.ts:84`                 | Runs on final failure before dead-letter and receives raw job/error.                                        |
| `QueueAdapter`            | `packages/queue-plugin/src/adapters/queue-adapter.ts:34`   | Internal reserve/ack/requeue/deadLetter seam; optional `depths(name)`.                                      |
| `runJob`                  | `packages/queue-plugin/src/processors/job-processor.ts:79` | Current outcome notification occurs before awaiting settlement, so it is not durable-settlement proof.      |
| `QueueService`            | `packages/queue-plugin/src/services/queue-service.ts:75`   | Owns polling, in-flight counts, dispatch and adapter access.                                                |
| Depth support             | `packages/queue-plugin/src/adapters/queue-adapter.ts:73`   | Memory/Redis may expose depths; absence means unavailable rather than zero.                                 |
| Named instances           | `packages/queue-plugin/src/plugin/queue-plugin.ts:123`     | Queue plugins can repeat with derived plugin/token names, so one singleton diagnostics provider is invalid. |
| Duplicate providers       | `packages/kernel/src/registry/plugin-resolver.ts:124`      | Two plugins declaring one capability in `provides` are refused; multi providers register at service level.  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                               | Resolution (picked side)                                                                                                                 | Doc deliverable (same PR)                                                                            |
| -- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| C1 | Queue metrics describe a job as settled before the backend settlement promise resolves, while M98f requires explicit settlement truth. | Preserve metric timing for compatibility; add a distinct diagnostics hook after settlement and a `settlement-failed` event on rejection. | Document the distinction in `PUBLIC_API.md`, `ARCHITECTURE.md`, protocol/package docs and changelog. |

## 3. Design decisions

### 3.1 Multi-instance typed sources

- **Decision:** Add `CAPABILITIES.QUEUE_DIAGNOSTICS` (`queue-diagnostics`) and
  `IQueueDiagnosticsSource`. Every QueuePlugin eagerly registers one source with `{ multi: true }`
  but does not claim the token in `provides`, matching the framework's contribution-token pattern
  and avoiding resolver collisions. DiagnosticsPlugin reads all sources once at bootstrap, caps them
  at 16, and serves one fixed `GET /v1/queues?after=N&limit=N` response. No QueuePlugin yields
  `unsupported`; present-but-unconfigured sources report `disabled`. The connector sets the fixed
  authenticated status manifest's `queues` key true; a client seeing false returns a frozen typed
  unsupported batch without sending the queue request.
- **Why:** Named queues remain independently observable without an illegal duplicate provider.
- **Test home:** plugin-resolver/queue multi-instance integration and diagnostics plugin tests.

### 3.2 Exact event and batch contracts

- **Decision:** `QueueSourceAttemptObservation` carries a source-local sequence and the approved
  queue/job aliases, attempt, duration, processor outcome, settlement and age fields below.
  `QueueDiagnosticsSourceBatch` contains one source's state, optional configured instance alias,
  depth coverage, fixed failure category, source-local attempts/depths, next/lost/closed and bounded
  drop counters. `IQueueDiagnosticsSource` exposes exactly:

  ```typescript
  read(after: number, limit?: number): QueueDiagnosticsSourceBatch;
  ```

  The method is synchronous, defaults to 128, throws one fixed value-free `RangeError` unless
  `after` is a non-negative safe integer and `limit` is 1–128, and returns a deeply frozen batch.
  `QueueDiagnosticsSourceStatus` contains a connector-assigned opaque `q<N>` source ID, inspector
  state, optional configured instance alias, depth coverage, and fixed failure category.
  `QueueAttemptObservation` contains only global response sequence, source ID, configured
  `instanceAlias`, approved `queueAlias`, session-local `jobAlias`, attempt, `durationMs`, processor
  outcome (`completed`, `retryable-error`, `terminal-error`), settlement (`acknowledged`,
  `requeued`, `dead-lettered`, `failed`, `unknown`), and monotonic `ageMs`. `QueueDepthObservation`
  contains aliases, non-negative ready/processing/dead counts, scope (`process-local` or
  `shared-backend`), coverage (`complete` or `partial`), and age. `QueueDiagnosticsBatch` carries
  version/instance, one status per retained source, events/depths/next/lost/truncatedSources. A mix
  of enabled, disabled, unavailable and failed named queues therefore remains visible. No extension
  record exists.

  `after`, `next` and `lost` are M98a's committed cursor contract, adopted verbatim rather than
  restated — the same wording M98g and M98h adopt, so one paging model covers every capability. From
  `IDiagnosticsSource.read`/`DiagnosticsBatch`
  (`packages/common/src/services/diagnostics.ts:253-318`): `after` is EXCLUSIVE and `after: 0`
  starts at the oldest retained event; a cursor older than the oldest retained sequence returns the
  oldest retained events and reports the gap in a PER-BATCH `lost`; `next` is the last returned
  sequence, or the REQUESTED cursor when the batch is empty; a cursor beyond the current sequence
  throws the fixed value-free `RangeError`. `lost` counts ring eviction only — `truncatedSources`
  and the §3.4 dropped counter are separate facts and are never folded into it.
- **Why:** Outcome and durable settlement remain separate facts; unavailable depth cannot look like
  zero. Paging that a client cannot reason about is how a queue view comes to claim it showed every
  attempt.
- **Test home:** common DTO tests and protocol exact-key tests, plus paging across eviction —
  overflow the 1,024-event ring, resume from a pre-overflow cursor, and assert no repeated or
  skipped sequence, a per-batch `lost`, an empty batch echoing its cursor, and a beyond-sequence
  cursor throwing.

### 3.3 Observe the authoritative attempt once

- **Decision:** Replace `JobRunnerHooks.onOutcome` with separate guarded internal notifications:
  `onProcessorOutcome` at today's point for metric compatibility and `onAttemptSettled` only after
  the adapter promise resolves. If ack/requeue/deadLetter rejects, emit settlement `failed` and
  rethrow exactly as today. QueueService records start from dispatch and passes the raw job ID only
  to the aliaser; payload, headers, claim token, max-attempt setting, and thrown value are absent
  from observer signatures. Every observer throw is swallowed and reported through the existing
  guarded logger path.
- **Why:** Diagnostics report actual calls without changing retry or settlement behavior.
- **Test home:** `job-processor.test.ts` failure matrix and QueueService callback-count tests.

### 3.4 Aliases and resource bounds

- **Decision:** `QueueDiagnosticsOptions` requires `enabled: true`, an `instanceAlias`, and `queues`
  mapping exact job names to unique aliases. "Safe" is a SHAPE, not secret detection: every alias —
  `instanceAlias` and each queue alias alike — is a non-empty UTF-8 string of 1–64 bytes containing
  no control characters, and queue aliases are unique within the map. The validator never inspects
  an alias for anything else; approving an exact alias IS authorizing its disclosure, so rejecting
  one because it resembles an address or a credential would refuse a legal configuration while
  giving no guarantee about any alias it accepted. This is the rule M98d already states for health
  aliases, spelled identically here so the two cannot drift. Limits: 64 queues/source, 1,024
  events/source, 128 events/read, 4,096-entry LRU raw-ID→`j<N>` map, and 2,048 simultaneously
  observed attempts. Eviction may give a later retry a new alias and is reported by a saturated
  dropped counter. Raw IDs enter only the alias lookup and never an event, callback, log, source
  DTO, or frame.
- **Why:** Correlation is useful within the launch while memory and identity lifetime stay bounded.
- **Test home:** collector stress/eviction/canary tests, plus option-validation tests refusing an
  empty alias, a 65-byte alias, an alias carrying a control character, and a duplicate queue alias,
  and a projection test proving an accepted alias reaches the DTO byte-for-byte.

### 3.5 Depth collection is separate from reads

- **Decision:** `diagnostics.depths` is absent by default and supplies interval (1,000–300,000 ms),
  timeout (1–30,000 ms), and concurrency (1–4). Only approved processor names are queried. One
  immediate bootstrap cycle and one runtime interval update a latest-only map; cycles never overlap
  and unresolved raw promises retain their in-flight slots after reporting timeout. Memory is tagged
  `process-local`, Redis `shared-backend`; RabbitMQ/SQS and injected unsupported implementations
  report unavailable, never zero. Shared-backend depths are never summed across sources/replicas.
- **Why:** Counting has backend cost and consistency limits; connector polling must add none.
- **Test home:** adapter matrix, timeout/non-overlap, and multi-replica presentation tests.

### 3.6 Connector/client projection

- **Decision:** DiagnosticsPlugin merges at most 16 source batches in registration order. Because
  M98b permits one authenticated client session, the handler retains one internal cursor per source,
  drains newly captured source events into a connector-owned bounded merge ring on each queue read,
  and exposes only that ring's public numeric cursor. Source events enter the merge ring already
  minimized; overflow increments `lost`. The client exposes `queues(after, limit)` with the standard
  signed serialized exchange after the authenticated support manifest reports `queues: true`.
  Projectors validate own properties and copy exact fields; source failures become a fixed source
  state without details.
- **Why:** A single cursor remains usable across named queue instances without exposing registry
  tokens.
- **Test home:** merge ordering/loss tests, client tests, real socket e2e.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                             | Kind               | Consumer / real code path that READS it                     |
| ----------------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------- |
| Queue diagnostic outcome/settlement/depth types                                                             | common types       | Queue collector, connector validator, client and devtool.   |
| `QueueSourceAttemptObservation`, `QueueDiagnosticsSourceBatch`                                              | common interfaces  | QueuePlugin source and connector merge input.               |
| `QueueDiagnosticsSourceStatus`, `QueueAttemptObservation`, `QueueDepthObservation`, `QueueDiagnosticsBatch` | common interfaces  | Typed source and devtool queue panel.                       |
| `IQueueDiagnosticsSource`                                                                                   | common interface   | QueuePlugin multi providers and DiagnosticsPlugin consumer. |
| `CAPABILITIES.QUEUE_DIAGNOSTICS`                                                                            | common token       | Multi registration and connector bootstrap drain.           |
| `QueueDiagnosticsOptions`, `QueueDepthDiagnosticsOptions`                                                   | queue option types | QueuePlugin validates and builds collectors.                |
| `IDiagnosticsClient.queues`                                                                                 | interface method   | Native devtool consumes the queue batch.                    |

`IQueueDiagnosticsSource.read(after, limit?)` has the exact synchronous contract in §3.2.
`IDiagnosticsClient.queues(after: number, limit?: number): Promise<QueueDiagnosticsBatch>` applies
the same cursor bounds and negotiates support before sending the operation.

Collectors, alias maps, merge ring, settlement hooks and depth scheduler remain internal.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                 | Behavior (per implementation)                                       |
| --------------------------- | ------------------------ | ------------------------------------------------------------------- |
| `diagnostics.enabled: true` | QueuePlugin              | Activates attempt capture; absence registers inert source.          |
| `diagnostics.instanceAlias` | source/projector         | Safe label for one QueuePlugin instance; never derives from `name`. |
| `diagnostics.queues`        | attempt/depth collectors | Exact job-name allowlist and display aliases.                       |
| `diagnostics.depths.*`      | depth scheduler          | Controls independently bounded backend count work.                  |

## 5. Implementation files

| File                                                                                                                           | Purpose                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`, `src/tokens.ts`, `src/index.ts`                                                 | Queue DTO/source contracts, token, exports.                     |
| `packages/queue-plugin/src/interfaces/index.ts`, `src/diagnostics/queue-observation-collector.ts`                              | Options, event/depth collector, aliaser, source.                |
| `packages/queue-plugin/src/processors/job-processor.ts`, `src/services/queue-service.ts`                                       | Processor/settlement hooks and scheduled supported depth reads. |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`, `src/index.ts`                                                             | Per-instance source registration, adapter scope and lifecycle.  |
| `packages/diagnostics-plugin/src/interfaces/index.ts`, `src/plugin/diagnostics-plugin.ts`                                      | Client method, fixed support key and multi-source resolution.   |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`, `src/transport/connector-handler.ts`, `src/client/client.ts`           | Queue target, bounded merge, projection and client.             |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md` | Semantics, adapter matrix, security evidence.                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                  | src covered                     | Key assertions (and the signature each call type-checks against)                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/diagnostics-contract.test.ts`, `test/unit/tokens.test.ts`, `test/unit/index.test.ts`                                            | common diagnostics/tokens/index | Source/final DTO signatures, exports and legal token.                                                                |
| `packages/queue-plugin/test/unit/queue-diagnostics-options.test.ts`, `test/unit/queue-observation-collector.test.ts`                                       | interfaces/collector            | Bounds, aliases, source read signature, ring/loss/LRU, canary exclusion, disabled mode.                              |
| `packages/queue-plugin/test/unit/job-processor.test.ts`                                                                                                    | job-processor                   | Completed/retry/dead/settlement-failed ordering; unchanged adapter and callback calls.                               |
| `packages/queue-plugin/test/unit/queue-service.test.ts`                                                                                                    | queue-service                   | Durations, depth schedule, no overlap, zero added reserve/settlement calls.                                          |
| `packages/queue-plugin/test/unit/memory-queue.test.ts`, `test/unit/redis-queue.test.ts`, `test/unit/rabbitmq-queue.test.ts`, `test/unit/sqs-queue.test.ts` | queue-service/adapters          | Support matrix: real counts where supported, unavailable elsewhere, correct scope.                                   |
| `packages/queue-plugin/test/unit/queue-plugin.test.ts`, `test/unit/barrel-exports.test.ts`                                                                 | plugin/index                    | Multi sources, named instances, lifecycle cleanup, exports.                                                          |
| `packages/diagnostics-plugin/test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, `test/unit/plugin.test.ts`                                | protocol/connector/plugin       | Support key, canonical query, merge/loss, auth-before-read, exact projection and partial source failure.             |
| `packages/diagnostics-plugin/test/unit/client.test.ts`, `test/index.test.ts`                                                                               | client/interfaces               | False-key no-request, `queues()` argument validation, MAC/DTO/instance checks, close/deadline.                       |
| `packages/diagnostics-plugin/test/e2e/queue-observations.test.ts`                                                                                          | all paths                       | Real socket and jobs; useful attempts/depths; payload/header/id/token/error canaries absent; app behavior identical. |

## 7. Verification gates

```bash
git branch --show-current   # feat/m98f-queue-observations during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Require 90% per-file coverage from the ANSI-stripped table, then on the committed tree run
`deno task publish:check` and `deno task release:verify <version>`. The implementation PR records
the reviewed revision, adapter/runtime evidence, findings and dispositions before M98f completes.

## 8. Risks & mitigations

- An observer changes settlement: guard it and assert identical processor/adapter calls with
  absent/throwing/full collectors.
- Outcome is mistaken for durable settlement: distinct fields and post-await settlement events.
- Depth polling overloads a backend: explicit opt-in, approved names, low concurrency, no
  overlapping raw promises.
- Shared counts are double-counted: tag scope and prohibit aggregation across replicas.
- Identity/payload leakage: alias before buffering and omit payload/header/error/claim fields from
  observer signatures.

## 9. Out of scope

- Listing, viewing, retrying, deleting, purging or replaying jobs and dead letters.
- Management-API depth support for RabbitMQ/SQS.
- Durable history or stable aliases across launches.

## 10. Design security review — completed before implementation

**Reviewed flow:** worker reserve → attempt start → existing processor → existing settlement call →
primitive-only guarded observer → per-source ring/latest depth map → connector merge → exact signed
projection → native client. Minimization and aliasing occur before any diagnostics buffer.

**Approved budgets:** 16 sources, 64 queues/source, 1,024 source events, 1,024 connector merge
events, 128/read, 4,096 aliases/source, 2,048 observed in-flight attempts, four depth calls/source,
one non-overlapping cycle, and 256 KiB/frame. All intervals and maps clear on failed startup/close.

| Finding                                   | Resolution in this plan                                                                         |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Existing `onOutcome` precedes settlement. | New post-await hook reports settlement; metric hook stays compatible.                           |
| `reserve` could be abused as inspection.  | Diagnostics reads never touch adapters; only explicit scheduler calls `depths`.                 |
| Named instances collide on one token.     | Eager multi-provider registration with no duplicate `provides` claim.                           |
| Raw job/error data could enter capture.   | Observer API cannot accept payload, headers, errors or claim tokens; ID is immediately aliased. |

The implementation audit covers all adapters' supported claims, failed settlements, sustained
attempts, hung depth calls, overflow and teardown. It plants canaries in payloads, headers, raw IDs,
claim tokens, credentials and exceptions at collector/frame/client/error/log layers, preserves
positive outcomes/depths, and repeats every M98b authentication, replay, origin, version, instance
and mutation refusal for `/v1/queues`.
