/**
 * Integration test: cancellation through a real kernel app over the real
 * RuntimePlugin, so the deadline is driven by the real runtime timers rather
 * than a fake clock.
 *
 * These are the tests that fail against the pre-Milestone-47 implementation,
 * which raced the protected call against a timer and left it running.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { HardenedCall, IResilienceService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ResiliencePlugin, TimeoutError } from '../../src/index.ts';

/**
 * A long-running dependency that honors an `AbortSignal`, and records whether
 * it ran to completion. The recorded flag is the evidence: before the fix it
 * flipped to `true` after the caller had already given up.
 */
function createAbortableWork(): {
  readonly call: (signal: AbortSignal) => Promise<string>;
  readonly didComplete: () => boolean;
  readonly wasAborted: () => boolean;
} {
  let completed = false;
  let aborted = false;
  return {
    call: (signal: AbortSignal): Promise<string> =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          completed = true;
          resolve('completed');
        }, 2_000);
        signal.addEventListener('abort', () => {
          aborted = true;
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }),
    didComplete: () => completed,
    wasAborted: () => aborted,
  };
}

describe('ResiliencePlugin cancellation integration', () => {
  it('cancels the protected call when the timeout deadline elapses', async () => {
    const work = createAbortableWork();

    const app = createApplication({
      plugins: [RuntimePlugin(), ResiliencePlugin()],
    });

    let guarded: HardenedCall<string> = () => Promise.resolve('');
    app.register({
      name: 'consumer',
      version: '1.0.0',
      dependencies: ['resilience'],
      register(ctx) {
        const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);
        guarded = resilience.wrap(work.call, { timeout: 20 });
      },
    });

    await app.start();

    await expect(guarded()).rejects.toBeInstanceOf(TimeoutError);

    // The call observed the cancellation and tore down its own work...
    expect(work.wasAborted()).toBe(true);
    // ...and, crucially, never ran to completion in the background. Waiting
    // past the dependency's own 2s duration would be slow, so instead assert
    // the teardown that makes completion impossible.
    expect(work.didComplete()).toBe(false);

    await app.stop();
  });

  it('cancels the protected call when the caller aborts from outside', async () => {
    const work = createAbortableWork();

    const app = createApplication({
      plugins: [RuntimePlugin(), ResiliencePlugin()],
    });

    let guarded: HardenedCall<string> = () => Promise.resolve('');
    app.register({
      name: 'consumer',
      version: '1.0.0',
      dependencies: ['resilience'],
      register(ctx) {
        const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);
        guarded = resilience.wrap(work.call, { timeout: 10_000 });
      },
    });

    await app.start();

    const controller = new AbortController();
    const pending = guarded(controller.signal);
    controller.abort(new Error('client disconnected'));

    await expect(pending).rejects.toThrow('client disconnected');
    expect(work.wasAborted()).toBe(true);
    expect(work.didComplete()).toBe(false);

    await app.stop();
  });

  it('does not retry a call the caller cancelled', async () => {
    let attempts = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ResiliencePlugin({ defaultRetry: { limit: 5, delay: 10, backoff: 'fixed' } }),
      ],
    });

    const controller = new AbortController();
    let guarded: HardenedCall<string> = () => Promise.resolve('');
    app.register({
      name: 'consumer',
      version: '1.0.0',
      dependencies: ['resilience'],
      register(ctx) {
        const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);
        guarded = resilience.wrap(() => {
          attempts++;
          controller.abort(new Error('gave up'));
          return Promise.reject(new Error('transient'));
        }, { retry: true });
      },
    });

    await app.start();

    await expect(guarded(controller.signal)).rejects.toThrow('gave up');
    // One attempt, not five: cancellation ends the sequence.
    expect(attempts).toBe(1);

    await app.stop();
  });
});
