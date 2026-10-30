# Getting Started with Setu-TS

This guide takes you from an empty directory to a running, tested Setu-TS application, then shows
how to add the plugins most applications need.

## Prerequisites

- **Deno 2.x**, **Node.js 22.23.4+, 24.22.1+ or 26.12.1+**, or **Bun 1.x** — the framework uses
  `Promise.withResolvers`, which Node 22 was the first to ship, and those are the first releases of
  each line carrying the Node.js security fixes of 2026-10-21; CI verifies Node 24
- Basic familiarity with TypeScript

## Two ways to start

**Scaffold a project** if you want a working layout, tests, configuration, and a Dockerfile in one
step:

```bash
# Create a REST application on Node (add --runtime deno, bun, or cloudflare-workers to change target)
npm create @setu-ts my-app -- --template rest
cd my-app && npm install && npm run start:dev
```

The equivalent create forms are `pnpm create @setu-ts my-app --template rest` and
`bun create @setu-ts my-app --template rest` (neither needs `--`).
`npx @setu-ts/cli new my-app --template rest` runs the same generator;
`npm install --global @setu-ts/cli` makes it `setu new my-app --template rest`.

After `cd my-app`, a Bun target runs `bun install && bun run start:dev`; a Deno target runs
`deno task start:dev`; Workers runs `npm install && npx wrangler dev`. Use the development entry
while editing. For a Node production run, use `npm run build && npm start`.

The generated project's README lists its commands. See the [CLI guide](./cli.md) for templates and
code generation.

**Build it by hand** if you want to see every moving part. The rest of this guide does that — it is
three packages and about ten lines of code.

### A full-stack project

```bash
npm create @setu-ts my-app -- --template full-stack
cd my-app && npm install && npm run start:dev
```

The full-stack development entry runs Vite in the application process and serves route edits without
a production build. Node uses `npm run start:dev`, Bun `bun run start:dev`, and Deno
`deno task start:dev`. Workers uses `npm run dev`: Wrangler builds the client and server first,
without the in-process Vite loop or hot module replacement.

Production uses built output: Node runs `npm run build` then `npm start`; Bun runs `bun run build`
then `bun run start`; Deno's `deno task start` builds first. Workers ships with `npm run deploy`.
See [React Router development](./react-router-dev.md#in-a-scaffolded-project) for the loop and
[production builds](./cli.md#production-build-setu-build) for the service build.

## Installation

Setu-TS is published on [npm](https://www.npmjs.com/org/setu-ts) under the `@setu-ts` scope. Each
runtime installs it with its own tooling:

### Node.js

```bash
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module
npm install @setu-ts/kernel @setu-ts/runtime @setu-ts/common
```

`pnpm add` and `yarn add` work the same way.

### Bun

```bash
mkdir my-app && cd my-app
bun init -y
bun add @setu-ts/kernel @setu-ts/runtime @setu-ts/common
```

### Deno

```bash
mkdir my-app && cd my-app
deno add npm:@setu-ts/kernel npm:@setu-ts/runtime npm:@setu-ts/common
```

`deno add` creates the `deno.json` for you, mapping each `@setu-ts/…` import to its npm package.

Earlier releases were published on JSR (`jsr:@setu-ts/…`). They stay there, but nothing new is
published to JSR; see the [upgrading guide](upgrading.md) to move an existing project.

## Your First Application

Create `main.ts`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication();

// Required in every application: RuntimePlugin detects whether you are on Deno,
// Node, Bun, or Cloudflare Workers and supplies the HTTP server, timers, and
// environment for that platform. start() throws if it is missing.
app.register(RuntimePlugin());

// A handler receives the request context and returns a response built
// through ctx.response.
app.router.get('/hello', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));

await app.start({ port: 3000 });

console.log('Server running on http://localhost:3000');
```

A handler may be `async` when it awaits something; these two do not need to be.

### Running the Application

**Deno** — `--allow-net` to bind the port, `--allow-env` because `RuntimePlugin` reads the process
environment:

```bash
deno run --allow-net --allow-env main.ts
```

**Node.js:**

```bash
node main.ts
```

**Bun:**

```bash
bun run main.ts
```

### Try It

```bash
curl http://localhost:3000/hello
# {"message":"Hello, World!"}
```

## Testing Your Application

Choose your runtime's runner below. Each example puts the same test in `test/app.test.ts`: create a
test application, register `/hello`, inject a request, check the response, and stop it.
`createTestApp` starts without binding a port. The Node and Bun runners match the CLI-generated test
harness.

### Node

```bash
npm install -D @setu-ts/testing tsx
```

```typescript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('My Application', () => {
  it('handles GET /hello', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()] });
    try {
      app.router.get('/hello', (ctx) => ctx.response.json({ message: 'Hello, World!' }));
      const response = await inject(app, { method: 'GET', url: '/hello' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { message: 'Hello, World!' });
    } finally {
      await app.stop();
    }
  });
});
```

```bash
npx tsx --test test/app.test.ts
```

### Bun

```bash
bun add -d @setu-ts/testing
```

```typescript
import { describe, it, expect } from 'bun:test';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('My Application', () => {
  it('handles GET /hello', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()] });
    try {
      app.router.get('/hello', (ctx) => ctx.response.json({ message: 'Hello, World!' }));
      const response = await inject(app, { method: 'GET', url: '/hello' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ message: 'Hello, World!' });
    } finally {
      await app.stop();
    }
  });
});
```

```bash
bun test
```

### Deno

```bash
deno add npm:@setu-ts/testing jsr:@std/testing jsr:@std/expect
```

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('My Application', () => {
  it('handles GET /hello', async () => {
    const app = await createTestApp({ plugins: [RuntimePlugin()] });
    try {
      app.router.get('/hello', (ctx) => ctx.response.json({ message: 'Hello, World!' }));
      const response = await inject(app, { method: 'GET', url: '/hello' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ message: 'Hello, World!' });
    } finally {
      await app.stop();
    }
  });
});
```

