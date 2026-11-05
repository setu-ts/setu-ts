# Milestone 136 — Durable agent runs (`@setu-ts/agent-runs-plugin`)

> **Status:** Planning. Branch: `feat/m136-durable-runs`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

An agent run — model call, tool calls, perhaps a human approval, more model calls — lives inside one
request today. A process restart loses it; a retried request repeats its side effects; a browser
that reconnects starts over. M136 adds a **narrow primitive, not a workflow engine**: the AI SDK's
agent loop driven one step at a time over state the application's own database holds, so a run
survives a restart, a stale worker's writes are refused, a tool's effect is recorded once, an
approval waits durably with a deadline, and a reconnecting client receives exactly the chunks it
missed.

Maintainer decisions taken before this plan (2026-11-06, recorded in the PR):

- **Shape:** a Setu primitive plus a documentation guide for applications that already run a
  workflow engine. No engine adapter.
- **Package:** a new `@setu-ts/agent-runs-plugin`; contracts in `common`; the database-backed run
  store in `database-plugin`, the way the outbox store is.

**Survey (2026-11-06, primary sources; two research tracks plus the installed `ai@7.0.159`).** What
exists, and what each leaves to the application:

| Concern                      | AI SDK 7 alone                                                                                   | Engines (Workflow DevKit + `WorkflowAgent`, Temporal, Inngest, Restate, DBOS, Cloudflare Agents, Mastra)                                                                                                                 | M136                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Survives a restart           | no — `streamText` is in-process                                                                  | yes, but Temporal/Inngest/Restate need a server, Workflow DevKit a compiler transform plus a storage backend (Node), DBOS Node+Postgres, Cloudflare only on Durable Objects, Mastra's durable agents are beta            | run rows over the app's own `IDatabaseService`, all four runtimes                    |
| Stale worker refused         | —                                                                                                | documented only by Mastra, and only on some stores; another agent runtime read at source takes its lease read-then-write and does not condition its writes on it                                                         | fenced lease: every write conditioned on `leaseVersion` (`updateWhere`)              |
| Tool effect not repeated     | —                                                                                                | every engine leaves idempotency to the user (Workflow DevKit hands out a stable `stepId`); Mastra's recovery re-runs tools                                                                                               | each tool call runs inside `IIdempotencyService.within`, keyed on run, step and call |
| Approval durable + timed out | `toolApproval` request/response parts, HMAC signing; no stored state, no timeout, not single-use | wait-with-timeout in Inngest, Temporal, Restate, DBOS; none of the agent libraries (AI SDK, LangGraph, OpenAI Agents SDK, Mastra) times out an approval                                                                  | approval rows with a deadline, decided once by compare-and-set, expired by a sweep   |
| Client resumes the stream    | protocol only: `GET <api>/<id>/stream`, 204 when idle, replay from start by default              | Workflow DevKit (`getReadable({ startIndex })`), Cloudflare (chunks in SQLite), Mastra (cache cleared 30 s after the run); the `resumable-stream` package keeps chunks in the producer's memory, so a restart loses them | a bounded chunk log stored with the run; replay from start, or `Last-Event-ID`       |

- **In scope:** the `agent-runs` capability token, `IAgentRunService`, `IAgentRunStore` and the run
  errors in `common`; the new `packages/agent-runs-plugin` (plugin, service, step loop, sweep, HTTP
  stream responder, `defineAgentRun`); `createDatabaseAgentRunStore` in `database-plugin`; the guide
  `docs/durable-runs.md` (including the engine guide); the package README, AGENT_CARD, PUBLIC_API,
  CHANGELOG, ROADMAP and CLAUDE.md entries; every registry a new package must touch (§5.1).
