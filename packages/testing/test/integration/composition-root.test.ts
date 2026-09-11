import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { brandErrorResponder, CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type {
  ErrorResponderTarget,
  ErrorResponseInit,
  IPlugin,
  IPluginContext,
  MiddlewareFunction,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createTestApp } from '../../src/test-app.ts';
import { overrideCapability } from '../../src/override-capability.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

interface Mailer {
  readonly sent: string[];
  send(to: string): void;
}

/**
 * Records what the application's composition actually did, so a test can
 * distinguish "the double replaced the service" from "the real plugin never
 * ran" — which is the whole difference between an override and an exclusion.
 */
interface RootTrace {
  readonly connected: string[];
  readonly realMailer: Mailer;
}

/**
 * Stands in for a project's `setu.config.ts` `createApp()`: one composition
 * root, not started, exactly as M34b shaped it.
 *
 * The database plugin connects inside `register()` — which is what
 * `DatabasePlugin` does (`database-plugin/src/plugin/database-plugin.ts:115`)
 * — and the mailer sits in the `LOW` band, the case a default-priority
 * override would lose to.
 */
function createRoot(trace: RootTrace): IKernelApplication {
  const runtime = createFakeRuntime();

  const runtimePlugin: IPlugin = {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };

  const databasePlugin: IPlugin = {
    name: 'database',
    version: '1.0.0',
    provides: [CAPABILITIES.DATABASE],
    register(ctx: IPluginContext) {
      trace.connected.push('database');
      ctx.services.register(CAPABILITIES.DATABASE, { rows: () => ['real'] });
    },
  };

  const mailPlugin: IPlugin = {
    name: 'mail',
    version: '1.0.0',
    priority: PLUGIN_PRIORITY.LOW,
    provides: [CAPABILITIES.MAIL],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.MAIL, trace.realMailer);
    },
  };

  const app = createApplication({ plugins: [runtimePlugin, databasePlugin, mailPlugin] });

  // The root's own error handling. `@setu-ts/testing` may not depend on
  // `@setu-ts/exceptions` (§2.2 / M33), so this brands the same `common` seam
  // `errorHandler` brands — which is the point: whatever the ROOT registered is
  // what the test app inherits.
  const handler: MiddlewareFunction = async (_ctx, next) => {
    await next();
  };
  brandErrorResponder(handler, {
    respond(target: ErrorResponderTarget, init: ErrorResponseInit): void {
      target.response.status(init.status).json({
        type: 'https://example.test/errors',
        title: init.title,
        status: init.status,
      });
    },
  });
  app.middleware.add(handler, { priority: 0, name: 'root-error-handler' });

  app.router.get('/mail', (ctx) => {
    ctx.services.get<Mailer>(CAPABILITIES.MAIL).send('a@example.test');
    return ctx.response.json({ ok: true });
  });
  app.router.get('/boom', () => {
    throw new Error('handler exploded');
  });

  return app;
}

function newTrace(): RootTrace {
  const sent: string[] = [];
  return {
    connected: [],
    realMailer: { sent, send: (to: string) => void sent.push(to) },
  };
}

describe('createTestApp against a real composition root', () => {
  it('runs every plugin the root registered', async () => {
    const trace = newTrace();
    const app = await createTestApp({ app: createRoot(trace) });

    expect(trace.connected).toEqual(['database']);
    expect(app.services.has(CAPABILITIES.MAIL)).toBe(true);
  });

  it('`without` prevents the eager side effect an override cannot', async () => {
    const trace = newTrace();
    const app = await createTestApp({
      app: createRoot(trace),
      without: ['database'],
    });

    // This is the distinction the milestone exists for: overriding the
    // capability would leave `connect()` already called.
    expect(trace.connected).toEqual([]);
    expect(app.services.has(CAPABILITIES.DATABASE)).toBe(false);
  });

  it('`overrides` substitutes a double into the running composition', async () => {
    const trace = newTrace();
    const fakeSent: string[] = [];
    const app = await createTestApp({
      app: createRoot(trace),
      overrides: [
        overrideCapability(
          CAPABILITIES.MAIL,
          {
            sent: fakeSent,
            send: (to: string) => void fakeSent.push(to),
          } satisfies Mailer,
        ),
      ],
    });

    const res = await app.inject({ method: 'GET', url: '/mail' });

    expect(res.statusCode).toBe(200);
    expect(fakeSent).toEqual(['a@example.test']);
    // The real mailer sits at PLUGIN_PRIORITY.LOW (900); a default-priority
    // override would have lost to it.
    expect(trace.realMailer.sent).toEqual([]);
  });

  it('combines exclusion and override in one call', async () => {
    const trace = newTrace();
    const fakeSent: string[] = [];
    const app = await createTestApp({
      app: createRoot(trace),
      without: ['database'],
      overrides: [
        overrideCapability(
          CAPABILITIES.MAIL,
          {
            sent: fakeSent,
            send: (to: string) => void fakeSent.push(to),
          } satisfies Mailer,
        ),
      ],
    });

    expect(trace.connected).toEqual([]);
    const res = await app.inject({ method: 'GET', url: '/mail' });
    expect(res.statusCode).toBe(200);
    expect(fakeSent).toEqual(['a@example.test']);
  });

  it('inherits the error shape the root registered', async () => {
    const app = await createTestApp({ app: createRoot(newTrace()) });

    const res = await app.inject({ method: 'GET', url: '/boom' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      type: 'https://example.test/errors',
      title: 'Internal Server Error',
      status: 500,
    });
  });

  it('answers the kernel fallback on the plugins arm, which is what the README documents', async () => {
    const runtime = createFakeRuntime();
    const app = await createTestApp({
      plugins: [{
        name: 'fake-runtime',
        version: '1.0.0',
        provides: [CAPABILITIES.RUNTIME],
        register(ctx: IPluginContext) {
          ctx.services.register(CAPABILITIES.RUNTIME, runtime);
        },
      }],
    });
    app.router.get('/boom', () => {
      throw new Error('handler exploded');
    });

    const res = await app.inject({ method: 'GET', url: '/boom' });

    // No responder registered, so the kernel's `{ error, detail? }` fallback.
    // The `app:` arm above is the answer for response-shape fidelity.
    expect(res.statusCode).toBe(500);
    const body = res.json<Record<string, unknown>>();
    expect(body['error']).toBe('Internal Server Error');
    expect(body['type']).toBeUndefined();
  });
});
