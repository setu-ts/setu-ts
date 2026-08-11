# Runtime Deployment

This guide covers deploying Setu-TS applications to different runtime environments: Node.js, Deno,
Bun, and Cloudflare Workers.

## Runtime Overview

| Runtime                | Package Manager   | HTTP Model     | Best For                          |
| ---------------------- | ----------------- | -------------- | --------------------------------- |
| **Deno**               | deno              | fetch / listen | Modern TypeScript, security-first |
| **Node.js**            | npm / pnpm / yarn | fetch / listen | Legacy compatibility, ecosystem   |
| **Bun**                | bun               | fetch / listen | Performance, npm compatibility    |
| **Cloudflare Workers** | npm / deno        | fetch only     | Edge computing, global scale      |

## Common Patterns

### Fetch vs Listen

Setu-TS applications can run in two modes:

1. **Fetch mode**: Exports a `fetch` handler (Workers, testing)
2. **Listen mode**: Binds to a TCP port (Node, Deno, Bun)

```typescript
// Fetch mode (Workers, testing)
// On Workers, `env` comes from `cloudflare:workers` and is passed to the plugins
// (see the Workers section below). Off Workers, `app.fetch(request)` is the test entry point.
// Startup must precede the fetch — use a memoized startup so concurrent first
// requests all await the same start rather than racing.
let _app: Promise<typeof app> | undefined;
async function started(): Promise<typeof app> {
  if (_app === undefined) {
    _app = (async () => {
      await app.start();
      return app;
    })();
    await _app;
  }
  return await _app;
}
export default {
  fetch(request: Request): Promise<Response> {
    return started().then((s) => s.fetch(request));
  },
};

// Listen mode (Node, Deno, Bun)
await app.start({ port: 3000 });
```

### Streaming Responses

All runtimes support streaming responses via `IResponse.stream()`:

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices } from '@setu-ts/common';

const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    runtime.setTimeout(resolve, ms);
  });

app.router.get('/stream', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 10; i++) {
        controller.enqueue(new TextEncoder().encode(`Line ${i}\n`));
        await delay(100);
      }
      controller.close();
    },
  });
  return ctx.response.stream(stream);
});
```

### SSE (Server-Sent Events)

```typescript
import { SsePlugin } from '@setu-ts/sse-plugin';
import { CAPABILITIES, type ISseService } from '@setu-ts/common';

app.register(SsePlugin({ heartbeatMs: 15_000, retryMs: 3_000 }));

app.router.get('/events', async (ctx) => {
  const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
  const conn = sse.open(ctx);
  conn.send({ id: '1', data: 'hello world' });
  return conn.result;
});
```

---

## Node.js Deployment

### Prerequisites

- Node.js 18+ or 20+
- npm, pnpm, or yarn

### Setup

```bash
# Create a new Node.js project
npm init -y

# Add Setu-TS packages via JSR
npm install jsr:@setu-ts/kernel@^0.1.0-alpha.5
npm install jsr:@setu-ts/runtime@^0.1.0-alpha.5
npm install jsr:@setu-ts/common@^0.1.0-alpha.5
```

### Application

```typescript
// main.ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();

// RuntimePlugin() auto-detects Node and selects NodeHttpAdapter.
app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello from Node.js!' });
});

await app.start({ port: 3000, hostname: '0.0.0.0' });

console.log('Server running on http://localhost:3000');
```

### package.json

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx main.ts",
    "dev": "tsx watch main.ts"
  },
  "devDependencies": {
    "tsx": "^4.20.0"
  },
  "imports": {
    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.1.0-alpha.5",
    "@setu-ts/runtime": "jsr:@setu-ts/runtime@^0.1.0-alpha.5",
    "@setu-ts/common": "jsr:@setu-ts/common@^0.1.0-alpha.5"
  }
}
```

