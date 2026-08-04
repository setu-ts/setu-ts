# Realtime backplane example

Each process creates one replica using the Redis transport (never the process-local memory
transport).

```bash
cd apps/realtime
REDIS_URL=redis://127.0.0.1:6379 deno task start 3000
REDIS_URL=redis://127.0.0.1:6379 deno task start 3001
```

The smoke task starts two replicas, subscribes an SSE client to B, then proves a publish to A
reaches that client. It reports a skip only when `REDIS_URL` is unavailable.
