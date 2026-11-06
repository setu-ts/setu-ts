# Durable support agent

Available from **0.12.0**. A support agent that looks up an order and asks a person to approve a
refund before it issues one. The run outlives the request and the process: reload the page, or stop
and restart the server, and the run carries on where it was. The refund is written exactly once
however often the run resumes. The example composes `@setu-ts/agent-runs-plugin` with the AI SDK,
the database plugin and tier C idempotency.

Run from the repository root after installing dependencies:

```bash
pnpm --dir apps/durable-agent run check
pnpm --dir apps/durable-agent run smoke
pnpm --dir apps/durable-agent run test
pnpm --dir apps/durable-agent run test:e2e
pnpm --dir apps/durable-agent run start:dev
```

`start:dev` runs the source with tsx and reads `.env`. `build` and `start` work as in the other
examples: in a fresh clone, compile the framework packages once with `pnpm exec tsc -b` from the
repository root before `build`.

## Configuration

Copy `.env.example` to `.env`.

| Variable             | Default                    | Meaning                                                                           |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| `AI_COMPAT_BASE_URL` | `http://localhost:8080/v1` | Any OpenAI-compatible chat server whose model can call tools.                     |
| `AI_COMPAT_MODEL`    | `local`                    | The model name that server expects.                                               |
| `AI_COMPAT_API_KEY`  | unset                      | Only for a hosted API.                                                            |
| `DATABASE_URL`       | unset                      | PostgreSQL. Unset keeps everything in process memory, lost when the process ends. |
| `PORT`               | `3000`                     | The listening port.                                                               |

To see a run survive a restart you need PostgreSQL: set `DATABASE_URL`, then create the tables and
the three demonstration orders once:

```bash
pnpm --dir apps/durable-agent run db:setup
```

`schema.sql` holds the tables: the example's orders and refunds, the idempotency records and the four
agent-run tables. Running it again changes nothing.

## Try it

Open `http://localhost:3000/ui` after `start:dev`. Ask for a refund, for example "My headphones on
order A-1001 rattle, please refund $45." The agent looks the order up, then shows an **Issue
refund** card with **Approve** and **Deny** and an optional reason. Nothing is refunded until you
decide. Approve, and the refund appears on the order in the right-hand panel.

Keep talking after an answer: "Can you check order A-1002?", then "Refund $20 of it." Each message
starts a new run, and the page sends the conversation so far with it, so the agent knows which order
"it" is. **New conversation** starts over.

Then try what the example is for:

- **Reload the page** at any point. The run id is in the URL, so the page finds the run again: a run
  still going is replayed from its stored stream, a finished one is rebuilt from its stored
  messages.
- **Stop the server while the refund waits for approval**, start it again and reload. The approval
  card is still there. Approve it from the new process and the run finishes.
- **Stop the server while the agent is working**, for example straight after you approve. The page
  says it lost the connection and keeps reconnecting. When the server is back, the run continues
  from its last committed step: the restarted server takes it over once the old process's lease
  has expired (about 35 seconds with the defaults). A refund that had already been written is not
  written again.
- **Change "Acting as"** to another name. Runs belong to the user who started them, so another user
  gets "does not exist" for the same run id.

The page has no build step: `public/index.html` and `public/run.js`, served by `StaticPlugin` at
`/ui`. It reads the AI SDK UI message stream itself and inserts everything as text, never as HTML.
A React front end would use the AI SDK's `useChat` with `resume: true` against `GET /runs/:id/stream`.

## What it serves