> **Node needs a transform, not just type stripping.** `--experimental-strip-types` erases types
> without transforming code, so it cannot run a legacy decorator (a bare `SyntaxError`) or a
> constructor parameter property (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`), and
> `--experimental-transform-types` still rejects the decorator because it does not enable
> `experimentalDecorators`. `tsx` reads the `experimentalDecorators` in your `tsconfig.json` and
> runs all of it, which is why `setu new --runtime node` emits exactly this. Compiling ahead of time
> with `tsc` and running the JavaScript works equally well.

### Deployment

#### Docker

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3000
CMD ["npm", "start"]
```

#### PM2

```bash
npm install -g pm2
# Run the `start` script, so PM2 launches the same tsx entry point npm does.
pm2 start npm --name my-app -- start
```

#### Serverless

Use a serverless adapter for your platform (Vercel, AWS Lambda, etc.).

### Limitations

- Raw sockets (for some brokers) require Node.js
- Worker threads available (`worker-pool-plugin`)
- File system fully available

---

## Deno Deployment

### Prerequisites

- Deno 2.x

### Setup

```bash
# Install Deno
curl -fsSL https://deno.land/install.sh | sh

# Create a new project
deno init

# Add Setu-TS packages
deno add jsr:@setu-ts/kernel jsr:@setu-ts/runtime jsr:@setu-ts/common
```

### Application

```typescript
// main.ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();

app.register(RuntimePlugin()); // DenoHttpAdapter is default

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello from Deno!' });
});

await app.start({ port: 3000, hostname: '0.0.0.0' });

console.log('Server running on http://localhost:3000');
```

### deno.json

```json
{
  "tasks": {
    "start": "deno run --allow-net --allow-env main.ts",
    "dev": "deno run --watch --allow-net --allow-env main.ts"
  },
  "imports": {
    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.1.0-alpha.5",
    "@setu-ts/runtime": "jsr:@setu-ts/runtime@^0.1.0-alpha.5",
    "@setu-ts/common": "jsr:@setu-ts/common@^0.1.0-alpha.5"
  }
}
```

### Permissions

```bash
# Network access
deno run --allow-net main.ts

# Environment variables
deno run --allow-env main.ts

# File system
deno run --allow-read --allow-write main.ts

# All permissions (development only)
deno run -A main.ts
```

### Deployment

#### Deno Deploy

1. Push code to GitHub
2. Connect repository at [dash.deno.com](https://dash.deno.com)
3. Deploy automatically

#### Docker

```dockerfile
FROM denoland/deno:alpine

WORKDIR /app

COPY . .
RUN deno cache main.ts

EXPOSE 3000
CMD ["run", "--allow-net", "--allow-env", "main.ts"]
```

#### Compiled Binary

```bash
deno compile --allow-net --allow-env --output my-app main.ts
./my-app
```

### Limitations

- None significant - Deno is the reference implementation

---

## Bun Deployment

### Prerequisites

- Bun 1.x

### Setup

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Create a new project
bun init

# Add Setu-TS packages
bun add jsr:@setu-ts/kernel@^0.1.0-alpha.5
bun add jsr:@setu-ts/runtime@^0.1.0-alpha.5
bun add jsr:@setu-ts/common@^0.1.0-alpha.5
```

### Application

```typescript
// main.ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();

// RuntimePlugin() auto-detects Bun and selects BunHttpAdapter.
app.register(RuntimePlugin());

app.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello from Bun!' });
});

await app.start({ port: 3000, hostname: '0.0.0.0' });

console.log('Server running on http://localhost:3000');
```

### package.json

```json
{
  "type": "module",
  "scripts": {
    "start": "bun run main.ts",
    "dev": "bun run --watch main.ts"
  }
}
```

### Deployment

#### Docker

```dockerfile
FROM oven/bun:latest

WORKDIR /app

COPY . .
RUN bun install

EXPOSE 3000
CMD ["bun", "run", "start"]
```

#### Compiled Binary

```bash
bun build --compile --outfile my-app main.ts
./my-app
```

### Limitations

- Some npm packages may not be compatible
- Worker threads available

---

## Cloudflare Workers Deployment

### Prerequisites

- Wrangler CLI
- Cloudflare account

### Setup

```bash
# Install Wrangler
npm install -g wrangler

# Login to Cloudflare
wrangler login

# Create a new Worker
wrangler init my-app --type=typescript

# Add Setu-TS packages
npm add jsr:@setu-ts/kernel@^0.1.0-alpha.5
npm add jsr:@setu-ts/runtime@^0.1.0-alpha.5
npm add jsr:@setu-ts/common@^0.1.0-alpha.5
```

### Application

```typescript
// src/index.ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import { env, waitUntil } from 'cloudflare:workers';

// `env` (bindings + variables) and `waitUntil` are imported from `cloudflare:workers`
// and passed to the plugins. RuntimePlugin auto-detects Workers and selects
// CloudflareWorkersHttpAdapter; `env` populates `runtime.env`.
const raw = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({ env, waitUntil }),
  ],
});

