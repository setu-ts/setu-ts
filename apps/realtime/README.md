# Realtime backplane example

Each process creates one replica using the Redis transport (never the process-local memory
transport).

```bash
cd apps/realtime
REDIS_URL=redis://127.0.0.1:6379 deno task start 3000
REDIS_URL=redis://127.0.0.1:6379 deno task start 3001
```

The smoke task reports a skip until `REDIS_URL` is available; the two-replica client harness remains
to be completed.
