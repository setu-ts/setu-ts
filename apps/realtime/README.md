# Realtime backplane example

Each process creates one replica using the Redis transport (never the process-local memory
transport).

```bash
cd apps/realtime
REDIS_URL=redis://127.0.0.1:6379 deno task start 3000
REDIS_URL=redis://127.0.0.1:6379 deno task start 3001
```

The smoke task starts two replicas **as separate processes**, subscribes an SSE client to B, then
proves a publish to A reaches that client. It reports a skip only when `REDIS_URL` is unavailable.

The separate processes are what makes the check mean anything: run both replicas inside one process
and the backplane's process-local `'memory'` transport delivers the message on its own, so the check
passes without any cross-replica delivery. Swapping this example to `transport: 'memory'` must make
`deno task smoke` fail.
