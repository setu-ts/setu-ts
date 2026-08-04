# Microservices example

Service A resolves service B through `ServiceDiscoveryPlugin`'s static provider, then sends B an
in-memory brokered request/reply message.

```bash
cd apps/microservices
deno task start
deno task smoke
```
