# AI chat

A Node 24 example of the AI SDK on Setu: weighted per-tenant reservations, UI message streaming,
trusted tool context, provider fallback, content-free traces and transactional usage delivery. The
standalone recipe files under `src/` match the [AI guide](../../docs/ai.md); this example keeps
`chat.routes.ts` at that location so the guide's route is easy to find.

```bash
pnpm --dir apps/ai-chat run check
pnpm --dir apps/ai-chat run smoke
pnpm --dir apps/ai-chat run start
```

Set `AI_COMPAT_BASE_URL`, `AI_COMPAT_MODEL` and optionally `AI_COMPAT_API_KEY` on the server. The
start command defaults to `http://localhost:8080/v1` and model `local`, listens on port 3000 (or its
first argument), and serves `POST /chat` with JSON `{ "prompt": "Hello" }`. Set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to export through telemetry-plugin with `registerGlobal`. The
app pins one SDK release matching the installed `@ai-sdk/otel` dependency.

The demo tenancy resolver always returns `demo-tenant`; headers and body fields cannot choose
another budget or tool identity. Replace it with an authenticated membership-aware resolver in a
real application. The memory quota and database are process-local; production deployments need
shared quota storage and a durable database/outbox. Configure actual prices and conservative
template/media allowances. Prompt/completion capture is off; enabling it records unredacted content.

The smoke uses `MockLanguageModelV4` for the step cap, abort, UI parser, last-budget race,
outbox/inbox redelivery, trusted tools, fallback and structured output. Its in-process OTLP receiver
checks trace parenting and content capture with both negative and positive controls. The real
endpoint case skips unless `AI_COMPAT_BASE_URL` is set. Deno, Bun and Workers are unverified for
this recipe. There is a process-crash gap between the provider result and the outbox transaction;
usage is durable only after that write succeeds.
