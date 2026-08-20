// deno-lint-ignore-file no-console -- captures the real ConsoleLogger's console.log output
/**
 * E2E — instrumentation outcome reporting in the STANDARD plugin configuration.
 *
 * Boots a REAL kernel application with the real `RuntimePlugin` +
 * `LoggerPlugin` + `TelemetryPlugin` (no hand-built mock context) and asserts
 * the outcome lines are actually emitted through the plugin's logger: `debug`
 * for an enabled instrumentation, `warn` for a failure carrying `kind` and
 * `reason`.
 *
 * This is the regression guard the unit test cannot provide: the unit test
 * sets `mock.ctx.logger` on a hand-built context before calling `register()`,
 * so it never sees the kernel's plugin ordering. The kernel resolver orders
 * plugins by dependency edges first, then priority — without a `logger` edge
 * in `TelemetryPlugin.optionalDependencies`, `TelemetryPlugin` (priority 30)
 * registers before `LoggerPlugin` (priority 100) and the reporter's call-time
 * read of `ctx.logger` sees `undefined`, dropping every outcome line. The
 * second test pins the edge as OPTIONAL: the documented no-logger
 * configuration must still boot and emit nothing (a hard `dependencies` entry
 * would throw at resolve time instead).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { TelemetryPlugin } from '../../src/index.ts';
import { createFakeTracerHost } from '../fixtures/fake-tracer-host.ts';

/**
 * Builds the standard-config plugin set. The injected instrumentation
 * instances take the registry's inject path, so the outcomes are deterministic
 * on every runtime — no lazy `npm:` load and no platform gate involved.
 */
function createStandardPlugins(logger: boolean) {
  const okInstrumentation = {
    setTracerProvider: () => {},
    enable: () => {},
    disable: () => {},
  };
  const failingInstrumentation = {
    setTracerProvider: () => {
      throw new Error('boom-injected');
    },
    enable: () => {},
    disable: () => {},
  };
  const telemetry = TelemetryPlugin({
    serviceName: 'telemetry-outcome-e2e',
    exporter: 'console',
    tracerProviderFactory: () =>
      Promise.resolve({
        ...createFakeTracerHost(),
        otelProvider: { id: 'fake-provider' },
      }),
    instrumentations: {
      http: { instrumentation: okInstrumentation },
      ioredis: { instrumentation: failingInstrumentation },
    },
  });
  return logger
    ? [RuntimePlugin(), LoggerPlugin({ level: 'debug' }), telemetry]
    : [RuntimePlugin(), telemetry];
}

describe('telemetry outcome reporting — standard plugin configuration (real kernel app)', () => {
  it('reports enabled and failed instrumentation outcomes through the real LoggerPlugin', async () => {
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = ((...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    }) as typeof console.log;

    const app = createApplication({ plugins: createStandardPlugins(true) });
    try {
      await app.start();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/probe' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.stop();
      console.log = originalLog;
    }

    const outcomeLines = captured.filter((l) => l.includes('Auto-instrumentation'));
    // The enabled instrumentation is reported at debug, carrying the kind.
    expect(
      outcomeLines.some(
        (l) =>
          l.includes('"level":"debug"') &&
          l.includes('Auto-instrumentation enabled: http') &&
          l.includes('"kind":"http"'),
      ),
    ).toBe(true);
    // The failed instrumentation is reported at warn with kind + reason.
    expect(
      outcomeLines.some(
        (l) =>
          l.includes('"level":"warn"') &&
          l.includes('Auto-instrumentation unavailable: ioredis') &&
          l.includes('"kind":"ioredis"') &&
          l.includes('"reason":"boom-injected"'),
      ),
    ).toBe(true);
  });

  it('boots without a logger and emits no outcome lines (the edge is optional, not required)', async () => {
    const captured: string[] = [];
    const originalLog = console.log;
    console.log = ((...args: unknown[]) => {
      captured.push(args.map((a) => String(a)).join(' '));
    }) as typeof console.log;

    const app = createApplication({ plugins: createStandardPlugins(false) });
    try {
      await app.start();
      const res = await app.inject({ method: 'GET', url: 'http://localhost/probe' });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.stop();
      console.log = originalLog;
    }

    // Documented no-op: outcomes are recorded on the registry handle, but with
    // no logger nothing is emitted and the app boots cleanly.
    expect(captured.filter((l) => l.includes('Auto-instrumentation'))).toHaveLength(0);
  });
});