raw.router.get('/', async (ctx) => {
  return ctx.response.json({ message: 'Hello from Workers!' });
});

// Memoized startup: the application starts once (awaited by all concurrent
// first requests) and the result is reused. This avoids racing two concurrent
// cold-start requests both trying to start the app independently.
let application: Promise<typeof raw> | undefined;

async function app(): Promise<typeof raw> {
  if (application === undefined) {
    application = (async () => {
      await raw.start();
      return raw;
    })();
    await application;
  }
  return await application;
}

// Export the fetch handler — Workers invokes this per request.
// Startup (app.start()) always precedes the fetch call.
export default {
  fetch(request: Request): Promise<Response> {
    return app().then((started) => started.fetch(request));
  },
};
```

### wrangler.toml

```toml
name = "my-app"
main = "src/index.ts"
compatibility_date = "2025-08-08"

# Bind KV namespaces
[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"

# Bind D1 databases
[[d1_databases]]
binding = "DB"
database_name = "my-database"
database_id = "your-database-id"

# Bind Queues
[[queues.producers]]
queue = "my-queue"
binding = "QUEUE"

# Cron triggers
[triggers]
crons = ["*/5 * * * *"]
```

### Deployment

```bash
# Deploy
wrangler deploy

# View logs
wrangler tail

# Open in browser
wrangler open
```

### Limitations

| Feature                   | Status | Notes                            |
| ------------------------- | ------ | -------------------------------- |
| TCP sockets               | ❌     | Use HTTP-based services          |
| File system               | ❌     | Use R2 or KV for storage         |
| Worker threads            | ❌     | Use worker-pool-plugin (limited) |
| Raw sockets (WebSocket)   | ✅     | Via WebSocket upgrade            |
| Cron                      | ✅     | Via Wrangler triggers            |
| Queues                    | ✅     | Via Workers Queues               |
| Messaging (pub/sub)       | ✅     | Via Workers Queues               |
| Messaging (request/reply) | ✅     | Via a Durable Object reply inbox |
| KV                        | ✅     | Via KV bindings                  |
| D1                        | ✅     | Via D1 bindings                  |
| R2                        | ✅     | Via R2 bindings                  |
| Durable Objects           | ✅     | Via DO bindings                  |

### Messaging on Workers

`@setu-ts/messaging-plugin` cannot run here — every broker but the in-memory default needs a raw
socket. `CloudflarePlugin` registers `CAPABILITIES.MESSAGING` from the platform instead, so
`publish`/`subscribe`/`request`/`respond` work at the edge with no code change at the call site.

Two things about it are structural rather than incidental. First, delivery arrives through a
**module-level `queue` export**, not through `fetch` — `subscribe()` registers a handler into a
dispatch table, and the handler `createMessagingHandler(app)` builds is what routes a delivered
batch into it:

```typescript
import type { IApplication } from '@setu-ts/common';
import { createMessagingHandler } from '@setu-ts/cloudflare-plugin';

// A Worker's src/index.ts exports both entry points from one application.
export function workerEntry(application: IApplication) {
  return {
    fetch: (request: Request) => application.fetch(request),
    queue: createMessagingHandler(application),
  };
}
```

Second, the consuming queue **must** set `max_batch_timeout = 0` in `wrangler.toml`. The platform
default of 5s alone exhausts the default request/reply budget, so a nonzero value makes every RPC
time out. A queue also has exactly one active consumer, so cross-service fan-out over one topic is
not available.

`setu new --template microservice --runtime cloudflare-workers` scaffolds this wiring, including the
`wrangler.toml` stanzas — see the [CLI Guide](./cli.md#runtime-targets).

### Runtime Environment

Access platform bindings via `CloudflarePlugin`, which publishes an
[`ICloudflareBindings`](../packages/cloudflare-plugin/src/bindings/binding-registry.ts) service
under `CAPABILITIES.CLOUDFLARE`. Each binding is reached through a named accessor — `kv('KV')`,
`d1('DB')`, `r2('BUCKET')`, `queue('QUEUE')` — rather than property access, and a missing binding
throws `CloudflareBindingMissingError` naming what was requested and what is present. The plugin
requires the Worker's `env` (and optionally `waitUntil`):

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  CloudflarePlugin,
  type ICloudflareBindings,
  type ID1Database,
  type IKvNamespace,
  type IQueueProducer,
  type IR2Bucket,
} from '@setu-ts/cloudflare-plugin';
import { CAPABILITIES } from '@setu-ts/common';

// Deployment glue: at runtime `env` and `waitUntil` come from
// `import { env, waitUntil } from 'cloudflare:workers'`. That specifier is
// unresolvable off a Worker toolchain, so this block declares a minimal,
// explicitly typed binding record compatible with `CloudflarePluginOptions`
// rather than importing it — the real Worker passes the platform's `env`, which
// satisfies this shape structurally. Do not invent members the Worker does not
// carry; name only the bindings your wrangler.toml declares.
//
// `CloudflareWorkerEnv` is `Readonly<Record<string, unknown>>`, so a named-only
// interface (which lacks the string index signature) is NOT assignable to it.
// An intersection with `Record<string, unknown>` keeps the named accessors for
// type-safe binding use AND satisfies the index signature the plugin requires.
type WorkerEnv = Readonly<Record<string, unknown>> & {
  readonly KV: IKvNamespace;
  readonly DB: ID1Database;
  readonly BUCKET: IR2Bucket;
  readonly QUEUE: IQueueProducer;
  readonly API_KEY: string;
};

// `waitUntil` is the platform's background-work sink; `env` is the binding record.
declare const env: WorkerEnv;
declare const waitUntil: (promise: Promise<unknown>) => void;

const app = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({ env, waitUntil }),
  ],
});

async function reportUsage(_value: string | null): Promise<void> {
  // ...report to your metrics backend...
}

app.router.get('/', async (ctx) => {
  const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);

  // KV — `kv('KV')` resolves the KV namespace bound as `KV` in wrangler.toml.
  await cf.kv('KV').put('key', 'value');
  const value = await cf.kv('KV').get('key');

  // D1 — `d1('DB')` resolves the D1 database bound as `DB`.
  const result = await cf.d1('DB').prepare('SELECT * FROM items').all();

  // R2 — `r2('BUCKET')` resolves the R2 bucket bound as `BUCKET`.
  await cf.r2('BUCKET').put('file.txt', new ArrayBuffer(0));

  // Queues — `queue('QUEUE')` resolves the Queues producer bound as `QUEUE`.
  await cf.queue('QUEUE').send({ type: 'event' });

  // waitUntil keeps the invocation alive for background work past the response.
  cf.waitUntil(reportUsage(value));

  return ctx.response.json({ ok: true, rows: result.results.length });
});
```

---

## Runtime Comparison

| Feature               | Node.js | Deno   | Bun    | Workers      |
| --------------------- | ------- | ------ | ------ | ------------ |
| **Startup Speed**     | Medium  | Fast   | Fast   | Instant      |
| **Cold Start**        | Slow    | Medium | Fast   | < 1ms        |
| **File System**       | ✅      | ✅     | ✅     | ❌ (R2/KV)   |
| **TCP Sockets**       | ✅      | ✅     | ✅     | ❌           |
| **Worker Threads**    | ✅      | ✅     | ✅     | ❌           |
| **npm Compatibility** | ✅      | ✅     | ✅     | ✅ (limited) |
| **Security**          | opt-in  | opt-in | opt-in | sandboxed    |
| **Edge Deploy**       | ❌      | ✅     | ❌     | ✅           |

---

## Best Practices

### 1. Use Runtime Detection

```typescript
const platform = ctx.runtime.platform();
if (platform === 'cloudflare-workers') {
  // Workers-specific logic
}
```

### 2. Handle Missing Services Gracefully

```typescript
if (ctx.runtime.fs) {
  const content = await ctx.runtime.fs.readFile('file.txt');
} else {
  // Fallback for Workers
  const content = await ctx.services.get<ICacheStore>(CAPABILITIES.CACHE).get('file.txt');
}
```

### 3. Configure Timeouts Appropriately

```typescript
// Workers have 120s max execution
// Node/Deno/Bun can run longer
const timeout = platform === 'cloudflare-workers' ? 60_000 : 300_000;
```

### 4. Use Platform-Specific Storage

```typescript
// Workers: KV, R2, D1
// Node/Deno/Bun: File system, databases
```

### 5. Test on Target Runtime

```bash
# Test locally with Wrangler
wrangler dev

# Test with Deno
deno task start

# Test with Bun
bun run start
```

---

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Catalog](./plugins.md) - Runtime compatibility per plugin
- [Examples](./examples.md) - Platform-specific examples
