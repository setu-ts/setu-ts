# Getting Started with Setu-TS

This guide walks you through setting up your first Setu-TS application and understanding the core
concepts.

## Prerequisites

- **Deno 2.x** or **Node.js 18+** or **Bun 1.x**
- Basic familiarity with TypeScript
- Understanding of web frameworks (optional but helpful)

## Installation

### Using Deno

```bash
# Create a new project directory
mkdir my-app && cd my-app
deno init

# Add Setu-TS packages
deno add jsr:@setu-ts/kernel jsr:@setu-ts/runtime jsr:@setu-ts/common
```

### Using npm/npx (Node.js/Bun)

```bash
# Create a new project
npm init -y
npm install jsr:@setu-ts/kernel jsr:@setu-ts/runtime jsr:@setu-ts/common
```

### Using the CLI (Recommended)

```bash
# Install the Setu CLI
deno install -A -f jsr:@setu-ts/cli@^0.1.0-alpha.8/main

# Create a new REST application
setu new my-app --runtime deno
```

## Your First Application

### Minimal Application

Create a file called `main.ts`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// Create the application
const app = createApplication();

// Register the runtime plugin (required)
app.register(RuntimePlugin());

// Add a simple route through the router
app.router.get('/hello', async (ctx) => {
  return ctx.response.json({ message: 'Hello, World!' });
});

// Add a health check endpoint
app.router.get('/health', async (ctx) => {
  return ctx.response.json({ status: 'ok' });
});

// Start the server
await app.start({ port: 3000 });

console.log('Server running on http://localhost:3000');
```

### Running the Application

**Deno:**

```bash
deno run --allow-net main.ts
```

**Node.js:**

```bash
deno run --allow-net main.ts  # Works with Deno's npm support
# or use the generated npm-compatible files
```

**Bun:**

```bash
bun run main.ts
```

### Testing Your Application

Make a request to the server:

```bash
# Using curl
curl http://localhost:3000/hello

# Expected response:
# {"message":"Hello, World!"}
```

## Testing Your Application

### Using the Testing Utilities

Setu-TS provides testing utilities for easy application testing:

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createTestApp, inject } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

describe('My Application', () => {
  it('handles GET /hello', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin()],
    });

    app.router.get('/hello', async (ctx) => {
      return ctx.response.json({ message: 'Hello, World!' });
    });

    const response = await inject(app, {
      method: 'GET',
      url: '/hello',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toEqual({ message: 'Hello, World!' });
  });
});
```

### Running Tests

```bash
deno test -P --allow-read --allow-import --allow-env test/
```

## Adding Plugins

Setu-TS is built around a plugin architecture. Here's how to add common plugins:

### Logger Plugin

```typescript
import { LoggerPlugin } from '@setu-ts/logger-plugin';

app.register(LoggerPlugin());
```

### Config Plugin

```typescript
import { ConfigPlugin } from '@setu-ts/config-plugin';

app.register(ConfigPlugin({
  // Optional: load .env files. Requires a runtime with filesystem support
  // (absent on edge platforms). Defaults to reading only `runtime.env`.
  envFilePath: '.env',
}));
```

### Database Plugin

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';

app.register(DatabasePlugin({
  type: 'memory', // Use in-memory database for development
}));
```

### Auth Plugin

```typescript
import { AuthPlugin } from '@setu-ts/auth-plugin';

app.register(AuthPlugin({
  jwt: {
    secret: 'your-secret-key',
    // Singular algorithm matching the signing key. 'HS256' pairs with
    // `secret`; 'RS256' pairs with `privateKey`/`publicKey`.
    algorithm: 'HS256',
  },
  rbac: {
    roles: {},
  },
}));
```

## Running on Different Runtimes

### Deno

```typescript
// RuntimePlugin() auto-detects Deno and selects DenoHttpAdapter.
await app.start({ port: 3000 });
```

### Node.js

```typescript
// RuntimePlugin() auto-detects Node and selects NodeHttpAdapter.
await app.start({ port: 3000 });
```

### Bun

```typescript
// RuntimePlugin() auto-detects Bun and selects BunHttpAdapter.
await app.start({ port: 3000 });
```

### Forcing a platform

`RuntimePlugin({ platform })` overrides auto-detection. The `httpAdapters` option is a keyed
[`HttpAdapterFactories`](../packages/runtime/src/plugin/runtime-plugin.ts) object (factory callbacks
per platform), not an array — it is an internal testing seam, so prefer `platform` for production
overrides:

```typescript
import { RuntimePlugin } from '@setu-ts/runtime';
import type { RuntimePlatform } from '@setu-ts/common';

app.register(RuntimePlugin({ platform: 'node' as RuntimePlatform }));
await app.start({ port: 3000 });
```

### Cloudflare Workers

On Workers there is no socket to bind, so the application exports a `fetch` handler instead of
calling `start({ port })`. The Worker's `env` (bindings and variables) is passed to both
`RuntimePlugin` (so `runtime.env` is populated) and `CloudflarePlugin` (which publishes typed
binding accessors under `CAPABILITIES.CLOUDFLARE`):

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

// Deployment glue: at runtime `env` and `waitUntil` come from
// `import { env, waitUntil } from 'cloudflare:workers'`. That specifier is
// unresolvable off a Worker toolchain, so this block declares them rather than
// importing — the real Worker passes the platform's values, which satisfy
// these shapes structurally. `CloudflareWorkerEnv` is a `Record<string, unknown>`,
// so a minimal typed interface is compatible with it.
declare const env: Record<string, unknown>;
declare const waitUntil: (promise: Promise<unknown>) => void;

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

## Next Steps

- [Plugin Architecture](./plugin-architecture.md) - Deep dive into the plugin system
- [Programmatic API](./programmatic-api.md) - Complete API reference
- [Examples](./examples.md) - See real-world applications
- [Deployment](./runtime-deployment.md) - Deploy to production

## Common Issues

### Permission Errors

If you get permission errors, ensure you're running with the necessary permissions:

```bash
deno run --allow-net --allow-read --allow-env main.ts
```

### Port Already in Use

If port 3000 is already in use, try a different port:

```typescript
await app.start({ port: 3001 });
```

### Module Resolution

For npm-based projects, ensure your `package.json` has the correct imports:

```json
{
  "imports": {
    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.1.0-alpha.8",
    "@setu-ts/runtime": "jsr:@setu-ts/runtime@^0.1.0-alpha.8",
    "@setu-ts/common": "jsr:@setu-ts/common@^0.1.0-alpha.8"
  }
}
```