| Route                                                              | Meaning                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `POST /runs`                                                       | `{ "message": "...", "history": [...] }` starts a run and answers `202 { runId }`.      |
| `GET /runs/:id/stream`                                             | The run's AI SDK UI message stream. `204` when a finished run has nothing left to send. |
| `GET /runs/:id`                                                    | Status, the stored messages and the pending approvals, for a page reload.               |
| `POST /runs/:id/approvals/:approvalId`                             | `{ "approved": true, "reason": "..." }` decides one approval, once. Answers `202`.      |
| `POST /runs/:id/cancel`                                            | Cancels the run. Answers `202`.                                                         |
| `GET /orders`                                                      | The orders, with what has been refunded on each.                                        |
| `GET /`                                                            | Redirects to the page.                                                                  |
| `/health`, `/live`, `/ready`, `/metrics`, `/docs`, `/openapi.json` | As in every scaffolded project.                                                         |

`message` is 1–2,000 characters. `history` is optional: up to 20 earlier turns, each
`{ "role": "user" | "assistant", "content": "..." }` of at most 4,000 characters, which the run
passes to the model before `message`. They are the client's own text; tool calls and approvals
never travel that way, and the plugin strips any that try.

A run executes detached from the request that started it, so `POST /runs` returns at once. The
stream replays what is stored and then follows the live run. Event ids are
`<batch>.<index>.<epoch>`; a client that reconnects with `Last-Event-ID` gets exactly what came
after that event. If another server took the run over and rewrote positions the client had seen,
the stream sends a `data-setu-replay` chunk and the whole run again; `run.js` handles it by
discarding what it had.

**Identity is a demonstration.** `src/middleware/demo-user.middleware.ts` trusts the `x-demo-user`
header (default `demo`) as the caller, so anyone can act as anyone. It exists so the example can show
that runs belong to the person who started them without an identity provider. Replace it with
`AuthPlugin` before the application serves anyone but you.

## How it works

The project is what `setu new --template rest`, `setu generate module support`,
`setu generate plugin support-model`, `setu generate plugin support-data` and
`setu generate middleware demo-user` produce, plus the feature's own edits:

- `src/modules/support/support.agent.ts` defines the agent with `defineAgentRun`: the model,
  resolved for every step from the `support-model` capability; the `lookupOrder` and `issueRefund`
  tools; and an approval policy that always asks before `issueRefund`.
- Each tool call runs inside `IIdempotencyService.within`. Its writes go through the unit of work
  the run supplies (`toolsContext`), so the refund row commits in the same transaction as the call's
  recorded result. A run that resumes after a crash finds that result and does not call the tool
  again. The refund's id is the call's idempotency key, so one call can only ever write one row.
- `src/modules/support/support.controller.ts` maps the routes onto `IAgentRunService`: `start`,
  `respond`, `get`, `decide` and `cancel`.
- `src/modules/support/support.database.ts` picks PostgreSQL through Drizzle when `DATABASE_URL` is
  set, otherwise the memory database. `support.tables.ts` maps the entities to the tables in
  `schema.sql`.
- `src/plugins/support-model.plugin.ts` builds the model from the environment. Tests replace the
  capability with a scripted model.
- `src/plugins/support-data.plugin.ts` inserts the demonstration orders on the memory database.
- `setu.config.ts` adds `StaticPlugin`, the database, `IdempotencyPlugin` and `AgentRunsPlugin` to
  the generated composition.

The CLI-owned indexes (`src/modules/index.ts`, `src/plugins/index.ts`, `src/middleware/index.ts`
and the rest) are as the CLI writes them; `setu sync` reports them unchanged.

## Tests

- The `test` script: the module over the memory database and a scripted model: an approved refund is
  issued once, a denied one never, another user gets `404`, input is validated, cancel works, and
  `schema.sql` seeds the same orders as the memory database.
- `test:e2e`: the same over HTTP, including the stream's event ids, resuming after
  `Last-Event-ID`, the `204` for a finished run and the page.
- `smoke`: the flow again; with `DATABASE_URL` (or the repository's `AGENT_RUNS_PG_URL`) it
  also stops the application while a run waits for approval and finishes the run in a new one on
  the same PostgreSQL database, with one refund row. When a model server answers at
  `AI_COMPAT_BASE_URL`, one more case runs the real model.

The [durable runs guide](../../docs/durable-runs.md) explains the plugin itself.
