# realtime-clients

A live SSE/WebSocket server driven by the SDK clients; the smoke check exercises resume,
authentication and keep-alive. The smoke check needs Bun installed and runs Wrangler through `npx`.

Run from the repository root after installing dependencies:

```bash
pnpm --dir apps/realtime-clients run start 3400
pnpm --dir apps/realtime-clients run smoke
```

Read the [example deep dive](../../docs/examples.md#realtime-clients) for the concept and source
walkthrough.
