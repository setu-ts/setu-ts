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
import { createMockPlugin } from '../../src/mock-plugin.ts';
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
function createRoot(trace: RootTrace, extra: readonly IPlugin[] = []): IKernelApplication {
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

  const app = createApplication({
    plugins: [runtimePlugin, databasePlugin, mailPlugin, ...extra],
  });

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

/**
 * A consumer that resolves its dependency during its OWN `register()` and holds
 * the object — the shape `NotificationPlugin` has, where `createProvider` calls
 * `ctx.services.get(CAPABILITIES.MAIL)` while registering. Reproduced locally
 * rather than imported: `@setu-ts/testing` depends on `common` and `kernel`
 * only (M33), and AI_GUIDELINES §2.2 forbids importing a plugin.
 */
function eagerConsumer(captured: { mailer: Mailer | null }): IPlugin {
  return {
    name: 'notifier',
    version: '1.0.0',
    // The edge that orders the provider first — exactly what NotificationPlugin
    // declares. Without it this fixture would resolve before the LOW-band mail
    // plugin and fail for a reason unrelated to what the test asserts.
    optionalDependencies: [CAPABILITIES.MAIL],
    register(ctx: IPluginContext) {
      captured.mailer = ctx.services.get<Mailer>(CAPABILITIES.MAIL);
    },
  };
}

describe('overrideCapability against an eagerly-capturing consumer', () => {
  it('does NOT reach a consumer that captured the service while registering', async () => {
    // The documented bound, pinned. An override runs after every other plugin,
    // so it replaces what LATER resolutions see — a reference already taken is
    // not one of them. No ordering fixes it: placed before the real provider,
    // the override is overwritten by it and the kernel refuses to start.
    const trace = newTrace();
    const captured: { mailer: Mailer | null } = { mailer: null };
    const fakeSent: string[] = [];
    const app = await createTestApp({
      app: createRoot(trace, [eagerConsumer(captured)]),
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

    captured.mailer?.send('a@example.test');

    expect(fakeSent).toEqual([]); // the double saw nothing
    expect(trace.realMailer.sent).toEqual(['a@example.test']);
    // …while the registry itself DOES return the double.
    expect(app.services.get<Mailer>(CAPABILITIES.MAIL).sent).toBe(fakeSent);
  });

  it('is reached when the provider is excluded and the double registers ahead of the consumer', async () => {
    // The documented remedy. `without` removes the provider, so nothing can be
    // captured from it; the double registers at a priority ahead of the
    // consumer, so the consumer captures the double instead.
    const trace = newTrace();
    const captured: { mailer: Mailer | null } = { mailer: null };
    const fakeSent: string[] = [];
    await createTestApp({
      app: createRoot(trace, [eagerConsumer(captured)]),
      without: ['mail'],
      overrides: [
        createMockPlugin({
          name: 'mail',
          provides: CAPABILITIES.MAIL,
          priority: PLUGIN_PRIORITY.HIGH,
          service: {
            sent: fakeSent,
            send: (to: string) => void fakeSent.push(to),
          } satisfies Mailer,
        }),
      ],
    });

    captured.mailer?.send('b@example.test');

    expect(fakeSent).toEqual(['b@example.test']);
    expect(trace.realMailer.sent).toEqual([]);
  });
});

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
