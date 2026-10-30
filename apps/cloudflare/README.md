# Cloudflare Workers example

An injected Workers `env` reaches the Workers-only runtime composition and `CloudflarePlugin`; the
Worker reads and writes the `EXAMPLE_KV` binding and exports a cron handler. The runtime composition
uses the public Workers adapters directly so Wrangler's bundled Worker never evaluates Node, Deno,
or Bun adapters.

Wrangler is not a dependency of this example; install it, then run the Worker locally from this
directory:

```bash
cd apps/cloudflare
wrangler dev --local
```

`GET /diag/platform` answers with the detected runtime. `pnpm --dir apps/cloudflare run smoke` runs
the checks CI runs.

Create a local KV namespace and replace the placeholder id before using this in a real account. The
smoke task starts local Wrangler, reads and writes KV, and invokes the scheduled handler; it skips
only when Wrangler is unavailable.

Read the [example deep dive](../../docs/examples.md#cloudflare) for the concept and source
walkthrough.
