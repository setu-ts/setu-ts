# @setu-ts/agent-runs-plugin — durable agent runs

Provides `CAPABILITIES.AGENT_RUNS` (`IAgentRunService`). Install manually; no CLI add arm yet.
Requires runtime and idempotency capabilities and the `ai@^7.0.159` peer. Supply persistent storage.

## Register

```ts
import type { LanguageModel } from 'ai';
import { AgentRunsPlugin, defineAgentRun } from '@setu-ts/agent-runs-plugin';
import { createDatabaseAgentRunStore } from '@setu-ts/database-plugin';
export function runs(model: LanguageModel) {
  return AgentRunsPlugin({
    store: createDatabaseAgentRunStore(),
    definitions: [defineAgentRun({name: 'assistant',version: '1',model: () => model,maxOutputTokens: 1024})],
  });
}
```

Register a database and transactional idempotency store first; missing `transactional` throws
TypeError. Handlers use `start`, `respond`, `decide`, `cancel`, `get`; Workers cron calls `sweep`.
Jobs use `startAs({ tenantId, principalId }, definition, { messages })` (0.13.0): tenant is a
string, principal non-empty or null. No background hook runs; a sweep recovers evicted work. Custom
`IAgentRunService` implementations must add `startAs`.

- Model messages commit before tools. SDK tools have no execution hooks; writes use fenced leases.
- Tools use transactional idempotency: use the supplied unit of work for database writes and stable
  idempotency key for outside calls.
- Approvals have deadlines and single-use decisions; default deciders match the original principal.
  Tenant mismatch is the same 404 as a missing run.
- Definitions are frozen and versioned. Supply `compatibleVersions` for deliberate migrations.
- Reading, streaming and cancelling default to the starting principal; `canAccess` widens it.
- `decide`: 404 unless `canAccess` or `canDecide` passes, 403 when visible but not decidable;
  `reason` is a string of at most 1,024 characters.
- Input messages are `user`/`assistant` text; `system` is refused, tool and approval parts stripped.
- The UI-message log resumes from a `<batch>.<index>.<epoch>` Last-Event-ID; a diverged id gets a
  `data-setu-replay` chunk and a full replay. Idle terminal reconnect returns 204.
- `background(ctx, work)` integrates with host lifetime. `ctx.defer` does not run the agent.

Example: `setu new my-agent --example durable-agent`. See README for schema, limits and options.
Edit loop: `pnpm test:coverage agent-runs-plugin --no-tooling`.
