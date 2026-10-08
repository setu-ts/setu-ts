# How It Fits Together

Most first-week questions about Setu-TS come down to three: **when** does a plugin's work happen,
**where** does a service live once it is registered, and **which** test helper replaces it. This
page answers all three in one place. The details live in the guides it links to; this is the map.

## Table of Contents

- [When Things Run](#when-things-run)
- [Why a Lookup Misses](#why-a-lookup-misses)
- [Stopping](#stopping)
- [Where a Service Lives](#where-a-service-lives)
- [Replacing a Service in a Test](#replacing-a-service-in-a-test)
- [Next Steps](#next-steps)

## When Things Run

`createApplication({ plugins })` only records the plugin list. Nothing registers until you call
`await app.start()`, which runs these steps in order:

1. **Order the plugins.** The runtime provider (`RuntimePlugin`) always goes first, because every
   plugin implicitly depends on it. After that, a plugin listed in another's `dependencies` or
   `optionalDependencies` goes before it. Plugins with no edge between them go by `priority` (lower
   first, default `PLUGIN_PRIORITY.NORMAL` = 500), then by the order you listed them.
2. **Register.** Each plugin's `register(ctx)` runs in that order, followed by any `onRegister`
   hooks it added. This is where plugins put services into the registry, add routes and add
   middleware.
3. **Validate environment variables** that plugins declared they require.
4. **Run `onInit` hooks.** Every plugin has registered by now, so any capability in the application
   can be resolved.
5. **Compile the middleware pipeline**, once, in priority order.
6. **Run `onBootstrap` hooks.**
7. **Seal the registry.** From here on, registering a capability on the application registry throws.
8. **Start serving.** `app.fetch` and `app.inject()` work from this point. If you passed a `port`,
   the HTTP server binds it last.

The useful consequence: **inside `register()`, you can only see capabilities from plugins ordered
before yours.** If your plugin needs one while it registers, say so with `dependencies`:

```typescript
import { CAPABILITIES, type IConfig, type IPlugin } from '@setu-ts/common';

/** Reads configuration while it registers, so it declares the dependency. */
export function GreetingPlugin(): IPlugin {
  return {
    name: 'greeting',
    version: '1.0.0',
    dependencies: [CAPABILITIES.CONFIG],
    provides: ['greeting'],
    register(ctx) {
      const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
      const text = config.get<string>('GREETING') ?? 'Hello';
      ctx.services.register('greeting', { text });
    },
  };
}
```

A dependency means "this must exist, or startup fails". If the capability is optional, use
`optionalDependencies` (it still orders the provider first when it is present) and check with
`ctx.services.has(...)`. If you only need the capability later, read it in an `onInit` hook or in a
request handler. Then no ordering edge is needed at all:

```typescript
import { CAPABILITIES, type ILogger, type IPlugin } from '@setu-ts/common';

export function AuditTrailPlugin(): IPlugin {
  return {
    name: 'audit-trail',
    version: '1.0.0',
    register(ctx) {
      ctx.lifecycle.onInit(() => {
        // Every plugin has registered by now, whatever its order.
        if (ctx.services.has(CAPABILITIES.LOGGER)) {
          ctx.services.get<ILogger>(CAPABILITIES.LOGGER).info('audit trail ready');
        }
      });
    },
  };
}
```

Priorities matter mostly for middleware and for unrelated plugins. The bands and the middleware
priority table are in [Plugin Architecture](./plugin-architecture.md#plugin-priority).

## Why a Lookup Misses

`ctx.services.get(token)` throws when nothing is registered under the token. The message names which
of these four cases you are in:

| Where the lookup ran                               | What the error tells you                                                                                                                                       |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| On `app.services` before `await app.start()`       | The application has not started. Plugins register during `start()`. Move the lookup after `start()`, into a handler, or into a lifecycle hook.                 |
| In a plugin's `register()`, provider ordered later | Which plugin provides it, and which dependency to add so it registers first.                                                                                   |
| In the runtime provider's own `register()`         | The runtime provider always registers first, so a dependency would be a cycle. Use a lifecycle hook such as `onInit` instead.                                  |
| After startup, nothing provides it                 | Register a plugin that provides it, or check the token's spelling. The same message appears during `register()` when no plugin in the application provides it. |

A related error comes from **registering** too late. After step 7 the application registry is
sealed. A plugin may still register in `register()`, `onInit` or `onBootstrap`, but a registration
from anything that runs later, such as a timer or a request, throws
`Cannot register capability … after runBootstrap() has completed`. Inside a request, `ctx.services`
is a per-request child registry: you can register request-scoped values on it, and it can still read
everything the application registered.

## Stopping

`await app.stop()` runs the shutdown hooks in this order:

1. **`onStopping`** hooks, last-registered first, while the application is still serving. This is
   the moment to deregister from service discovery, so no new traffic arrives.
2. New requests get `503` from here on.
3. Requests already in flight get up to 10 seconds to finish.
4. The HTTP server closes its socket.
5. **`onShutdown`** hooks, last-registered first.
6. **`onClose`** hooks, in registration order. Every hook runs even if an earlier one fails. If
   several fail, `stop()` rejects with an `AggregateError` listing them.

Release connections (database, broker, Redis) in `onClose`. That way a failed `start()` releases
them too, because `onClose` also runs when startup fails part-way.

## Where a Service Lives

There are two places a service can live, and which one depends on how it was registered:

| How it was registered                                    | Where it lives           | How to reach it                                 |
| -------------------------------------------------------- | ------------------------ | ----------------------------------------------- |
| `ctx.services.register(token, service)` in a plugin      | The **service registry** | `ctx.services.get(token)`                       |
| `@Injectable` class, **no** `DiPlugin` in the app        | The service registry     | `ctx.services.get(token)` or `@Inject(token)`   |
| `@Injectable` class, `DiPlugin` registered               | The **DI container**     | `@Inject(token)` in another `@Injectable` class |
| `container.register(...)` on `CAPABILITIES.DI_CONTAINER` | The DI container         | `@Inject(token)`, or `container.resolve(token)` |

Every first-party plugin registers its capabilities in the **service registry**: the logger, the
config, the database and so on. The DI container only comes into play with `DiPlugin`, and two rules
connect the two:

- **The container can read the registry.** `DiPlugin` defaults to `autoRegister: true`. When it is
  asked for a token it has no provider for, it falls back to the service registry and caches the
  result as a singleton. That is why an `@Injectable` class can `@Inject(CAPABILITIES.CONFIG)` even
  though config lives in the registry.
- **The registry cannot read the container.** With `DiPlugin` registered, `DecoratorPlugin` puts
  `@Injectable` classes in the container only. So `ctx.services.get('user-service')` throws there,
  even though the same call works in a project without `DiPlugin`. `@Inject` works in both, which is
  why the generated code uses it.

```typescript
import { CAPABILITIES, type IConfig } from '@setu-ts/common';
import { Inject, Injectable } from '@setu-ts/decorator-plugin';

// CAPABILITIES.CONFIG lives in the registry; the container falls back to it.
@Injectable({ token: 'greeting-service' })
@Inject(CAPABILITIES.CONFIG)
export class GreetingService {
  constructor(private readonly config: IConfig) {}

  greet(): string {
    return this.config.get<string>('GREETING') ?? 'Hello';
  }
}
```

Without `DiPlugin`, `DecoratorPlugin` builds each `@Injectable` class while it registers (at
`PLUGIN_PRIORITY.LOW`, after most plugins), so the tokens it injects must already be in the registry
by then. Scopes and the container itself are covered in
[Decorators](./decorators.md#dependency-injection).

## Replacing a Service in a Test

Build the test application from the same `createApp()` your server uses, then swap out what you
need. Use the helper that matches where the service lives:

| What you are replacing                          | Use                                                                           |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| A capability in the service registry            | `overrideCapability(token, double)`                                           |
| An `@Injectable` class or other container entry | `overrideProvider(token, { useValue })` (or `useFactory` / `useClass`)        |
| A plugin whose startup must not run at all      | `without: ['plugin-name']`, plus a `createMockPlugin` that provides the token |

```typescript
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import { createTestApp, overrideCapability, overrideProvider } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';

describe('orders', () => {
  it('sends a confirmation without a real mail server', async () => {
    const sent: unknown[] = [];
    const app = await createTestApp({
      app: createApp(),
      overrides: [
        // Mail lives in the service registry.
        overrideCapability(CAPABILITIES.MAIL, {
          send: (message: unknown) => {
            sent.push(message);
            return Promise.resolve();
          },
        }),
        // An @Injectable class lives in the container when DiPlugin is present.
        overrideProvider('pricing-service', { useValue: { price: () => 0 } }),
      ],
    });
    try {
      const response = await app.inject({ method: 'POST', url: '/orders', body: { sku: 'a' } });
      expect(response.statusCode).toBe(201);
      expect(sent.length).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
```

Both helpers fail `start()` with a message if the token is mistyped, so a test cannot silently run
against the real service. What they cannot do is undo the real plugin's own startup work: by the
time the double replaces the service, the real plugin's `register()` has run, and a database adapter
has already connected. To keep that from happening, remove the plugin with `without` and provide the
token yourself. [Programmatic API](./programmatic-api.md#testing-utilities) has the full
`createTestApp` options.

## Next Steps

- [Plugin Architecture](./plugin-architecture.md): the plugin contract, dependencies and priorities
- [Custom Plugins](./custom-plugins.md): writing and testing your own plugin
- [Decorators](./decorators.md): controllers, `@Injectable` and scoped injection
- [Programmatic API](./programmatic-api.md): the router, middleware and lifecycle hooks
