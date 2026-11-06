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

Register a database and transactional idempotency store before this plugin. Resolve the service in
handlers: `start`, `respond`, `decide`, `cancel`, `get`; call `sweep` from cron on Workers.

- Model messages commit before tool execution. Tools sent to the SDK have no execution hooks.
- Every holder write is fenced by a lease version; renewal runs before each model/tool call.
- Tools execute in transactional idempotency. Use the supplied unit of work for database writes and
  the stable idempotency key for outside API calls.
- Approval rows have deadlines and single-use decisions. Default decision authorization requires the
  original, defined principal. Tenant mismatch returns the same 404 as a missing run.
- Definitions are frozen and versioned. Supply `compatibleVersions` for deliberate migrations.
- The UI-message log supports replay from the Last-Event-ID header; idle terminal reconnect
  returns 204.
- `background(ctx, work)` integrates with host lifetime. `ctx.defer` does not run the agent.

See README for limits, database schema requirements, options and errors. Edit loop:
`pnpm test:coverage agent-runs-plugin --no-tooling`.