- **NOT this milestone:** general multi-step workflows (an engine's job; the guide covers them); an
  engine adapter (decided against); a CLI `setu add agent-runs` arm and an example app (follow-on,
  after the API has been used once — §9); sub-agents and parallel runs; streaming tool input deltas
  into the log (§3.9); WebSocket transports.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IRepository.updateWhere` / `deleteWhere` | `packages/database-plugin/src/interfaces/index.ts:141,153`                                                                                                              | Optional; `updateWhere(id, where, data)` returns `null` on a missing key or failed predicate. `WritePrecondition` = non-empty string/number equality map (`packages/common/src/services/write-precondition.ts:16`).                                                                                                                                                                                                                                                      |
| `updateWhere` per adapter                 | memory `memory-adapter.ts:705`, drizzle `:800`, prisma `:901`, mongo `:305`, D1 `d1-data-source.ts:335`, dynamo `:321`, cosmos `:571`, bigtable `:358`                  | All eight implement it outside a transaction; Dynamo, Cosmos and Bigtable omit it inside a transaction buffer. The run store never needs it inside a transaction (§3.4).                                                                                                                                                                                                                                                                                                 |
| `IDatabaseService`                        | `packages/database-plugin/src/interfaces/index.ts:211-272`                                                                                                              | `getRepository(entity)`, `transaction(work, options?)`, `query`, `migrate`, `isHealthy`, `close`. `IRepository` (`:73-181`): `findById`, `findAll(FindOptions)`, `findOne`, `create`, `update`, `delete`, `exists`, `count`, `findPage`.                                                                                                                                                                                                                                 |
| `FindOptions`                             | `packages/database-plugin/src/query/find-options.ts:29-50`                                                                                                              | `{ where?, filter?: FilterExpression, orderBy?, limit?, offset?, select?, cursor? }`; `FilterExpression` comparisons `eq/contains/gt/gte/lt/lte/in`, `and`/`or` (`packages/common/src/services/database.ts:76-119`).                                                                                                                                                                                                                                                     |
| Outbox store pattern                      | `packages/common/src/services/outbox.ts:213-348`; `packages/database-plugin/src/outbox/database-outbox-store.ts:54-68,222-235,329-342,366-399,434-470,514-528`          | Port in common, `DatabaseOutboxStore(service, entity)`, factory `createDatabaseOutboxStore({ entity?, database? }): RegistryFactory<IOutboxStore>` resolving `CAPABILITIES.DATABASE` (or `database.<name>`); claim = `updateWhere` on `{ status, claimVersion }` bumping `claimVersion`; `verify()` probes conditional writes; `OutboxStoreUnavailableError(entity, 'conditional-writes-unsupported')`.                                                                  |
| Relay lease timing                        | `packages/messaging-plugin/src/outbox/relay.ts:394-449`; `options.ts:130-169`; `record-codec.ts:35,51-64`                                                               | Skip while `now < leaseUntil + maxClockSkewMs`; self-fence when `now + workBound + skew > leaseUntil`; defaults `claimLeaseMs` 30,000, `maxClockSkewMs` 5,000 (max 60,000); constraint `claimLeaseMs >= publishTimeoutMs + 2*storeTimeoutMs + maxClockSkewMs`.                                                                                                                                                                                                           |
| `IIdempotencyService.within`              | `packages/common/src/services/idempotency.ts:354-391,434-437`; `packages/idempotency-plugin/src/within/within.ts:138-220`                                               | `within<R,S>({ key, namespace, scope, fingerprint?, ttlMs? }, fn: (scope: S) => Promise<R>): Promise<{ value: R; replayed: boolean }>`. Key 1–255 chars 0x21–0x7E without `"`; `scope` is caller-built (no request context). Committed → replay without running `fn`; concurrent duplicate → `IdempotencyWithinError('conflict')` 409; `fn` errors rethrown; result JSON ≤ `maxResultBytes` (default 65,536).                                                            |
| `within` needs a transactional store      | `packages/idempotency-plugin/src/service/idempotency-service.ts:91-104`; `packages/database-plugin/src/idempotency/database-idempotency-store.ts:53-64,183-194,285-290` | Without `transactional` it rejects `IdempotencyConfigurationError('transactional')`. The database store passes the `IUnitOfWork` as `fn`'s scope; refuses Cosmos, Bigtable, standalone Mongo.                                                                                                                                                                                                                                                                            |
| `CAPABILITIES`, token grammar             | `packages/common/src/tokens.ts:39-319,331-367`                                                                                                                          | `createCapabilityToken`; segment `[a-z][a-z0-9]*(?:-[a-z0-9]+)*`, dot namespacing. Last entry `VECTOR_STORE: 'vector-store'` (`:318`). `agent-runs` passes the grammar.                                                                                                                                                                                                                                                                                                  |
| `IScheduler`                              | `packages/common/src/services/scheduler.ts:75-178`                                                                                                                      | `every`/`delay`/`cron`; "Execution is process-local and time-driven (no durable persistence)" (`:75-77`). A `delay` is lost on restart, so deadlines cannot be scheduler timers (§3.7).                                                                                                                                                                                                                                                                                  |
| Runtime timers and clock                  | `packages/common/src/runtime.ts:335-386`                                                                                                                                | `uuid()`, `randomBytes`, `subtle`, `now()` (wall-clock epoch ms), `hrtime()` (monotonic), `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval` (`TimerHandle = unknown`).                                                                                                                                                                                                                                                                                           |
| Request identity                          | `packages/common/src/http.ts:60,69`; `packages/common/src/services/tenancy.ts:15-22,80`                                                                                 | `ctx.request.user?.id`, `ctx.request.tenant?.id`; `ctx.signal`.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ctx.defer`                               | `packages/common/src/http.ts:363-381`; `packages/kernel/src/context/request-context.ts:193-199`                                                                         | Cleanup after the handler, bounded 5,000 ms per async cleanup — not a background runner. Runs are not executed through it (§3.10).                                                                                                                                                                                                                                                                                                                                       |
| Workers background work                   | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:126-137`; `packages/common/src` has no `waitUntil`                                                         | `ICloudflareBindings.waitUntil(promise)` lives in `cloudflare-plugin`, which this plugin may not import; per invocation, up to 30 s. Hence the `background` option (§3.10).                                                                                                                                                                                                                                                                                              |
| `ToolExecutionOptions`                    | `@ai-sdk/provider-utils` (bundled with `ai@7.0.159`) `dist/index.d.ts` `ToolExecutionOptions`, `ToolExecuteFunction` (`:2153`)                                          | `{ toolCallId, messages, abortSignal?, context, experimental_sandbox? }`; `execute` may return a value, a promise or an `AsyncIterable` (preliminary results). `toolsContext` is keyed by tool name and checked against each tool's `contextSchema` (M134 example, `chat.controller.ts`).                                                                                                                                                                                |
| SSE plugin                                | `packages/common/src/services/sse.ts:24-184`; `packages/sse-plugin/src/connection/sse-connection.ts:57,128-129`                                                         | `ISseConnection.lastEventId` from the header; in-process channels; no history or replay anywhere in the package.                                                                                                                                                                                                                                                                                                                                                         |
| Plugin shape                              | `packages/vector-store-plugin/src/plugin/vector-store-plugin.ts:78-121`; `package.json`                                                                                 | Options validated synchronously (TypeError); `onClose` registered before touching a backend ("a failed start runs only the close hooks"); `provides`, `dependencies`, `optionalDependencies`; `VERSION` in `src/version.ts`.                                                                                                                                                                                                                                             |
| AI SDK loop and parts                     | `ai@7.0.159` `dist/index.d.ts:6022-6026`, `:3996-4004`, `:2424-2522`, `:7093-7105`                                                                                      | The loop stops when "a tool that is invoked does not have an execute function"; `experimental_toolApprovalSecret`; UI chunks `tool-approval-request {approvalId, toolCallId, reason?}`, `tool-output-denied`, `start`/`finish`/`start-step`/`finish-step`/`abort`/`error` and **`reset-step` ("Removes all message parts added during the current step")**; `toUIMessageStream({ stream, tools, sendStart, sendFinish, messageMetadata })`; `UI_MESSAGE_STREAM_HEADERS`. |
| Client reconnect                          | `ai@7.0.159` `dist/index.js:6988-6998,20445-20488`                                                                                                                      | `GET <api>/<chatId>/stream`; 204 → nothing to resume; `DefaultChatTransport.resumeStreamIsReplay` defaults to `true` (replay from start); the client applies `reset-step` by splicing the current step's parts.                                                                                                                                                                                                                                                          |
| M134 budget wrapper                       | `apps/ai-chat/src/modules/chat/chat.budget.ts:37-266`                                                                                                                   | Budgeting is a `wrapLanguageModel` middleware keyed on `ctx.request.tenant?.id`; each model call reserves and settles separately. A run supplies its model per call (§3.6), so the application wraps it the same way with the run's tenant.                                                                                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| C1  | ROADMAP M136 lists `packages/sse-plugin (a bounded replay log)`.                                                                                                         | The log lives in the run store. `sse-plugin` channels are in-process with no history (§1), and the AI SDK client reads its own UI-message SSE framing, so an `sse-plugin` log could survive neither a restart nor a second instance. `sse-plugin` is unchanged. | ROADMAP M136 "Package(s)" line and a note under its decisions. |
| C2  | ROADMAP M136 decision 2: "The model's reply is persisted before any tool runs" assumed a Setu-owned tool loop; its re-examination note asks for a step-at-a-time design. | Step-at-a-time over the SDK (§3.3): each model call is `streamText` with tools passed without `execute`, so the SDK stops at the calls and the plugin persists before running them.                                                                             | ROADMAP M136 note.                                             |
| C3  | ROADMAP decision 3: "Tool side effects keyed on run id and step, through the idempotency plugin."                                                                        | Kept, and stated precisely: database writes made through the tool's unit of work commit once; an outside call can repeat after a crash before commit, so the tool receives the same stable key for the outside API (§3.5).                                      | `docs/durable-runs.md` "What exactly-once means here".         |
| C4  | `docs/ai.md` says "There is no Setu AI plugin".                                                                                                                          | Stays true for model access: the run plugin owns persistence, not models. The sentence gains a pointer to durable runs.                                                                                                                                         | `docs/ai.md` one sentence.                                     |
| C5  | `ISseConnection.send` JSDoc says it throws on a closed connection; the implementation returns silently (`sse-connection.ts:128-129`).                                    | Pre-existing and unrelated to M136; not changed here.                                                                                                                                                                                                           | None in this PR; recorded in §9.                               |

## 3. Design decisions

### 3.1 Package, token, contracts

- **Decision:** new `packages/agent-runs-plugin` (`@setu-ts/agent-runs-plugin`), plugin name
  `agent-runs-plugin`, single-instance, `provides: [CAPABILITIES.AGENT_RUNS]`,
  `dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.IDEMPOTENCY]`,
  `optionalDependencies: [CAPABILITIES.LOGGER]`. New token `CAPABILITIES.AGENT_RUNS = 'agent-runs'`
  bound to `IAgentRunService`. `common/src/services/agent-runs.ts` holds `IAgentRunService`,
  `IAgentRunStore` and the row types; `common/src/errors/agent-runs.ts` the errors. `common` never
  imports `ai`: messages and chunks are JSON values there (`AgentRunJson`); the plugin types them
  with the SDK's `ModelMessage` and `UIMessageChunk`.
- **Why:** the outbox precedent (port in common, store in database-plugin, engine in its plugin);
  token↔interface binding is fixed.
- **Test home:** `test/unit/plugin.test.ts` (provides, dependencies, registration),
  `packages/common/test/unit/agent-runs-contract.test.ts` (token grammar, error hints).

### 3.2 The `ai` dependency

- **Decision:** `ai` is a required peer (`>=7.0.159 <8`). It is loaded once at `register()` with a
  literal awaited `await import('ai')` inside a `try` in the same function; failure throws
  `OptionalDependencyUnavailableError` naming `ai` and `@setu-ts/agent-runs-plugin` (the M113d
  shape, checked by `findUnguardedImports`). The loaded functions (`streamText`,
  `toUIMessageStream`) and `UI_MESSAGE_STREAM_HEADERS` are held by the service; tests inject them
  through an internal `AiRuntime` seam.
- **Why:** the plugin calls the SDK at runtime; a bare static import would make Workers bundles
  without the SDK fail, and the guarded shape is the repository rule.
- **Test home:** `test/unit/ai-runtime.test.ts` (load failure names the peer; injected seam),
  `test/integration/real-ai.test.ts` (the real import with `MockLanguageModelV4`).

### 3.3 The step loop

- **Decision:** a run executes as a sequence of **entries** appended to its log: `model` (the
  assistant message of one model call, its finish reason and usage) and `tool` (one tool result,
  error or denial). One iteration:
  1. If the last `model` entry has tool calls without a `tool` entry, run them (§3.5), each appended
     as its own entry, then continue. A call that needs approval and has none decided parks the run
     (§3.7).
  2. Otherwise, if the run is finished (last model entry's finish reason is not `tool-calls`, or
     `maxSteps` reached), complete it.
  3. Otherwise call the model:
     `streamText({ model, system, messages, tools: schemaOnly(tools), maxOutputTokens, abortSignal, toolsContext })`
     where `schemaOnly` strips `execute`, so the SDK ends the call at the tool calls. Chunks go to
     the log (§3.9) as they stream. On finish the `model` entry is appended (fenced, §3.4)
     **before** any tool runs. `messages` are rebuilt from the run's input messages plus every
     entry, in order. The SDK's own `toolApproval` option is not used: approvals are server-side
     rows (§3.7), so there is nothing for a client to sign or forge.
- **Why:** this is the ROADMAP's decision 2 over the SDK's loop (C2): a crash after the reply
  resumes at step 1 and never repeats the model call.
- **Test home:** `test/unit/step-loop.test.ts`; gate G1 in `test/integration/recovery.test.ts`.

### 3.4 Run row, entries and the fenced lease

- **Decision:** four entities (names configurable): `AgentRun`, `AgentRunEntry`, `AgentRunChunks`,
  `AgentRunApproval`. The `AgentRun` row carries
  `id, tenantId, principalId, definition, version, status, input, leaseOwner, leaseVersion, leaseUntil, entryCount, chunkCount, stepChunkStart, cancelRequested, error, createdAt, updatedAt`.
  Statuses: `running`, `waiting` (approval pending), `ready` (approval decided, not yet resumed),
  `completed`, `failed`, `cancelled`. **Claim:**
  `updateWhere(id, { leaseVersion: v }, { leaseVersion: v + 1, leaseOwner, leaseUntil })` — the
  outbox claim shape; the holder keeps `v + 1`. **Every later write** is `updateWhere` on
  `{ leaseVersion: held }`, so a stale holder's write returns `null` and the store raises
  `AgentRunLeaseLostError`; the loop stops without writing further. **Appending** an entry or a
  chunk batch is two steps: `create` the row at a deterministic id (`<runId>.<n>`, zero-padded),
  then advance the counter with
  `updateWhere({ leaseVersion: held, entryCount: n }, { entryCount: n + 1 })`. A reader reads only
  rows below the committed counter, so a row created by a holder that then lost the lease is never
  read; the next holder that needs the id deletes the orphan before creating it (`create` →
  `DuplicateKeyError` → `delete` → `create`, once). **Renewal** every `leaseMs / 3`, and immediately
  before every model call and tool call; a failed renewal stops the loop before the call starts (the
  relay's self-fencing, applied per call instead of per estimated duration). **Takeover** requires
  `now > leaseUntil + maxClockSkewMs`.
- **Why:** reuses the outbox relay's proven claim and clock rules (§1); counters make the commit
  point a single conditional write, which every adapter supports outside a transaction.
- **Test home:** `test/unit/lease.test.ts` (claim, renew, stale write refused — gate G2, takeover
  timing, orphan handling); `packages/database-plugin/test/unit/agent-run-store.test.ts`.

### 3.5 Tool calls run once per call id

- **Decision:** each tool call runs as
  `idempotency.within({ namespace: 'setu.agent-runs.tool', scope: JSON.stringify([tenantId, principalId ?? '']), key: <hex SHA-256 of [runId, entryIndex, toolCallId]>, fingerprint: { tool: name, input } }, (uow) => execute(input, options))`.
  `options` is the SDK's `ToolExecutionOptions`: `toolCallId`, `messages` (the rebuilt history),
  `abortSignal`, and `context` = `definition.toolsContext?.(run, call)?.[toolName]`, where
  `call = { toolCallId, toolName, idempotencyKey, unitOfWork: uow }` — the application decides what
  each tool receives, so a tool's own `contextSchema` still validates it. An `AsyncIterable` result
  is drained and its last value is the result. The plugin emits the UI chunks the SDK emits only for
  tools it runs itself: `tool-output-available`, `tool-output-error`, `tool-output-denied`. A
  replayed result is appended as the entry without running the tool. A tool that throws must roll
  back its own database writes, so its error leaves `within`: inside the work function the runner
  rethrows it wrapped in a private `ToolFailure` marker, which `within` rethrows unchanged; outside,
  a `ToolFailure` becomes a `tool` error entry (the SDK's `tool-error` semantics). Any other error
  came from the idempotency plugin, which this plugin may not import, so it is classified by
  `httpStatusHintOf` (common): a 409 (`conflict`, another holder mid-call) stops the loop and leaves
  the run for the sweep; anything else — a result above `maxResultBytes`, a store fault, or a
  missing transactional store, which the plugin cannot detect at start without writing a probe row —
  ends the run `failed` with that error as the cause. The guide's setup shows
  `IdempotencyPlugin({ transactional })`.
- **Why:** ROADMAP decision 3; `within` is the existing at-most-once primitive, and its unit of work
  makes the tool's own database writes commit with the result (C3).
- **Test home:** `test/unit/tool-runner.test.ts` (key derivation, context builder, async-iterable
  results, emitted chunks, replay, a throwing tool's writes rolled back and recorded as an error
  entry, 409 conflict stops, other `within` errors fail the run); gate G1.

### 3.6 Run definitions

- **Decision:**
  `defineAgentRun({ name, version, compatibleVersions?, model, system?, tools?, toolsContext?: (run, call) => Record<toolName, context>, maxSteps = 20, maxOutputTokens, approval?, timeouts? })`
  returns a frozen definition; `AgentRunsPlugin({ definitions })` registers them by name (duplicates
  refused). `model: (run: AgentRunContext) => LanguageModel` is called **per model call**, with
  `AgentRunContext = { runId, tenantId, principalId, services, signal }`, so the application wraps
  its M134 budget middleware with the run's tenant. `maxOutputTokens` is required (the budget
  estimate needs it).
- **Why:** one place names everything a resumed run needs without the original request.
- **Test home:** `test/unit/define.test.ts`.

### 3.7 Approvals as rows with a deadline

- **Decision:**
  `approval: { tools: { [name]: true | ((input, run) => boolean | Promise<boolean>) }, timeoutMs = 86_400_000 (max 2_592_000_000), canDecide?: (principal, run) => boolean }`.
  When a `model` entry contains a call that needs approval, the loop creates an `AgentRunApproval`
  row
  `{ id, runId, tenantId, toolCallId, toolName, input, status: 'pending', deadline: now + timeoutMs }`
  (fenced: created before the run's status write), emits
  `tool-approval-request {approvalId, toolCallId}`, sets the run to `waiting` and releases the
  lease. `decide(ctx, runId, approvalId, { approved, reason? })` checks tenant and `canDecide`
  (default: the request's principal id equals the run's, both defined — so a run started without a
  principal needs a custom `canDecide` before any approval can be decided), then
  `updateWhere(approvalId, { status: 'pending' }, { status: approved ? 'approved' : 'denied', decidedBy, decidedAt, reason })`
  — a second decision returns 409 `AgentRunApprovalError`. It then appends a
  `tool-approval-response` chunk (live clients update at once), moves the run `waiting → ready` and
  starts it. The sweep (§3.8) turns `pending` rows past their deadline into `expired` the same way.
  On resume, an approved call runs (§3.5); a denied or expired one becomes a denial entry, sent to
  the model as the SDK's `execution-denied` result with the reason (`'timed out'` for expiry) and to
  the client as `tool-output-denied`.
- **Why:** none of the agent libraries surveyed persists, times out or single-uses an approval; the
  server-held row needs no client signature.
- **Test home:** `test/unit/approvals.test.ts`; gate G3 in `test/integration/recovery.test.ts`.

### 3.8 The sweep

- **Decision:** every `sweepIntervalMs` (default 5,000) on every instance, through
  `runtime.setInterval` (cleared in `onClose`), the service runs `sweep()`, also public for Workers
  cron triggers and tests: (1) expire approvals with `status = pending, deadline < now`, then mark
  their runs `ready`; (2) claim and resume runs `ready`, or `running` with
  `leaseUntil + maxClockSkewMs < now`; (3) purge terminal runs and their rows older than
  `retentionMs` (default 86,400,000). Each query is bounded by `sweepBatch` (default 25). Every
  change is a conditional write, so concurrent sweeps on several instances are safe; a lost race is
  skipped.
- **Why:** the scheduler keeps nothing across a restart (§1), so deadlines must be read from stored
  rows; a plain interval avoids a dependency that adds nothing here.
- **Test home:** `test/unit/sweep.test.ts` (each query, batch bound, lost race skipped, purge).

### 3.9 The chunk log and stream resume

- **Decision:** UI chunks are buffered and appended as `AgentRunChunks` batches (§3.4 counter
  `chunkCount`) every `flushIntervalMs` (default 100) or `flushChunks` (default 64) and at every
  step end. Each chunk's SSE id is `<batch>.<index>`. The run's message is one UI message: one
  `start` (messageId = run id), `start-step`/`finish-step` per model call, tool parts, approval
  requests, then `finish` (or `abort` on cancel, `error` on failure). **Recovery:** when a new
  holder resumes a run whose last model call was cut off (chunks written since `stepChunkStart` but
  no `model` entry), it appends a `reset-step` chunk before retrying — the client splices that
  step's parts, so replay and live tails both show it once. **Bound:** `maxLogBytes` per run
  (default 8 MiB): past it, text and reasoning deltas are no longer stored, a
  `data-setu-log-truncated` chunk is stored once, and structural chunks continue; live clients are
  unaffected. Terminal runs' logs are purged with the run (§3.8). **Serving:** `respond(ctx, runId)`
  returns the UI message stream with `UI_MESSAGE_STREAM_HEADERS` plus `x-setu-run-id`: it replays
  committed batches after the `Last-Event-ID` position (from the start when absent), then tails —
  in-process subscribers get chunks as they are produced; other instances poll committed batches
  every `pollIntervalMs` (default 250) — until a terminal chunk, or until the run parks in
  `waiting`: the live response then ends after the `tool-approval-request` chunk without a `finish`
  chunk, so the client keeps the message in progress, and the guide's decide route answers with
  `respond(ctx, runId)`, which the AI SDK client applies as a replay of the same message (same
  `messageId`, `resumeStreamIsReplay`). Without `Last-Event-ID` (the AI SDK's reconnect), a terminal
  run answers 204, the SDK's "nothing to resume"; with one, the remaining retained chunks are served
  even when the run is terminal. An unknown run, or another tenant's, answers 404 (§3.11).
  `get(ctx, runId)` returns the status, pending approvals and the rebuilt messages, for a page
  reload. Tool input deltas are not stored (their final input is in the tool part).
- **Why:** the AI SDK's reconnect replays from the start by default (§1); `Last-Event-ID` serves
  plain SSE clients; polling committed rows needs no extra infrastructure on any runtime.
- **Test home:** `test/unit/chunk-log.test.ts`, `test/unit/respond.test.ts`; gate G4.

### 3.10 Where a run executes

- **Decision:** `start(ctx, name, { messages })` creates the run row (tenant and principal from
  `ctx`), claims it and executes it detached in this process; the returned handle carries `runId`.
  Where the runtime needs to be told, the `background(ctx, work)` option receives the run's promise
  — on Workers
  `(ctx, p) => ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE).waitUntil(p)` in
  application code, since this plugin may not import `cloudflare-plugin`; a run that outlives it is
  resumed by the sweep from a Cron Trigger calling `sweep()`. Nothing runs through `ctx.defer`.
  `cancel(ctx, runId)` sets `cancelRequested` (conditional on the run being non-terminal); the
  holder aborts its model or tool call through its `AbortController` at the next renewal or chunk,
  appends `abort`, and ends `cancelled`; a `waiting` run is cancelled directly.
- **Why:** detached execution plus a sweep is the only shape that works on all four runtimes.
- **Test home:** `test/unit/service.test.ts` (start, cancel in each state, `background` receives the
  run's promise).

### 3.11 Tenancy, identity and errors

- **Decision:** every row stores `tenantId`; every service method takes `ctx` and refuses a run
  whose `tenantId` differs from `ctx.request.tenant?.id` with the same 404 `AgentRunNotFoundError`
  as a missing run (no existence oracle). A run started without a tenant stores `''` and is readable
  only by tenant-less requests. Errors: `AgentRunNotFoundError` 404, `AgentRunStateError` 409 (wrong
  state for the action), `AgentRunApprovalError` 409 (already decided, or not allowed: 403),
  `AgentRunDefinitionError` (configuration, no hint), `AgentRunLeaseLostError` (internal, never
  served), `AgentRunStoreUnavailableError` (503 hint). Served details never echo ids or inputs.
- **Why:** M127's no-oracle rule; status hints reach clients through the errorHandler (M135 lesson).
- **Test home:** `test/unit/tenancy.test.ts`;
  `packages/common/test/unit/agent-runs-contract.test.ts`.

### 3.12 Version stamp

- **Decision:** a run stores its definition's `version`. On resume, a run whose version is neither
  the definition's current `version` nor in `compatibleVersions` ends `failed` with error
  `version-incompatible` and an `error` chunk; nothing is called. A run naming a definition no
  longer registered fails the same way.
- **Why:** ROADMAP decision 6; a rule the application controls per release.
- **Test home:** `test/unit/version.test.ts`.

### 3.13 The database store

- **Decision:**
  `createDatabaseAgentRunStore({ entities?, database? }): RegistryFactory<IAgentRunStore>` in
  `database-plugin`, implementing `IAgentRunStore` over `IDatabaseService` repositories outside
  transactions. `verify()` probes `updateWhere`/`deleteWhere` on the run entity and refuses with
  `AgentRunStoreUnavailableError('conditional-writes-unsupported')`. Sweep queries use
  `findAll({ where, filter, orderBy, limit })`; the README states per-backend requirements as the
  outbox does (Drizzle tables, Prisma models, a DynamoDB GSI on `status`).
- **Why:** the outbox store's proven shape (§1).
- **Test home:** `packages/database-plugin/test/unit/agent-run-store.test.ts` (memory),
  `packages/database-plugin/test/integration/agent-run-store-postgres.test.ts` (guarded real
  Postgres via Drizzle).

### 3.14 Documentation and the engine guide

- **Decision:** `docs/durable-runs.md`: when to use runs, a complete route example (start, resume
  GET, decide, cancel), approvals, recovery semantics, what exactly-once means here (C3), Workers,
  limits, and "Using a workflow engine instead" — facts from the survey only, for Workflow DevKit's
  `WorkflowAgent`, Temporal's AI SDK integration and Inngest, each with its runtime and hosting
  requirement. No competitor is named that the survey did not verify from a primary source.
- **Why:** the maintainer's choice of a guide over an adapter.
- **Test home:** the guide fence compiler (`test/guide-fence-compiler.test.ts`), `check:docs`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `CAPABILITIES` gains a key; everything else is new.

| Exported symbol                                                                                                                                                       | Kind      | Consumer / real code path that READS it                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------- |
| `CAPABILITIES.AGENT_RUNS` (common)                                                                                                                                    | token     | plugin `provides`/`register`; applications' `services.get`  |
| `IAgentRunService` (common)                                                                                                                                           | interface | the service implements it; routes call it                   |
| `IAgentRunStore` and row types `AgentRunRow`, `AgentRunEntryRow`, `AgentRunChunkBatch`, `AgentRunApprovalRow`, `AgentRunStatus`, `AgentRunJson` (common)              | types     | `DatabaseAgentRunStore` implements; the service consumes    |
| `AgentRunNotFoundError`, `AgentRunStateError`, `AgentRunApprovalError`, `AgentRunDefinitionError`, `AgentRunLeaseLostError`, `AgentRunStoreUnavailableError` (common) | classes   | thrown by service and store; errorHandler reads hints       |
| `AgentRunsPlugin`, `AgentRunsPluginOptions`                                                                                                                           | fn, type  | applications register it                                    |
| `defineAgentRun`, `AgentRunDefinition`, `AgentRunContext`, `AgentRunApprovalOptions`                                                                                  | fn, types | applications define runs; the loop reads every field (§3.6) |
| `AgentRunToolCall`                                                                                                                                                    | type      | the `toolsContext(run, call)` builder reads it (§3.5)       |
| `VERSION`                                                                                                                                                             | const     | the version-constant gate                                   |
| `createDatabaseAgentRunStore`, `DatabaseAgentRunStore`, `DatabaseAgentRunStoreOptions` (database-plugin)                                                              | fn, class | applications pass it to `AgentRunsPlugin({ store })`        |

### 4.1 Options — every option names its consumer

| Option                                      | Consumer                  | Behavior (per implementation)                                        |
| ------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `store` (required)                          | service                   | `IAgentRunStore` or `RegistryFactory`; `verify()` at register        |
| `definitions` (required, non-empty)         | registry                  | §3.6; duplicates refused                                             |
| `leaseMs` (30,000)                          | lease (§3.4)              | ≥ 3 × renewal; validated with `maxClockSkewMs`                       |
| `maxClockSkewMs` (5,000, max 60,000)        | lease, sweep              | takeover margin and self-fencing                                     |
| `sweepIntervalMs` (5,000; `0` disables)     | sweep                     | `0` for Workers, where the cron trigger calls `sweep()`              |
| `sweepBatch` (25)                           | sweep                     | per-query limit                                                      |
| `retentionMs` (86,400,000)                  | sweep purge               | terminal runs and their rows                                         |
| `flushIntervalMs` (100), `flushChunks` (64) | chunk log                 | batch boundaries                                                     |
| `maxLogBytes` (8 MiB)                       | chunk log                 | §3.9 truncation                                                      |
| `pollIntervalMs` (250)                      | `respond` tail            | cross-instance tail                                                  |
| `background`? `(ctx, work) => void`         | `start`, `decide` (§3.10) | receives each detached run's promise; absent → the promise just runs |
| `toolNamespace`? — not added                | —                         | the namespace is fixed (§3.5); no consumer for an option             |

`createDatabaseAgentRunStore({ entities?: { run?, entry?, chunks?, approval? }, database? })`:
entity names default to `AgentRun`, `AgentRunEntry`, `AgentRunChunks`, `AgentRunApproval`;
`database` selects `database.<name>` as the outbox store does.

## 5. Implementation files

| File                                                                  | Purpose                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `packages/common/src/services/agent-runs.ts`                          | `IAgentRunService`, `IAgentRunStore`, row types          |
| `packages/common/src/errors/agent-runs.ts`                            | the six errors with status hints                         |
| `packages/common/src/tokens.ts`, `src/index.ts`                       | `AGENT_RUNS`; exports                                    |
| `packages/agent-runs-plugin/src/index.ts`                             | barrel                                                   |
| `src/plugin/agent-runs-plugin.ts`                                     | options validation, registration, `onClose`, sweep timer |
| `src/definitions/define-agent-run.ts`                                 | `defineAgentRun` and validation                          |
| `src/runtime/ai-runtime.ts`                                           | guarded `import('ai')` and the `AiRuntime` seam          |
| `src/service/agent-run-service.ts`                                    | `start`, `respond`, `decide`, `cancel`, `get`, `sweep`   |
| `src/loop/step-loop.ts`                                               | §3.3                                                     |
| `src/loop/messages.ts`                                                | rebuild model messages from input + entries              |
| `src/loop/tool-runner.ts`                                             | §3.5                                                     |
| `src/lease/lease.ts`                                                  | claim, renew, self-fence (§3.4)                          |
| `src/log/chunk-log.ts`                                                | buffering, flush, truncation, subscribers (§3.9)         |
| `src/log/respond.ts`                                                  | SSE framing, `Last-Event-ID`, replay and tail            |
| `src/approvals/approvals.ts`                                          | §3.7                                                     |
| `src/sweep/sweep.ts`                                                  | §3.8                                                     |
| `src/version.ts`                                                      | `VERSION`                                                |
| `packages/database-plugin/src/agent-runs/database-agent-run-store.ts` | §3.13                                                    |
| `packages/database-plugin/src/index.ts`                               | export the factory                                       |

### 5.1 Registries a new package and guide must touch

Every one of these failed a gate on M133, M134, M135 or #554 when missed:

| File                                                                                                                                                                                              | Change                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `scripts/release-packages.ts`, `scripts/jsr-metadata.ts`                                                                                                                                          | `PUBLISHED_PACKAGES`; `PACKAGE_METADATA` description                   |
| `compat/compat.test.mjs`, `compat/package.json`                                                                                                                                                   | `PENDING_FIRST_PUBLISH` until the first publish                        |
| `tsconfig.json` references, `tsconfig.check.json`, `typedoc.check.json`                                                                                                                           | the new member                                                         |
| `scripts/generate-api-docs.ts`, `test/api-docs-generation.test.ts`                                                                                                                                | API reference generation                                               |
| `scripts/fixtures/node-boot/boot.mjs`                                                                                                                                                             | installed-member count + 1                                             |
| `test/version-constant.test.ts`                                                                                                                                                                   | the package's `VERSION`                                                |
| `packages/cli/src/agents/package-data.ts`, `packages/cli/src/devtool/sources.ts`, `packages/cli/test/unit/agents/budget.test.ts`                                                                  | `PACKAGE_DATA` (token `AGENT_RUNS`); `FRAMEWORK_PACKAGES`; card budget |
| `packages/agent-runs-plugin/AGENT_CARD.md`; `test/agent-card-gate.test.ts`, `test/package-readme-fence-compiler.test.ts`, `test/set-jsr-metadata-dry-run.test.ts`, `test/unit/jsr-sunset.test.ts` | gates that enumerate packages, cards and READMEs                       |
| `scripts/node-dependency-ranges.ts`, `scripts/node-manifests.ts`, root `package.json`                                                                                                             | `ai` peer range; root devDependencies the guide's fences need          |
| `website/src/lib/docs-nav.ts`, `docs/README.md`, `docs/plugins.md`, `docs/ai.md`                                                                                                                  | guide listing; C4                                                      |
| `website/test/repository.test.ts`                                                                                                                                                                 | `PACKAGES` + 1, carded + 1 (`ci:local` does not run website tests)     |
| `test/guide-fence-compiler.test.ts`, `test/fixtures/snippets/fence-engine.ts`                                                                                                                     | register `docs/durable-runs.md`; pin its counts                        |
| `CHANGELOG.md`, `PUBLIC_API.md`, `ROADMAP.md`, `CLAUDE.md`                                                                                                                                        | entries naming the PR; C1–C2; Progress row; status line                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/agent-runs-contract.test.ts`                      | `services/agent-runs.ts`, `errors/agent-runs.ts` | token grammar; each error's name and hint; served detail echoes nothing                                                                                                                                                                                                                                         |
| `test/unit/plugin.test.ts`                                                   | `plugin/agent-runs-plugin.ts`                    | every option's validation (NaN, Infinity, negatives, fractions, `leaseMs` vs skew); `onClose` registered first and clears the timer; missing `within` refused by name                                                                                                                                           |
| `test/unit/define.test.ts`                                                   | `definitions/define-agent-run.ts`                | required fields, `maxSteps` bounds, frozen result, approval config shape                                                                                                                                                                                                                                        |
| `test/unit/ai-runtime.test.ts`                                               | `runtime/ai-runtime.ts`                          | import failure → `OptionalDependencyUnavailableError` naming `ai`; seam                                                                                                                                                                                                                                         |
| `test/unit/step-loop.test.ts`                                                | `loop/step-loop.ts`, `loop/messages.ts`          | tools reach the model without `execute`; model entry appended before any tool; finish/`maxSteps` completion; messages rebuilt in order incl. denial results                                                                                                                                                     |
| `test/unit/tool-runner.test.ts`                                              | `loop/tool-runner.ts`                            | key = hash(runId, entryIndex, toolCallId); replay appends without executing; throw → error entry; `conflict` stops; context carries `run.idempotencyKey` and the unit of work                                                                                                                                   |
| `test/unit/lease.test.ts`                                                    | `lease/lease.ts`                                 | claim bumps version; stale holder's write refused (G2); renewal; self-fence refuses to start work near expiry; takeover only past skew; orphan row deleted and recreated                                                                                                                                        |
| `test/unit/chunk-log.test.ts`                                                | `log/chunk-log.ts`                               | flush by time, count and step end; `reset-step` on recovery; truncation marker once; subscribers                                                                                                                                                                                                                |
| `test/unit/respond.test.ts`                                                  | `log/respond.ts`                                 | headers; replay from start; `Last-Event-ID` resumes after the exact chunk (G4); malformed id → from start; tail until terminal; 204/404 rules                                                                                                                                                                   |
| `test/unit/approvals.test.ts`                                                | `approvals/approvals.ts`                         | row before status; single decision (second → 409); `canDecide` default and custom (403); expiry → denial entry with reason                                                                                                                                                                                      |
| `test/unit/sweep.test.ts`                                                    | `sweep/sweep.ts`                                 | expire, resume, purge queries and batch; lost race skipped; concurrent sweeps make one change                                                                                                                                                                                                                   |
| `test/unit/service.test.ts`                                                  | `service/agent-run-service.ts`                   | start/decide/cancel/get across states; `background` receives the promise; cancel aborts the in-flight call                                                                                                                                                                                                      |
| `test/unit/tenancy.test.ts`                                                  | service tenancy paths                            | another tenant's run is the same 404 as a missing one, for every method                                                                                                                                                                                                                                         |
| `test/unit/version.test.ts`                                                  | version rule in service                          | compatible resumes; incompatible fails with `version-incompatible`; unknown definition fails                                                                                                                                                                                                                    |
| `test/integration/recovery.test.ts`                                          | whole plugin over a memory `DatabasePlugin`      | **G1** crash after the model entry (holder A stopped at an internal, unexported `afterModelEntry` test hook, clock past lease) → holder B resumes: one model call, one tool execution; **G3** approval created, service instances replaced, clock past deadline, sweep → `expired`, run continues with a denial |
| `test/integration/real-ai.test.ts`                                           | real `ai` import                                 | the guarded import loads; a `MockLanguageModelV4` run streams UI chunks the SDK's own `readUIMessageStream` parses                                                                                                                                                                                              |
| `test/e2e/process-kill.e2e.test.ts`                                          | the gate's literal form                          | guarded by `AGENT_RUNS_PG_URL` (CI Postgres): a child process runs a definition whose tool signals before executing; the parent SIGKILLs it after the model entry commits; a second child resumes; one model call, one side effect recorded                                                                     |
| `packages/database-plugin/test/unit/agent-run-store.test.ts`                 | `database-agent-run-store.ts`                    | every port method over memory; `verify()` refusal; counters; orphan handling                                                                                                                                                                                                                                    |
| `packages/database-plugin/test/integration/agent-run-store-postgres.test.ts` | same, Drizzle on Postgres                        | guarded real run of the conformance cases                                                                                                                                                                                                                                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m136-durable-runs, never main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm test:coverage common agent-runs-plugin database-plugin idempotency-plugin
pnpm run ci:local           # on the final commit
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

## 8. Risks & mitigations

- **A tool's outside call repeats after a crash before commit.** → Documented (C3); the tool gets a
  stable `run.idempotencyKey` to pass to the outside API; the e2e asserts one recorded effect.
- **Chunk writes add database load.** → Batching (§3.9), bounded log, purge; the guide gives sizes.
- **Polling tails cost queries on other instances.** → Only while a client is connected to an
  instance that does not hold the run; `pollIntervalMs` is configurable.
- **Clock skew between instances.** → The relay's skew margin and self-fencing (§3.4); the lease
  holder's own writes are fenced regardless of clocks.
- **A long model call outlives `waitUntil` on Workers (the `background` option).** → The sweep
  resumes it; the guide says so.
- **`ai` 8 changes the parts used.** → Peer range `<8`; the real-import test fails on drift.

## 8a. Design security review

**Flow reviewed:** a request starts, reads, decides or cancels a run; the plugin calls the model and
tools as that run's tenant and principal, including after a restart with no request.

**Assets:** each tenant's run inputs, transcripts and tool effects; the approval decision.

**Attackers:** a tenant user reading or acting on another tenant's run; a principal approving a call
it may not approve; a client replaying or forging an approval; a stale worker.

| #   | Obligation                                                    | Mechanism                                                                | Probe (positive and negative control)                                                                  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| O1  | No cross-tenant read or action on a run.                      | `tenantId` on every row; method-level check; same 404 as missing (§3.11) | `tenancy.test.ts` for every method; negative control: the check removed fails each row                 |
| O2  | Only an allowed principal decides, once.                      | `canDecide`; conditional write on `status: pending` (§3.7)               | second decision 409; other principal 403; negative control: unconditional update lets a second through |
| O3  | No client-forged approval or tool result.                     | approvals are server rows; tool results only from execution              | a client-sent `tool-approval-response` in input messages is ignored (the loop rebuilds from entries)   |
| O4  | A stale worker cannot write.                                  | fenced writes (§3.4)                                                     | G2; negative control: an unconditioned write lands                                                     |
| O5  | A resumed run acts as the original tenant and principal only. | identity from the run row into `toolsContext`/`AgentRunContext`          | `tool-runner.test.ts` asserts the context; the idempotency scope uses them                             |
| O6  | Served errors and logs leak no inputs, ids or provider text.  | value-free hints (§3.11)                                                 | hint detail assertions                                                                                 |
| O7  | Hostile options or rows cannot disable a bound.               | option validation; row decoding refuses ill-formed counters              | NaN/Infinity/negative options refused; a row with a non-integer counter is skipped by the sweep        |

The committed-tree audit on the final commit follows `.roo/skills/security-audit/SKILL.md` in a
fresh agent: the milestone crosses a trust boundary (approvals, tenancy, background execution).

## 9. Out of scope

- `setu add agent-runs` and an example app — after the API has been used once (follow-on).
- General workflows, sub-agents, parallel runs, and an engine adapter (decided against; the guide).
- Storing tool input deltas in the log (final input is stored in the tool part).
- The `ISseConnection.send` JSDoc mismatch (C5) — a separate `fix/` change.
