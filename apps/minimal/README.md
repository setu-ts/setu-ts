# Minimal example

The smallest Hono Enterprise application: the kernel, the runtime plugin, and one route.

```bash
cd apps/minimal
deno task start
deno task smoke
```

The smoke check proves `GET /` returns `200` with a JSON greeting without opening a socket.
