# @hono-enterprise/runtime

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, and Bun.

This package implements the runtime-independence seam: every runtime-specific operation the
framework needs is abstracted behind `IRuntimeServices` (defined in `@hono-enterprise/common`) and
provided here under the `CAPABILITIES.RUNTIME` token by the `RuntimePlugin`. No other package ever
touches `process`, `Deno`, `Bun`, or `node:`/`deno:`/`bun:` modules directly.

## Installation

```bash
# Deno
deno add jsr:@hono-enterprise/runtime

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @hono-enterprise/runtime
```

## What's Inside

| Area            | Exports                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| Plugin          | `RuntimePlugin`, `RuntimeOptions`                                       |
| Detection       | `detectRuntime`, `GlobalScope`                                          |
| Deno adapter    | `createDenoRuntimeServices`, `DenoHost`, `DenoFileInfo`, `DenoDirEntry` |
| Node adapter    | `createNodeRuntimeServices`, `NodeHost`, `NodeFsInfo`                   |
| Bun adapter     | `createBunRuntimeServices`, `BunHost`, `BunFileInfo`                    |
| Cloudflare stub | `createCloudflareRuntimeServices` (throws — not yet implemented)        |

## Usage

Register the plugin in every application — it is mandatory:

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/info', (ctx) => {
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  return ctx.response.json({
    platform: runtime.platform(),
    requestId: runtime.uuid(),
  });
});

await app.start({ port: 3000 });
```

Force a specific platform (useful for testing):

```typescript
RuntimePlugin({ platform: 'node' });
```

## Architecture

Cross-runtime operations (UUID, random bytes, SubtleCrypto, `now`, `hrtime`, timers) are identical
across Node 18+, Deno, and Bun because they rely on web-standard APIs on `globalThis`. They are
implemented once in `src/services/cross-runtime.ts`.

Divergent operations (platform, version, hostname, env, exit, fs) are implemented per-adapter via
dependency injection: each factory accepts a `*Host` interface describing only what it needs,
defaulting to the real runtime global via a single boundary cast. This makes every adapter fully
unit-testable on Deno by passing a fake host — no real Node/Bun, no OS permissions.

## Scope

M3 provides runtime services only. HTTP server adapters are deferred to a dedicated milestone — see
ROADMAP.md.

See the repository's [`PUBLIC_API.md`](../../PUBLIC_API.md) for the full API contract and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for how this package fits the plugin architecture.
