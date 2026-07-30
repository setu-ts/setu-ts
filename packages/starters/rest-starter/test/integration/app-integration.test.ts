/**
 * @module rest-starter integration tests
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createRestApp } from '../../src/index.ts';
import type { IRequestContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { CachePlugin } from '@hono-enterprise/cache-plugin';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  metadataStore,
} from '@hono-enterprise/decorator-plugin';

describe('rest-starter / integration', () => {
  it('route handler returns expected body via inject()', async () => {
    const app = createRestApp();
    app.router.get('/hello', (ctx) => ctx.response.text('Hello world'));

    await app.start(); // Must start to set up runtime and HTTP adapter
    const response = await app.inject({ method: 'GET', url: '/hello' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('Hello world');
  });

  // C7: errorHandler must be outermost (priority 0) — both throw sites yield RFC 7807 body
  // with "detail" field and NO "message" field
  it('errorHandler catches route handler throws and formats RFC 7807 body', async () => {
    const app = createRestApp();
    app.router.get('/throw', () => {
      throw new Error('test route error');
    });

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/throw' });

    expect(response.statusCode).toBe(500);
    // Parse the JSON body to check fields
    const body = JSON.parse(response.body!);
    // RFC 7807 format: type includes ERROR_TYPE_BASE/statusCode
    expect(body.type).toContain('hono-enterprise.dev/errors/500');
    expect(body.detail).toBe('test route error');
    // RFC 7807 Problem Details MUST NOT have a "message" field
    expect(Object.keys(body).includes('message')).toBe(false);
  });

  // C7: middleware registered at priority 100 must also be caught by errorHandler
  // This is the critical test that fails if priority:0 is dropped
  it('errorHandler catches middleware-level throws (priority 100 middleware)', async () => {
    const app = createRestApp();
    // Add a middleware that throws at priority 100 (inside default priority band of 500)
    app.middleware.add(
      (_ctx: IRequestContext, _next) => {
        throw new Error('test middleware error');
      },
      { priority: 100, name: 'test-middleware' },
    );
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();
    const response = await app.inject({ method: 'GET', url: '/test' });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body!);
    expect(body.detail).toBe('test middleware error');
    // Must not have a "message" field per RFC 7807
    expect(Object.keys(body).includes('message')).toBe(false);
  });

  it('registers the realtime capabilities and still serves with every sub-arm on', async () => {
    const app = createRestApp({
      realtime: { websocket: {}, sse: {}, backplane: { bus: 'rest-starter-integration' } },
    });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    await app.start();

    expect(app.services.has(CAPABILITIES.SSE)).toBe(true);
    expect(app.services.has(CAPABILITIES.WEBSOCKET)).toBe(true);
    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });

  it('registers none of the realtime capabilities by default', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.SSE)).toBe(false);
    expect(app.services.has(CAPABILITIES.WEBSOCKET)).toBe(false);
    expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(false);
    expect(app.services.has(CAPABILITIES.DI_CONTAINER)).toBe(false);
  });

  it('registers the DI container and serves when the di arm is on', async () => {
    const app = createRestApp({ di: {} });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await app.start();
    expect(app.services.has(CAPABILITIES.DI_CONTAINER)).toBe(true);
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });

  // The NestJS-familiarity path end to end through the starter: parameter-level
  // @Inject, resolved by the container the `di` arm registers, serving a route
  // from a decorated controller. Proves the starter composes DiPlugin and
  // DecoratorPlugin correctly — the two are wired only by priority, in different
  // packages, and neither imports the other.
  it('serves a decorated controller whose dependency is container-injected', async () => {
    metadataStore.clear();

    @Injectable({ token: 'billing-service' })
    class BillingService {
      total(): number {
        return 42;
      }
    }

    @Controller('/billing')
    class BillingController {
      constructor(@Inject('billing-service') readonly billing: BillingService) {}

      @Get('/total')
      total(): { total: number } {
        return { total: this.billing.total() };
      }
    }

    const app = createRestApp({
      di: {},
      decorators: { services: [BillingService], controllers: [BillingController] },
    });

    await app.start();
    expect(app.services.has(CAPABILITIES.DI_CONTAINER)).toBe(true);

    const response = await app.inject({ method: 'GET', url: '/billing/total' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({ total: 42 });
  });

  it('serves the same decorated controller through the registry without the di arm', async () => {
    metadataStore.clear();

    @Injectable({ token: 'pricing-service' })
    class PricingService {
      total(): number {
        return 7;
      }
    }

    @Controller('/pricing')
    class PricingController {
      constructor(@Inject('pricing-service') readonly pricing: PricingService) {}

      @Get('/total')
      total(): { total: number } {
        return { total: this.pricing.total() };
      }
    }

    const app = createRestApp({
      decorators: { services: [PricingService], controllers: [PricingController] },
    });

    await app.start();
    expect(app.services.has(CAPABILITIES.DI_CONTAINER)).toBe(false);

    const response = await app.inject({ method: 'GET', url: '/pricing/total' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body as string)).toEqual({ total: 7 });
  });

  // §3.6: the starter performs no 'messaging' transport validation of its own —
  // the backplane's own register() is the guard, and it names MessagingPlugin.
  it("rejects start() for a 'messaging' backplane on the REST tier, naming MessagingPlugin", async () => {
    const app = createRestApp({ realtime: { backplane: { transport: 'messaging' } } });
    app.router.get('/test', (ctx) => ctx.response.text('ok'));
    await expect(app.start()).rejects.toThrow(/MessagingPlugin/);
  });

  // §3.2.1: caller can register additional plugins after createRestApp returns (escape hatch)
  it('allows registering CachePlugin with name after app creation without duplicate throw', async () => {
    const app = createRestApp();
    app.router.get('/test', (ctx) => ctx.response.text('ok'));

    // Before start: register a named cache plugin as documented escape hatch
    app.register(CachePlugin({ name: 'session' }));

    await app.start();

    // The bare token should not be present (named instance uses derived token)
    expect(app.services.has(CAPABILITIES.CACHE)).toBe(false);

    // The app should still work normally
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
  });
});
