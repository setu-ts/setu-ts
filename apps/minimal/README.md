# Minimal example

The smallest Setu-TS application: the kernel, the runtime plugin, and one route.

```bash
pnpm --dir apps/minimal run start
pnpm --dir apps/minimal run smoke
```

The smoke check proves `GET /` returns `200` with a JSON greeting without opening a socket.

Read the [example deep dive](../../docs/examples.md#minimal) for the concept and source walkthrough.
