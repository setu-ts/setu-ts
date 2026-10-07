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
// Startup must precede the fetch. Share one start across concurrent first
// requests, but forget a FAILED start so the next request retries it — caching
// the rejection would leave the instance answering errors for its whole life.
let starting: Promise<typeof app> | undefined;
function started(): Promise<typeof app> {
  starting ??= app.start().then(() => app).catch((error: unknown) => {
    starting = undefined;
    throw error;
  });
  return starting;
}
export default {
  async fetch(request: Request): Promise<Response> {
    return (await started()).fetch(request);
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

- Node.js 22+ (`Promise.withResolvers` is used in five packages and shipped in Node 22; CI verifies
  on Node 24)
- npm, pnpm, or yarn

### Setup

```bash
# Create a new Node.js project
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module

# Add Setu-TS packages from JSR (npm has no `jsr:` protocol, so `npm install jsr:…` fails)
npx jsr add @setu-ts/kernel @setu-ts/runtime @setu-ts/common
npm install --save-dev tsx
```

`npx jsr add` writes ordinary npm dependencies and an `.npmrc` that points the `@jsr` scope at JSR's
npm registry, so imports stay `@setu-ts/kernel`. Or let `setu new my-app --runtime node` scaffold
all of this.

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
  "dependencies": {
    "@setu-ts/common": "npm:@jsr/setu-ts__common@^0.8.0",
    "@setu-ts/kernel": "npm:@jsr/setu-ts__kernel@^0.8.0",
    "@setu-ts/runtime": "npm:@jsr/setu-ts__runtime@^0.8.0"
  },
  "devDependencies": {
    "tsx": "^4.20.0"
  }
}
```

> **Node needs a transform, not just type stripping.** `--experimental-strip-types` erases types
> without transforming code, so it cannot run a decorator or a constructor parameter property
> (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`). That applies to TC39 **standard** decorators too, which is
> what this framework uses: V8 has not shipped them, so `node` answers a decorated class with a bare
> `SyntaxError: Invalid or unexpected token`. `tsx` transforms both and needs no compiler option,
> which is why `setu new --runtime node` emits exactly this. Compiling ahead of time with `tsc` and
> running the JavaScript works equally well.

### Deployment

#### Docker

```dockerfile
# Node 22 or later: the framework uses Promise.withResolvers.
FROM node:24-alpine

WORKDIR /app

COPY package*.json .npmrc ./
RUN npm ci

COPY . .

# Numeric, not `USER node`: Kubernetes' runAsNonRoot refuses an image whose user is a name.
USER 1000:1000

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

- Raw TCP sockets available, which the Redis, RabbitMQ, NATS and Kafka brokers need (Deno and Bun
  have them too; only Workers does not)
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

# Create a new project. `deno add` creates deno.json; skip `deno init`, whose main_test.ts
# imports a `handler` export your main.ts will not have, which breaks `deno test`.
mkdir my-app && cd my-app

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
    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.8.0",
    "@setu-ts/runtime": "jsr:@setu-ts/runtime@^0.8.0",
    "@setu-ts/common": "jsr:@setu-ts/common@^0.8.0"
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
# Pin the tag: a base older than the Deno that wrote your deno.lock fails with
# "Unsupported lockfile version".
FROM denoland/deno:alpine-2.9.5

WORKDIR /app

COPY . .
RUN deno cache main.ts

# Numeric, not `USER deno`: Kubernetes' runAsNonRoot refuses an image whose user is a name.
USER 1000:1000

EXPOSE 3000
CMD ["run", "--allow-net", "--allow-env", "main.ts"]
```

> This snippet is for **your own** project, where dependencies come from JSR. To build an image of
> an example in this repository, use the parameterized [`docker/Dockerfile`](../docker/Dockerfile)
> instead — it builds from the repository root, which the workspace requires. See
> [Deployment](./deployment.md).

#### Compiled Binary

```bash
deno compile --allow-net --allow-env --output my-app main.ts
./my-app
```

### Limitations

- None significant - Deno is the reference implementation

---

### Local diagnostics listener (Deno only)

The RuntimePlugin provides `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER` — a factory that binds exactly
ONE additional IPv4 loopback (`127.0.0.1`) listener on a port you choose (1024–65535), consumed by
`@setu-ts/diagnostics-plugin` for the authenticated local diagnostics connection. On Node, Bun, and
Cloudflare Workers the factory refuses every `listen` call before any bind. This listener is not a
generic second HTTP server API: the connector supplies its protocol handler and never receives an
adapter or server handle. See `docs/diagnostics-protocol.md` for the wire protocol and its trust
limits.

