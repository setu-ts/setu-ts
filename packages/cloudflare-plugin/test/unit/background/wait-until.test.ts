/**
 * Background work is by definition work nobody awaits, so the rejection path
 * is the one that matters: an unreported failure here is invisible.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, LogMetadata } from '@hono-enterprise/common';

import { resolveWaitUntil } from '../../../src/background/wait-until.ts';

interface Logged {
  readonly message: string;
  readonly meta: LogMetadata | undefined;
}

function recordingLogger(): { logger: ILogger; errors: Logged[] } {
  const errors: Logged[] = [];
  const noop = (): void => {};
  const logger = {
    fatal: noop,
    error: (message: string, meta?: LogMetadata): void => {
      errors.push({ message, meta });
    },
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: (): ILogger => logger,
  } as unknown as ILogger;
  return { logger, errors };
}

describe('resolveWaitUntil', () => {
  it('hands the promise to the injected host', async () => {
    const seen: Promise<unknown>[] = [];
    const waitUntil = resolveWaitUntil((p) => {
      seen.push(p);
    }, () => undefined);

    waitUntil(Promise.resolve('done'));

    expect(seen).toHaveLength(1);
    await seen[0];
  });

  it('reports a rejection through the logger instead of leaving it unhandled', async () => {
    const { logger, errors } = recordingLogger();
    const settled: Promise<unknown>[] = [];
    const waitUntil = resolveWaitUntil((p) => {
      settled.push(p);
    }, () => logger);

    waitUntil(Promise.reject(new Error('shipping analytics failed')));
    await Promise.all(settled);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('cloudflare: background task failed');
    expect(errors[0]?.meta).toEqual({ error: 'shipping analytics failed' });
  });

  it('stringifies a non-Error rejection value', async () => {
    const { logger, errors } = recordingLogger();
    const settled: Promise<unknown>[] = [];
    const waitUntil = resolveWaitUntil((p) => {
      settled.push(p);
    }, () => logger);

    waitUntil(Promise.reject('a bare string'));
    await Promise.all(settled);

    expect(errors[0]?.meta).toEqual({ error: 'a bare string' });
  });

  it('hands the host a promise that never rejects, so waitUntil is not aborted', async () => {
    const settled: Promise<unknown>[] = [];
    const waitUntil = resolveWaitUntil((p) => {
      settled.push(p);
    }, () => undefined);

    waitUntil(Promise.reject(new Error('boom')));

    // Resolves rather than rejecting: the handler is attached before the host
    // ever sees the promise.
    await expect(settled[0]).resolves.toBeUndefined();
  });

  it('resolves the logger at failure time, not at construction', async () => {
    // The plugin context resolves `logger` lazily, and a capability may be
    // registered imperatively after this seam is built. Capturing the value up
    // front would swallow every later report.
    const { logger, errors } = recordingLogger();
    let current: ILogger | undefined;
    const settled: Promise<unknown>[] = [];
    const waitUntil = resolveWaitUntil((p) => {
      settled.push(p);
    }, () => current);

    // Built while no logger was resolvable...
    current = logger; // ...and one appears before the failure happens.
    waitUntil(Promise.reject(new Error('late-logger failure')));
    await Promise.all(settled);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe('cloudflare: background task failed');
  });

  it('still runs and still reports the work with no host injected', async () => {
    const { logger, errors } = recordingLogger();
    const waitUntil = resolveWaitUntil(undefined, () => logger);
    let ran = false;

    waitUntil(
      Promise.resolve().then(() => {
        ran = true;
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toBe(true);

    waitUntil(Promise.reject(new Error('off-platform failure')));
    // Two microtask turns: one for the rejection, one for the catch handler.
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
  });
});