```bash
deno test --allow-env
```

Once your application has a real composition root (a `createApp()` the server and the tests both
call), pass it as `createTestApp({ app: createApp() })` so tests run against exactly the plugins
production runs — see the [`@setu-ts/testing` README](../packages/testing/README.md).

## Adding Plugins

Everything beyond routing is a plugin you register. A plugin publishes a service under a capability
token, and code anywhere in the application resolves it by that token. Here are the most common
ones.

### Logger Plugin

```typescript
import { LoggerPlugin } from '@setu-ts/logger-plugin';

app.register(LoggerPlugin());
```

### Config Plugin

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';
import { ConfigPlugin, defineConfigSection, getConfigSection } from '@setu-ts/config-plugin';
import { z } from 'zod';

// A typed slice of configuration: DATABASE_URL, validated as a URL.
const database = defineConfigSection({
  prefix: 'DATABASE_',
  keys: ['URL'],
  schema: z.object({ URL: z.string().url() }),
});

app.register(
  ConfigPlugin({
    // Skip a missing .env; an existing but unreadable file still throws.
    envFilePath: '.env',
    envFileOptional: true,
    sections: [database],
  }),
);

await app.start({ port: 3000 });

// Sections are validated during start(), so a bad DATABASE_URL fails startup
// rather than the first request that reads it.
const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
const settings = getConfigSection(config, database); // settings.URL: string
```

On Deno, `envFilePath` also needs `--allow-read`.

### Database Plugin

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(
  DatabasePlugin({
    type: 'memory', // In-memory, for development; swap the arm for a real backend later
  }),
);
```

The [database plugin README](../packages/database-plugin/README.md) lists the other backends.

### Auth Plugin

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

app.register(
  AuthPlugin({
    jwt: {
      // Read this from configuration in a real application — never commit it.
      secret: 'your-secret-key',
      // 'HS256' pairs with `secret`; 'RS256' pairs with `privateKey`/`publicKey`.
      algorithm: 'HS256',
    },
  }),
);
```

Roles and permissions are an optional `rbac` arm; the
[auth plugin README](../packages/auth-plugin/README.md) covers guards, sessions, and sign-in
providers.

## Stopping Cleanly

When a container runtime or `Ctrl+C` stops the process, it sends `SIGTERM`/`SIGINT`. Unless you
catch the signal, the process dies immediately and `app.stop()` never runs — in-flight requests are
cut and no plugin gets to disconnect. Add this to `main.ts` after `start()`:

```typescript
import { createRuntimeServices } from '@setu-ts/runtime';

