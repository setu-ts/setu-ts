/**
 * Integration test: the kernel's fallback 500 logs the unhandled error at
 * `error` level (plan §3.4, X11-2), carrying the message, the serialized
 * stack, the method and the path — while the response body stays opaque. A
 * 404 emits no unhandled-error line (it is not an error).
 *
 * A real `LoggerPlugin` app (the production default `console` transport) is
 * used, with `console.log` captured, so the assertion is on the actual
 * operator-visible line, not on a fake logger.
 *
 * @module
 */
// deno-lint-ignore-file no-console
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '../../src/index.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { LoggerPlugin } from '@setu-ts/logger-plugin';

function runtimePlugin(): IPlugin {
  const fake = createFakeRuntime();
  return {
    name: 'fake-runtime',
    version: '1.0.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, fake.runtime);
    },
  };
}

/** Installs a `console.log` hook that appends to `logs`; returns the restore fn. */
function hookConsole(logs: string[]): () => void {
  const original = console.log;
  // deno-lint-ignore no-explicit-any
  (console as any).log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  return () => {
    console.log = original;
  };
}

describe('kernel fallback 500 is logged (X11-2)', () => {
  it('logs one error line with message, stack, method and path; body stays opaque', async () => {
    const app = createApplication({
      plugins: [runtimePlugin(), LoggerPlugin({ level: 'debug' })],
    });
    app.router.get('/boom', () => {
      throw new Error('kaboom from handler');
    });
    await app.start();

    const logs: string[] = [];
    const restore = hookConsole(logs);
    let boom: Awaited<ReturnType<typeof app.inject>>;
    let nf: Awaited<ReturnType<typeof app.inject>>;
    try {
      boom = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
      nf = await app.inject({ method: 'GET', url: 'http://localhost/nope' });
    } finally {
      restore();
    }

    const errorLines = logs.filter((l) => l.includes('Unhandled request error'));
    expect(errorLines.length).toBe(1);
    const line = errorLines[0]!;
    expect(line).toContain('kaboom from handler');
    expect(line).toContain('Error: kaboom from handler');
    expect(line).toContain('"method":"GET"');
    expect(line).toContain('"path":"/boom"');

    // The body discloses neither the message nor the stack.
    expect(boom.statusCode).toBe(500);
    expect(JSON.parse(boom.body as string)).toEqual({ error: 'Internal Server Error' });
    expect(boom.body ?? '').not.toContain('kaboom');

    // A 404 is not an unhandled error: no error line for it.
    expect(nf.statusCode).toBe(404);
    expect(
      logs.filter((l) => l.includes('Unhandled request error') && l.includes('"/nope"')).length,
    )
      .toBe(0);

    await app.stop();
  });
});
