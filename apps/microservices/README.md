# Microservices example

Service A resolves and calls service B through `ServiceDiscoveryPlugin`'s static provider. It also
demonstrates a brokered in-memory request/reply exchange.

```bash
cd apps/microservices
deno task start
deno task smoke
```
