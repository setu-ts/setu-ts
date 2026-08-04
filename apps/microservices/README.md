# Microservices example

Service A resolves and calls service B through `ServiceDiscoveryPlugin`'s static provider. With
`REDIS_URL` set, service B owns the Redis Streams `respond` handler and service A issues the
`request`, proving brokered request/reply crosses the service boundary. Without Redis, the smoke
check still proves discovery, reports the brokered half as skipped, and exits 77.

```bash
cd apps/microservices
deno task start
deno task smoke
```

```bash
REDIS_URL=redis://127.0.0.1:6379 deno task smoke
```
