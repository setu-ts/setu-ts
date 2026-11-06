# Durable agent runs

Use durable runs when a model/tool conversation must survive a restart, a human approval or a
browser reconnect. Setu persists one SDK model call at a time and executes tools after its model
entry commits. Applications continue to choose their own model providers and budget middleware. For
model access and tenant quota recipes, see [AI SDK recipes](./ai.md).

## Install and register

```sh
pnpm add @setu-ts/agent-runs-plugin @setu-ts/database-plugin @setu-ts/idempotency-plugin ai@^7.0.159
```

This complete route composition accepts a model chosen by the application. Replace the memory
database with a persistent database and provision the four run entities before production use.
Authenticate and resolve the tenant before these routes; identity comes from the server context.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DatabasePlugin, createDatabaseAgentRunStore, createDatabaseIdempotencyStore } from '@setu-ts/database-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { AgentRunsPlugin, defineAgentRun } from '@setu-ts/agent-runs-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAgentRunService, IRequestContext } from '@setu-ts/common';
import type { LanguageModel } from 'ai';
import { z } from 'zod';

export function createRunsApp(model: LanguageModel) {
  const app = createApplication({plugins: [
    RuntimePlugin(),
    DatabasePlugin({type: 'memory'}),
    IdempotencyPlugin({transactional: {store: createDatabaseIdempotencyStore(),purge: {schedule: false}}}),
    AgentRunsPlugin({store: createDatabaseAgentRunStore(),definitions: [defineAgentRun({
      name: 'assistant',version: '1',model: () => model,maxOutputTokens: 1024,
    })]}),
  ]});
  const runs = (ctx: IRequestContext) => ctx.services.get<IAgentRunService>(CAPABILITIES.AGENT_RUNS);
  const input = z.object({messages: z.array(z.object({role: z.literal('user'),content: z.string()}))});
  app.router.post('/runs',async ctx => {
    const started = await runs(ctx).start(ctx,'assistant',input.parse(await ctx.request.json()));
    return ctx.response.status(202).json(started);
  });
  app.router.get('/runs/:id',async ctx => ctx.response.json(await runs(ctx).get(ctx,ctx.params['id']!)));
  app.router.get('/runs/:id/stream',ctx => runs(ctx).respond(ctx,ctx.params['id']!));
  app.router.post('/runs/:id/approvals/:approval',async ctx => {
    const decision = z.object({approved: z.boolean(),reason: z.string().max(1024).optional()}).parse(await ctx.request.json());
    await runs(ctx).decide(ctx,ctx.params['id']!,ctx.params['approval']!,{approved: decision.approved,...(decision.reason === undefined ? {} : {reason: decision.reason})});
    return runs(ctx).respond(ctx,ctx.params['id']!);
  });
  app.router.post('/runs/:id/cancel',async ctx => {
    await runs(ctx).cancel(ctx,ctx.params['id']!);
    return ctx.response.status(202).json({accepted: true});
  });
  return app;
}
```

The run service installs no routes; your middleware decides who may start runs. Reading, streaming
and cancelling a run is limited to the principal that started it, or to anyone in the tenant for a
run started without a principal. A definition's `canAccess(principal, run)` replaces that rule, for
example to let a support role read every run in the tenant. Every refusal, like another tenant's
run, is the same 404 as a missing id. `get` supplies status, rebuilt messages and pending approvals
for a page reload. Input messages may be `user` or `assistant`; the system prompt belongs to the
definition's `system`, and a `system` message is refused at `start`.

## Tools and approvals

Definitions accept SDK tools with `execute`. `toolsContext(run, call)` returns a record keyed by
tool name, and each tool receives only its own entry, validated by its `contextSchema`. The call
includes `idempotencyKey` and `unitOfWork`; the run includes the persisted tenant/principal
identity, services and abort signal. The `model(run)` callback is evaluated per model call, so wrap
tenant budgeting there using that identity rather than a request that no longer exists.

Set `approval.tools` to a map of tool names to `true` or
`(input, run) => boolean | Promise<boolean>`. The policy outcome is stored before execution.
Approval deadlines default to a day, with a 30-day maximum. Default authorization requires a defined
original principal equal to the decider; `canDecide(principal, run)` can apply your reviewer policy.
A second decision receives 409. A decider who may see the run (`canAccess`) but not decide it
receives 403; anyone who may neither see nor decide it receives the same 404 as a missing run.
Expired calls produce an SDK `execution-denied` result with `timed out`.

## Recovery and stream resume

Claim versions fence writes from old workers. A sweep takes abandoned runs only after the lease and
clock-skew margin. The model reply commits before tools: restarting between them executes the stored
calls without another provider call. An interrupted provider call is retried with a `reset-step`
chunk so the SDK client removes that attempt's partial message parts. Definition versions must
match, or be explicitly listed in `compatibleVersions`; otherwise the run fails with
`version-incompatible` before model/tool execution.

The UI message id is the run id. Responses carry the SDK UI-message SSE headers and `x-setu-run-id`.
Event ids are `<batch>.<index>.<epoch>`, the epoch being the lease version of the instance that
wrote the chunk. `Last-Event-ID` resumes after that exact chunk while the log agrees with it.
Without a header, the SDK replays from the start; its transport's default `resumeStreamIsReplay`
applies that replay to the same message. A waiting response ends after the approval request without
a finish chunk; the decide route returns another `respond` stream. A terminal run without an event
id returns 204, the SDK's nothing-to-resume signal. A terminal run with an event id serves the
retained remainder.

An id the log cannot honour means the client's view has diverged: it names a position past the
committed log, or one a different instance wrote, which happens when an instance dies with chunks it
had streamed but not yet stored and another takes the run over. The stream then sends a
`data-setu-replay` chunk followed by the whole stored log from the start. A client that handles the
stream itself must discard the message it has built when it sees that chunk and rebuild it from what
follows. AI SDK clients replay from the start by default and are unaffected. An id that does not
parse is ignored, and the stream replays from the start without the marker.

Same-instance clients subscribe before replay and receive unflushed chunks. Other instances poll
committed batches. Cancellation aborts a local in-flight call immediately, or a remote holder on its
next renewal. Client disconnection ends its tail, leaving the detached run available to resume.

## What exactly-once means here

Tool database writes through the supplied unit of work commit with their idempotency result. A
replay returns that result without executing the tool. An outside API call can repeat if a process
dies before that transaction commits: pass the stable `call.idempotencyKey` to the outside API's own
idempotency mechanism. Tool exceptions leave `within`, roll back database writes and become safe
tool-error entries. Idempotency conflicts defer recovery; configuration, store and oversized-result
errors fail the run. Configure a transactional idempotency store as above.

## Workers, bounds and storage

On Workers use `sweepIntervalMs: 0` and call `sweep()` from a Cron Trigger. Supply
`background: (ctx, work) => ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE).waitUntil(work)`
in application code, importing that interface from the Cloudflare plugin. A host may cut off work
after its background lifetime; the sweep resumes from stored state. Runs do not execute in
`ctx.defer`. Node, Deno and Bun keep the detached promise in process.

Await `sweep()` or pass its promise to the Cron Trigger's execution context. It claims its whole
batch and purges retention first, then waits for the work it recovered to finish or park, keeping
that invocation's lifetime attached to its recovered runs. A sweep started while another is still
running on the same instance returns at once with zero counts.

A run that fails is logged at `warn` (`Agent run failed.`) with its definition name, the error's
class name and any HTTP status hint, never its message, inputs or ids. Supply a logger plugin to see
it; the SDK's own provider-error log is switched off.

Defaults: 30-second lease, 5-second skew and sweep, 25 rows per sweep query, one-day retention,
100-ms/64-chunk flushes, 250-ms polling, 256-KiB input and 8-MiB retained deltas. All numeric bounds
are validated. Structural chunks continue beyond the delta bound, with one `data-setu-log-truncated`
marker; connected clients still receive deltas. Tool input deltas are not stored. Large structural
tool payloads still consume database space; configure idempotency result bounds and application tool
schemas accordingly. See the [package README](../packages/agent-runs-plugin/README.md) for options
and per-backend schema/index requirements. Purging terminal runs also deletes children.

## Using a workflow engine instead

Choose an engine when the application also coordinates general workflows, long waits, fan-out or
external events. This package ships no engine adapter.

- Vercel's [WorkflowAgent](https://github.com/vercel/workflow/blob/main/skills/workflow/SKILL.md)
  integrates the AI SDK with durable steps. It requires Workflow's compiler integration and a
  supported World/storage deployment; its Node hosting setup is separate from a portable Setu
  request handler.
- [Temporal's AI SDK integration](https://docs.temporal.io/develop/typescript) runs in a TypeScript
  Worker with a Temporal service, either managed or self-hosted. Deploy that Worker separately from
  edge request handlers and keep tool effects idempotent across retries.
- [Inngest](https://www.inngest.com/docs/durable-execution) coordinates application steps and waits
  through Inngest Cloud or a self-hosted server. The application exposes SDK functions on its
  supported HTTP host; use its durable execution when it already owns workflow coordination.
