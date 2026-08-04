# Cloudflare Workers example

An injected Workers `env` reaches both `RuntimePlugin` and `CloudflarePlugin`; the Worker reads and
writes the `EXAMPLE_KV` binding and exports a cron handler.

```bash
cd apps/cloudflare
deno task start
```

Create a local KV namespace and replace the placeholder id before using this in a real account. The
smoke task reports a skip when Wrangler is unavailable.
