/**
 * gRPC handler-error logging e2e (X7-5).
 *
 * Drives a REAL failing RPC through kernel dispatch (`app.fetch()`) and asserts
 * the built-in logging wrapper caught the handler error, logged it at `error` level
 * with the procedure name and a serialized error, and rethrew it so Connect's
 * masked wire response is unchanged. A logger registered by a LATER plugin is
 * still seen (the M52b per-call resolution), and a request with no logger
 * registered logs nothing but still rethrows.
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
import { ECHO_DESCRIPTOR_BASE64 } from '../fixtures/echo-descriptors.ts';

/** Revives the example.EchoService DescService via the real Connect runtime. */
async function reviveEchoService(): Promise<GrpcServiceDefinition> {
  const runtime = await loadConnectModule();
  const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
  return runtime.getService(registry, 'example.EchoService') as GrpcServiceDefinition;
}

/** A capturing logger that records `error` calls. */
function makeCapturingLogger() {
  const errors: { message: string; metadata?: Readonly<Record<string, unknown>> | undefined }[] =
    [];
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

describe('gRPC handler-error logging (X7-5)', () => {
  it('logs a sync-throwing handler with the procedure name and rethrows', async () => {
    const { logger, errors } = makeCapturingLogger();
    const app = createApplication({
      plugins: [RuntimePlugin(), loggerPlugin(logger), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), {
      // Synchronous throw — the wrapper must catch it, log it, and rethrow.
      echo: () => {
        throw new Error('handler blew up');
      },
    });

    const response = await app.fetch(
      new Request('http://localhost:0/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
    );
    // The masked wire response is unchanged: Connect answers an error, not 200.
    expect(response.status).not.toBe(200);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.EchoService/echo');
    expect(errors[0].metadata?.message).toBe('handler blew up');
    expect(errors[0].metadata?.name).toBe('Error');

    await app.stop();
  });

  it('logs an async-rejecting handler (thenable path) with the procedure name', async () => {
    const { logger, errors } = makeCapturingLogger();
    const app = createApplication({
      plugins: [RuntimePlugin(), loggerPlugin(logger), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), {
      // Rejected Promise — the wrapper attaches a .catch to the returned thenable.
      echo: (): Promise<unknown> => Promise.reject(new Error('async boom')),
    });

    const response = await app.fetch(
      new Request('http://localhost:0/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
    );
    expect(response.status).not.toBe(200);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.EchoService/echo');
    expect(errors[0].metadata?.message).toBe('async boom');

    await app.stop();
  });

  it('rethrows without logging when no logger is registered', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), {
      echo: () => {
        throw new Error('no logger here');
      },
    });

    const response = await app.fetch(
      new Request('http://localhost:0/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
    );
    // Still a masked error response — the wrapper rethrew; nothing was logged.
    expect(response.status).not.toBe(200);

    await app.stop();
  });

  it('degrades to no logging (not a crash) when the logger registry is broken', async () => {
    // The plugin resolves the logger per-call inside a try/catch so a broken
    // registry degrades to "no logging" rather than failing the RPC (X7-5).
    // Drive a REAL failing RPC with `services.has` throwing to exercise that
    // catch: the handler must still be rethrown as a masked wire error.
    const app = createApplication({
      plugins: [RuntimePlugin(), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), {
      echo: () => {
        throw new Error('broken registry handler');
      },
    });

    // Break `has` ONLY for the logger token: the kernel's own `fetch` path calls
    // `has(HTTP_ADAPTER)` first, so a blanket throw would crash the kernel before
    // the RPC is even dispatched. The logger lookup is the one `resolveLogger`
    // guards, so only it may throw.
    const registry = app.services as unknown as { has: (token: string) => boolean };
    // `has` is a method on the registry instance, so keep it bound: calling it
    // unbound would drop its `this` and crash the kernel's own `has` call.
    const originalHas = registry.has.bind(registry);
    registry.has = (token: string) => {
      if (token === CAPABILITIES.LOGGER) {
        throw new Error('registry has() is broken');
      }
      return originalHas(token);
    };
    try {
      const response = await app.fetch(
        new Request('http://localhost:0/grpc/example.EchoService/Echo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'x' }),
        }),
      );
      // The broken registry did not crash the RPC: it still answers a masked error.
      expect(response.status).not.toBe(200);
    } finally {
      registry.has = originalHas;
    }

    await app.stop();
  });

  it('logs a throwing PROTOTYPE method (class instance) — regression for the own-property-only wrap', async () => {
    // A class instance's methods live on its prototype, so `Object.entries`
    // of the implementation sees none of them — the pre-fix wrapper wrapped
    // nothing and the throw was never logged. Connect resolves the procedure
    // by property lookup (`impl[method.localName]`), which DOES find the
    // prototype method, so it invokes it. The wrapper must wrap by the
    // descriptor's declared method names + property lookup, and preserve
    // receiver binding, so the class method is logged like any other.
    class EchoService {
      echo(): { response: string } {
        throw new Error('class handler blew up');
      }
    }

    const { logger, errors } = makeCapturingLogger();
    const app = createApplication({
      plugins: [RuntimePlugin(), loggerPlugin(logger), GrpcPlugin()],
    });
    await app.start({ port: 0 });

    const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
    grpc.addService(await reviveEchoService(), new EchoService());

    const response = await app.fetch(
      new Request('http://localhost:0/grpc/example.EchoService/Echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'x' }),
      }),
    );
    // The masked wire response is unchanged: Connect answers an error, not 200.
    expect(response.status).not.toBe(200);

    // The prototype method's throw WAS logged — the regression the own-
    // property-only enumeration introduced.
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('gRPC handler failed');
    expect(errors[0].metadata?.procedure).toBe('example.EchoService/echo');
    expect(errors[0].metadata?.message).toBe('class handler blew up');
    expect(errors[0].metadata?.name).toBe('Error');

    await app.stop();
  });
});
