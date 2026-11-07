# AI chat

A Node 24 example of the AI SDK on Setu: weighted per-tenant reservations, UI message streaming,
trusted tool context, provider fallback, content-free traces and transactional usage delivery. The
recipes match the [AI guide](../../docs/ai.md).

The project is what `setu new --template rest`, `setu generate module chat` and
`setu generate plugin chat-models` produce, plus the feature's own edits:

- `src/modules/chat/`: the controller (`registerChatRoutes(router, services?)` as generated), the
  budget middleware, the usage event, the request schema and the per-application quota.
- `src/plugins/chat-models.plugin.ts`: the models, built from the environment and registered under
  the `CHAT_MODELS` capability.
- `setu.config.ts`: the generated composition, plus the scheduler, memory database, demo tenancy,
  telemetry and messaging plugins.
- The CLI-owned indexes (`src/modules/index.ts`, `src/modules/chat/index.ts`, `src/plugins/index.ts`
  and the rest) are exactly as the CLI writes them; `setu sync` reports them unchanged.

```bash
pnpm --dir apps/ai-chat run check
pnpm --dir apps/ai-chat run test
pnpm --dir apps/ai-chat run smoke
pnpm --dir apps/ai-chat run start
```

Set `AI_COMPAT_BASE_URL`, `AI_COMPAT_MODEL` and optionally `AI_COMPAT_API_KEY` and
`AI_COMPAT_CONTEXT_TOKENS` on the server. The models default to `http://localhost:8080/v1` and model
`local`. The app listens on `PORT` (default 3000) and serves `POST /chat` with JSON
`{ "prompt": "Hello" }`. Set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to export through telemetry-plugin
with `registerGlobal`. The app pins one SDK release matching the installed `@ai-sdk/otel`
dependency. The compatible provider sets `includeUsage: true` so streamed calls report usage, and
the route allows 1024 output tokens. Retryable connection failures can fall back to the next
configured model.

## Chat page

Open `http://localhost:3000/ui` after `start` for a minimal chat page with no build step and no
dependencies: `public/index.html` and `public/chat.js`, served by `StaticPlugin` at `/ui` and left
out of the OpenAPI document. It posts to `POST /chat` and reads the response body as a stream of AI
SDK UI message events, so the answer, and the model's reasoning when it sends some, appears as it is
generated. Enter sends and Shift+Enter adds a line. **Stop** aborts the request; the route passes
`ctx.signal` to `streamText`, so the model call is cancelled too. Model output is inserted as text,
never as HTML.

The server keeps no conversation. The page sends the earlier turns with each question as `history`
(oldest first, at most 40 turns and 50,000 characters, dropping the oldest exchanges beyond that),
and the route passes them to the model before the new `prompt`. **New chat** clears them. The
history is the client's own text, so it is validated and priced as input like the prompt.

The route sends each turn's token usage on the stream's `finish` event as message metadata. The page
shows it under each answer, adds it to a session total, and shows how much of the model's context
window the last request filled (its input plus output tokens). An OpenAI-compatible API does not
report the window size, so set `AI_COMPAT_CONTEXT_TOKENS` (a llama.cpp server shows it as `n_ctx` at
`/props`); `GET /chat/model` returns it with the per-turn output limit. Without it the page shows
the token count and says the size is unknown. A real front end would use the AI SDK's `useChat`,
which reads the same stream and metadata.

To watch the raw events instead, keep curl from buffering:

```bash
curl -N -X POST localhost:3000/chat -H 'content-type: application/json' -d '{"prompt":"Hello"}'
```

The demo tenancy resolver always returns `demo-tenant`; headers and body fields cannot choose
another budget or tool identity. Replace it with an authenticated membership-aware resolver in a
real application. The memory quota and database are process-local; production deployments need
shared quota storage and a durable database/outbox. Configure actual prices and conservative
template/media allowances. Prompt/completion capture is off; enabling it records unredacted content.
Provider error messages are still logged and traced, and some providers quote input in them.

The smoke builds each app with `createApp()` and replaces the models through
`createTestApp({ overrides: [overrideCapability(CHAT_MODELS, …)] })`. It uses `MockLanguageModelV4`
for the step cap, abort, UI parser, last-budget race, outbox/inbox redelivery, trusted tools,
fallback and structured output. Its in-process OTLP receiver checks trace parenting and content
capture with both negative and positive controls. The real endpoint case skips unless
`AI_COMPAT_BASE_URL` is set. Deno, Bun and Workers are unverified for this recipe. There is a
process-crash gap between the provider result and the outbox transaction; usage is durable only
after that write succeeds.
