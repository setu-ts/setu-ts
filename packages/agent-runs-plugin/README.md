# @setu-ts/agent-runs-plugin

Durable agent runs over AI SDK 7. A run persists model responses before tools execute, uses fenced
leases across instances, stores approvals with deadlines, and replays retained UI-message chunks.
The application supplies its model and database. This package owns persistence and recovery.

Install `@setu-ts/agent-runs-plugin`, `ai@^7.0.159`, `@setu-ts/database-plugin` and
`@setu-ts/idempotency-plugin` beside your other Setu packages. The SDK is a required peer, loaded
once at registration with a guarded dynamic import. The supported SDK range is `^7.0.159`.

## Registration

```ts
import type { LanguageModel } from 'ai';
import { AgentRunsPlugin, defineAgentRun } from '@setu-ts/agent-runs-plugin';
import { createDatabaseAgentRunStore } from '@setu-ts/database-plugin';

export function runs(model: LanguageModel) {
  return AgentRunsPlugin({
    store: createDatabaseAgentRunStore(),
    definitions: [defineAgentRun({
      name: 'assistant', version: '1', model: () => model, maxOutputTokens: 1024,
    })],
  });
}
```

Register `RuntimePlugin`, `DatabasePlugin` and
`IdempotencyPlugin({ transactional: { store: createDatabaseIdempotencyStore(), purge: { schedule: false } } })`
before this plugin. Scheduled idempotency purging instead needs a scheduler. The run plugin provides
`CAPABILITIES.AGENT_RUNS` (`IAgentRunService`); no routes are installed automatically. See the
[complete route guide](https://github.com/setu-ts/setu-ts/blob/main/docs/durable-runs.md) and
[public API](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#durable-agent-runs-setu-tscommon--setu-tsagent-runs-plugin--setu-tsdatabase-plugin).

## Configuration

| Option            | Default  | Meaning                                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `store`           | required | `IAgentRunStore` or registry factory; verified at registration                                 |
| `definitions`     | required | Nonempty definitions with unique names                                                         |
| `leaseMs`         | 30000    | Renew every third of the lease and before each model/tool call; must exceed three skew margins |
| `maxClockSkewMs`  | 5000     | Takeover grace, at most 60000                                                                  |
| `sweepIntervalMs` | 5000     | Zero disables the interval; call `sweep()` from Workers cron                                   |
| `sweepBatch`      | 25       | Limit for each sweep query                                                                     |
| `retentionMs`     | 86400000 | Retain terminal runs and child rows                                                            |
| `flushIntervalMs` | 100      | Chunk batch timer                                                                              |
| `flushChunks`     | 64       | Chunk batch count                                                                              |
| `maxLogBytes`     | 8388608  | Stop retaining text/reasoning deltas beyond this bound; keep structural chunks                 |
| `pollIntervalMs`  | 250      | Cross-instance stream polling                                                                  |
| `maxInputBytes`   | 262144   | UTF-8 JSON input bound; refusal carries 413                                                    |
| `background`      | absent   | Receives `(ctx, work)` for hosts requiring explicit background lifetime                        |

Definitions require `name`, `version`, `model(run)` and `maxOutputTokens`; `maxSteps` defaults to 20
(1–1000). Optional `system`, `tools`, `toolsContext`, `compatibleVersions`, `approval`,
`canAccess(principal, run)` and `timeouts: { modelMs?, toolMs?, toolAttempts? }` are consumed on the
execution and access paths. Model timeouts fail with `execution-failed`. A timed-out tool call stays
`running` and stops renewing its lease; after lease expiry plus `maxClockSkewMs`, the sweep resumes
it. Transactional idempotency replays a committed result or re-runs a rolled-back call; an in-flight
conflict defers to a later sweep. After `toolAttempts` timed-out attempts of the same call (default
3, positive integer, used only with `toolMs`), the run fails with `tool-timeout`. The final
attempt's transaction can still commit after the run fails; there is no abandoned-call commit
marker. Bound outside calls inside the tool itself. `canAccess` governs `get`, `respond` and
`cancel`; by default only the starting principal (or, for a run started without one, anyone in the
tenant) passes, and a refusal is a 404. Models are supplied per call, so tenant quotas and budget
middleware can wrap them using the persisted run identity. Approval policies map tool names to
`true` or an async predicate, with `timeoutMs` default 86400000, maximum 2592000000, and optional
`canDecide(principal, run)`. The default requires matching, defined principal ids. Custom tool
context comes only from that tool's entry in `toolsContext(run, call)`.

## Storage and guarantees

`createDatabaseAgentRunStore({ entities?, database? })` defaults to entities `AgentRun`,
`AgentRunEntry`, `AgentRunChunks`, `AgentRunApproval`. The run row contains identity, input,
version, lease, committed counters, approval ids, tool timeout key/count and status; child rows
contain `runId`, `tenantId` and `seq`. Provision tables/models before starting SQL adapters. Drizzle
needs all four in `drizzleTables`; Prisma needs corresponding models. Use JSON columns for input,
messages, chunks and tool input, a JSON approvalIds column on runs, string toolTimeoutKey and
integer toolTimeouts columns on runs (initially empty and zero), a numeric stepChunkStart column on
entries, 64-bit numeric timestamps, primary keys on `id`, and indexes on run
status/leaseUntil/updatedAt, approval status/deadline and child runId/seq. Child rows also store the
writer's `leaseVersion`; a custom `IAgentRunStore` must return it on each `AgentRunChunkBatch`,
since it is the event-id epoch. A run row the store cannot decode is marked `failed` (`invalid-row`)
by the sweep, and deleted with its children once past retention, so ill-formed rows cannot fill a
sweep batch. `verify()` refuses missing native conditional update/delete support, and runs each
sweep query once: an adapter that cannot serve one is refused at startup with `query-unsupported`.
DynamoDB and Bigtable are refused that way, since they order by one sort key only and the sweep
orders overdue approvals by deadline, then id. Backend query support and the idempotency
transactional store's requirements both apply; this is not a claim that every backend can execute
every query.

Tool database writes through `call.unitOfWork` commit with their idempotency result. Outside API
effects may repeat after a crash or a tool timeout before commit: pass `call.idempotencyKey` to the
outside API. `within` conflicts leave the run for recovery; other idempotency failures fail it. A
tool exception rolls back and becomes a value-free tool error. SDK tool input deltas are not
retained. Truncated logs retain one `data-setu-log-truncated` marker, while connected clients still
receive deltas.

Errors are shared from common: missing/cross-tenant 404, conflicting state 409, forbidden approval
403, repeated decision 409, input bound 413 and unavailable store 503. Served details contain no
provider messages or request values. Definition and lease errors are internal.

## Development

Use `pnpm test:coverage agent-runs-plugin --no-tooling` for the edit loop. Real PostgreSQL store and
process-kill tests are guarded by `AGENT_RUNS_PG_URL`; absent configuration leaves them unexercised.

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `AgentRunsPlugin`         | function  |
| `defineAgentRun`          | function  |
| `VERSION`                 | const     |
| `AgentRunApprovalOptions` | interface |
| `AgentRunContext`         | interface |
| `AgentRunDefinition`      | interface |
| `AgentRunsPluginOptions`  | interface |
| `AgentRunToolCall`        | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.