## Bun Deployment

### Prerequisites

- Bun 1.x

### Setup

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Create a new project
mkdir my-app && cd my-app
bun init -y

# Add Setu-TS packages from JSR (`bun add jsr:…` is refused as an invalid dependency name)
bunx jsr add @setu-ts/kernel @setu-ts/runtime @setu-ts/common
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
# Scaffold a Worker: wrangler.toml, package.json and the entry module below
setu new my-app --runtime cloudflare-workers
cd my-app && npm install

# Or add Setu-TS to an existing Worker (npm has no `jsr:` protocol, so `npm add jsr:…` fails)
npx jsr add @setu-ts/kernel @setu-ts/runtime @setu-ts/cloudflare-plugin @setu-ts/common

# Log in to Cloudflare once, before the first deploy
npx wrangler login
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

// Start once, on the first request, and share that start across concurrent
// requests. A FAILED start is forgotten rather than cached, so a transient
// problem at cold start is retried on the next request instead of breaking the
// isolate for its whole life.
let application: Promise<typeof raw> | undefined;

function app(): Promise<typeof raw> {
  application ??= raw.start().then(() => raw).catch((error: unknown) => {
    application = undefined;
    throw error;
  });
  return application;
}

// Export the fetch handler — Workers invokes this per request.
export default {
  async fetch(request: Request): Promise<Response> {
    return (await app()).fetch(request);
  },
};
```

The entry `setu new --runtime cloudflare-workers` generates goes further: it takes `env` from each
request rather than from the module, keeps one application per binding set so a deploy that changes
only bindings is served with the new ones even when Cloudflare reuses the isolate, and stops a
superseded application only once no request or queue batch still uses it.

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

| Feature                   | Status | Notes                                                                         |
| ------------------------- | ------ | ----------------------------------------------------------------------------- |
| TCP sockets               | ❌     | Use HTTP-based services                                                       |
| File system               | ❌     | Use R2 or KV for storage                                                      |
| Worker threads            | ❌     | worker-pool-plugin registers, but `run()` throws `WorkerPoolUnavailableError` |
| Raw sockets (WebSocket)   | ✅     | Via WebSocket upgrade                                                         |
| Cron                      | ✅     | Via Wrangler triggers                                                         |
| Queues                    | ✅     | Via Workers Queues                                                            |
| Messaging (pub/sub)       | ✅     | Via Workers Queues                                                            |
| Messaging (request/reply) | ✅     | Via a Durable Object reply inbox                                              |
| KV                        | ✅     | Via KV bindings                                                               |
| D1                        | ✅     | Via D1 bindings                                                               |
| R2                        | ✅     | Via R2 bindings                                                               |
| Durable Objects           | ✅     | Via DO bindings                                                               |

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

Runtime services live in the registry under `CAPABILITIES.RUNTIME`, so a request handler resolves
them there (only a plugin's `register` context carries them as `ctx.runtime`):

```typescript
import { CAPABILITIES, type IRuntimeServices } from '@setu-ts/common';

app.router.get('/platform', (ctx) => {
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  if (runtime.platform() === 'cloudflare-workers') {
    // Workers-specific logic
  }
  return ctx.response.json({ platform: runtime.platform() });
});
```

### 2. Handle Missing Services Gracefully

Optional runtime members such as `fs` are absent where the platform cannot provide them, so check
before use:

```typescript
import { CAPABILITIES, type ICacheStore, type IRuntimeServices } from '@setu-ts/common';

app.router.get('/notice', async (ctx) => {
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  const content = runtime.fs
    ? await runtime.fs.readFile('notice.txt')
    // Workers has no file system: read from a store instead
    : await ctx.services.get<ICacheStore>(CAPABILITIES.CACHE).get<string>('notice');
  return ctx.response.json({ content });
});
```

### 3. Know the Workers Execution Limits

An HTTP-triggered Worker has no wall-clock limit while the client stays connected, but CPU time is
capped: 10 ms per request on the free plan, and 30 seconds by default on paid plans, configurable up
to 5 minutes. Background work passed to `waitUntil()` gets at most 30 seconds after the response.
Long CPU-bound work belongs in a queue consumer or on a socket runtime.

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
