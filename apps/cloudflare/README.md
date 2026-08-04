# Cloudflare Workers example

An injected Workers `env` reaches the Workers-only runtime composition and `CloudflarePlugin`; the
Worker reads and writes the `EXAMPLE_KV` binding and exports a cron handler. The runtime composition
uses the public Workers adapters directly so Wrangler's bundled Worker never evaluates Node, Deno,
or Bun adapters.

```bash
cd apps/cloudflare
deno task start
```

Create a local KV namespace and replace the placeholder id before using this in a real account. The
smoke task starts local Wrangler, reads and writes KV, and invokes the scheduled handler; it skips
only when Wrangler is unavailable.