const runtime = createRuntimeServices();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // onSignal is absent where there is no signal to catch (Windows, Workers).
  runtime.onSignal?.(signal, () => {
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch(() => runtime.exit(1));
  });
}
```

This is the same block `setu new` writes into every generated `main.ts`, and it works unchanged on
every socket runtime: Deno, Node, and Bun alike.

## Running on Different Runtimes

The application above runs unchanged on Deno, Node, and Bun: `RuntimePlugin()` detects the platform
and picks its HTTP server. To override detection, pass `platform`:

```typescript
import { RuntimePlugin } from '@setu-ts/runtime';

app.register(RuntimePlugin({ platform: 'node' }));
await app.start({ port: 3000 });
```

### Cloudflare Workers

On Workers there is no socket to bind, so the application exports a `fetch` handler instead of
calling `start({ port })`. The Worker's bindings and variables arrive as the `env` argument to
`fetch`; pass them to both `RuntimePlugin` (so `runtime.env` is populated) and `CloudflarePlugin`
(which publishes typed binding accessors under `CAPABILITIES.CLOUDFLARE`):

```typescript
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

async function boot(env: Record<string, unknown>): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [RuntimePlugin({ env }), CloudflarePlugin({ env })],
  });
  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello from Workers!' }));
  await app.start();
  return app;
}

// Start once, on the first request, and share that start across concurrent
// requests. Two cases rebuild instead of reusing:
// - A FAILED start is forgotten rather than cached, so a transient problem at
//   cold start is retried on the next request instead of breaking the isolate
//   for its whole life.
// - A NEW `env` object means the bindings changed. Cloudflare may keep running
//   an isolate across a bindings-only deploy, and an application built from the
//   old `env` would keep using the old bindings. While bindings are unchanged,
//   every request receives the same `env` object, so this check costs nothing.
let booted: Promise<IKernelApplication> | undefined;
let bootedEnv: Record<string, unknown> | undefined;

function ensureBooted(env: Record<string, unknown>): Promise<IKernelApplication> {
  if (booted === undefined || bootedEnv !== env) {
    const previous = booted;
    const attempt = boot(env).catch((error: unknown) => {
      if (booted === attempt) booted = undefined;
      throw error;
    });
    booted = attempt;
    bootedEnv = env;
    // Release the superseded application's resources; a failure here must not
    // affect the new one.
    void previous?.then((app) => app.stop()).catch(() => {});
  }
  return booted;
}

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const app = await ensureBooted(env);
    return app.fetch(request);
  },
};
```

`setu new my-app --runtime cloudflare-workers` scaffolds a Workers project with an entry module and
its `wrangler.toml`.

## Next Steps

- [How It Fits Together](./how-it-fits-together.md) - When plugins run, where services live, and
  which test helper replaces them
- [Plugin Architecture](./plugin-architecture.md) - How plugins, capabilities, and lifecycle work
- [Programmatic API](./programmatic-api.md) - Complete API reference
- [Decorators](./decorators.md) - The optional class-based style, for teams coming from NestJS
- [Examples](./examples.md) - Runnable example applications
- [Runtime Deployment](./runtime-deployment.md) and [Deployment](./deployment.md) - Containers,
  Kubernetes, and Workers

## Common Issues

### Permission Errors (Deno)

Deno grants nothing by default. The flags an application commonly needs:

| Flag           | Needed for                                                 |
| -------------- | ---------------------------------------------------------- |
| `--allow-net`  | Binding the server port and any outbound connection        |
| `--allow-env`  | `RuntimePlugin`, which reads the process environment       |
| `--allow-read` | Loading a `.env` file, serving static files, local storage |
| `--allow-sys`  | The health plugin's self check, which reads the hostname   |

### `npm error Unsupported URL Type "jsr:"`

<!-- version:history -->

You ran `npm install jsr:@setu-ts/…`, an instruction from the JSR era. npm has no `jsr:` protocol,
and from `v0.9.0` you do not need one: install from npm directly with
`npm install @setu-ts/<package>` (`bun add` on Bun, `deno add npm:@setu-ts/<package>` on Deno).

### `deno test` fails on `main_test.ts`

If you started with `deno init`, it created a `main_test.ts` that imports a `handler` export your
new `main.ts` no longer has. Delete it.

### Port Already in Use

Start on a different port:

```typescript
await app.start({ port: 3001 });
```
