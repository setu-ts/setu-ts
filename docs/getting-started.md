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
deno install -A -f jsr:@setu-ts/cli@^0.1.0-alpha.5/main

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
  env: true, // Load from environment variables
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
    algorithms: ['HS256'],
  },
}));
```

## Running on Different Runtimes

### Deno

```typescript
// Deno automatically uses DenoHttpAdapter
await app.start({ port: 3000 });
```

### Node.js

```typescript
import { NodeHttpAdapter } from '@setu-ts/runtime';

app.register(RuntimePlugin({
  httpAdapters: [NodeHttpAdapter],
}));
await app.start({ port: 3000 });
```

### Bun

```typescript
import { BunHttpAdapter } from '@setu-ts/runtime';

app.register(RuntimePlugin({
  httpAdapters: [BunHttpAdapter],
}));
await app.start({ port: 3000 });
```

### Cloudflare Workers

```typescript
import { CloudflareWorkersHttpAdapter } from '@setu-ts/runtime';

const adapter = CloudflareWorkersHttpAdapter;
app.register(RuntimePlugin({
  httpAdapters: [adapter],
}));

// Export the fetch handler
export default {
  async fetch(request: Request, env: unknown, ctx: ExecutionContext) {
    return app.fetch(request);
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
    "@setu-ts/kernel": "jsr:@setu-ts/kernel@^0.1.0-alpha.5",
    "@setu-ts/runtime": "jsr:@setu-ts/runtime@^0.1.0-alpha.5",
    "@setu-ts/common": "jsr:@setu-ts/common@^0.1.0-alpha.5"
  }
}
```
