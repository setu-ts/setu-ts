/**
 * gRPC handler-error logging and the `GrpcPluginOptions.interceptors` option
 * (M70f §3.7, X7-5).
 *
 * The e2e suite proves the built-in logging wrapper through the plugin; this
 * integration suite proves the option itself:
 *
 * - a throwing procedure still answers the masked wire error AND logs the real
 *   message (the option does not disturb the built-in logging);
 * - an application interceptor supplied through `interceptors` actually runs
 *   for a real unary RPC (the option is not dead surface);
 * - the real adapter forwards the options object to Connect router
 *   construction, so the value reaches `createConnectRouter({ interceptors })`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { loadConnectModule } from '../../src/transports/connect-loader.ts';
import {
  CAPABILITIES,
  type GrpcServiceDefinition,
  type IGrpcService,
  type ILogger,
  type IPlugin,
} from '@setu-ts/common';
import type { ConnectRuntime } from '../../src/interfaces/connect-runtime.ts';
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

/** Revives the example.EchoService DescService via the real Connect runtime. */
async function reviveEchoService(): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return runtime.getService(registry, 'example.EchoService') as GrpcServiceDefinition;
}

/** A capturing logger that records `error` calls. */
function makeCapturingLogger() {
  const errors: {
    message: string;
    metadata?: Readonly<Record<string, unknown>> | undefined;
  }[] = [];
  const logger: ILogger = {
    level: 'error',
    fatal(message, metadata) {
      errors.push({ message, metadata });
    },
    error(message, metadata) {
      errors.push({ message, metadata });
    },
    warn() {},
    info() {},
    debug() {},
    trace() {},
    child() {
      return logger;
    },
  };
  return { logger, errors };
}

/** Registers the capturing logger as a plugin that provides CAPABILITIES.LOGGER. */
function loggerPlugin(logger: ILogger): IPlugin {
  return {
    name: 'capturing-logger',
    version: '1.0.0',
    provides: [CAPABILITIES.LOGGER],
    register(ctx) {
      ctx.services.register(CAPABILITIES.LOGGER, logger);
    },
  };
}

/** Drives a real unary Echo RPC and returns the response. */
function driveEcho(app: ReturnType<typeof createApplication>): Promise<Response> {
  return app.fetch(
    new Request('http://localhost:0/grpc/example.EchoService/Echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x' }),
    }),
  );
}

describe('GrpcPluginOptions.interceptors (M70f §3.7)', () => {
  it('keeps the built-in logging intact when the option is present', async () => {
    // The option must not disturb the built-in handler-error logging: a
    // throwing procedure still answers the masked wire error AND logs the real
    // message, even with an (empty) interceptors option supplied.
    const { logger, errors } = makeCapturingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(logger),
        GrpcPlugin({ interceptors: [] }),
      ],
    });
    await app.start({ port: 0 });
    try {
      const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
      grpc.addService(await reviveEchoService(), {
        echo: () => {
          throw new Error('option-present handler blew up');
        },
      });

      const response = await driveEcho(app);
      // The masked wire response is unchanged: an error, not 200.
      expect(response.status).not.toBe(200);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe('gRPC handler failed');
      expect(errors[0].metadata?.procedure).toBe('example.EchoService/echo');
      expect(errors[0].metadata?.message).toBe('option-present handler blew up');
    } finally {
      await app.stop();
    }
  });

  it('runs an application interceptor supplied through the option', async () => {
    // The option is not decoration: an application interceptor must actually
    // execute for a real unary RPC. The interceptor wraps the invocation (the
    // `next` chain) and records the procedure it observed; the response body
    // must be unchanged, proving the interceptor ran transparently.
    const seen: string[] = [];
    const interceptor = (next: (req: unknown) => Promise<unknown>) => (req: unknown) => {
      const method = (req as { method?: { name?: string } }).method;
      seen.push(method?.name ?? '?');
      return next(req);
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin({ interceptors: [interceptor] })],
    });
    await app.start({ port: 0 });
    try {
      const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
      grpc.addService(await reviveEchoService(), {
        echo: (req: { message: string }) => ({ response: `echo: ${req.message}` }),
      });

      const response = await driveEcho(app);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ response: 'echo: x' });

      // The application interceptor ran exactly once, for the Echo procedure.
      expect(seen).toEqual(['Echo']);
    } finally {
      await app.stop();
    }
  });

  it('forwards the options object to Connect router construction', async () => {
    // A real-import guarded case: wrap the REAL runtime's
    // `createConnectRouter` and assert the options object the plugin passes
    // carries the application's `interceptors`. Without the `connect-loader`
    // forwarding (M70f §3.7) the value would be dropped and this fails — the
    // option would be dead surface.
    const real = await loadConnectModule();
    const captured: Record<string, unknown>[] = [];
    const spy: ConnectRuntime = {
      ...real,
      createConnectRouter(options?: Record<string, unknown>) {
        captured.push(options ?? {});
        return real.createConnectRouter(options);
      },
    };

    // A pass-through interceptor: takes `next`, returns a function that
    // forwards the request to it. (A marker that merely echoed its input would
    // return the request as the response and break the RPC.)
    const marker = (next: (req: unknown) => Promise<unknown>) => (req: unknown) => next(req);
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        GrpcPlugin({ connectModule: spy, interceptors: [marker] }),
      ],
    });
    await app.start({ port: 0 });
    try {
      const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
      grpc.addService(await reviveEchoService(), {
        echo: (req: { message: string }) => ({ response: req.message }),
      });
      // Force the lazily-built router to construct, so the options are captured.
      const response = await driveEcho(app);
      expect(response.status).toBe(200);

      expect(captured.length).toBeGreaterThanOrEqual(1);
      // The real adapter forwarded the options object, carrying the app's
      // interceptors, to Connect router construction.
      expect(captured[0]).toHaveProperty('interceptors');
      expect(captured[0].interceptors).toEqual([marker]);
    } finally {
      await app.stop();
    }
  });
});
