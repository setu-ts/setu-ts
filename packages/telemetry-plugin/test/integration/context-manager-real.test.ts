/* eslint-disable no-console -- guarded skip tests log SKIP messages. */
/**
 * Real-import test for the optional OTel context manager (§12.2).
 *
 * The unit tests drive `registerContextManager` through its injectable seam;
 * this one exercises the literal `import()` and, more importantly, proves the
 * manager actually propagates context across `await`. Without that, `activate`
 * runs but parents nothing — the default global manager is a
 * `NoopContextManager` whose `with()` propagates NOTHING, not even
 * synchronously, so "the package loaded" is not evidence that activation works.
 */
import { describe, expect, it } from 'vitest';
import {
  loadAsyncLocalStorageContextManager,
  registerContextManager,
} from '../../src/tracing/context-manager.ts';

describe('AsyncLocalStorage context manager real import', () => {
  it('loads the real optional manager', async () => {
    const manager = await loadAsyncLocalStorageContextManager();
    expect(typeof manager.enable).toBe('function');
    expect(typeof manager.disable).toBe('function');
    manager.disable();
  });

  it('propagates context across await once registered, which is what activation needs', async () => {
    let api: typeof import('@opentelemetry/api');
    try {
      api = await import('@opentelemetry/api');
    } catch {
      console.warn('skipped: @opentelemetry/api is not resolvable');
      return;
    }

    const outcome = await registerContextManager(
      api.context as unknown as Parameters<typeof registerContextManager>[0],
      loadAsyncLocalStorageContextManager,
    );
    expect(outcome.activated).toBe(true);

    const key = api.createContextKey('m75-probe');
    const inside = await api.context.with(
      api.context.active().setValue(key, 'carried'),
      async () => {
        // The await is the point: a synchronous-only manager loses the value
        // here, and so would every span created after an await in a handler.
        await new Promise((resolve) => setTimeout(resolve, 1));
        return api.context.active().getValue(key);
      },
    );

    expect(inside).toBe('carried');
    // And the scope really is scoped — the value is gone outside it.
    expect(api.context.active().getValue(key)).toBeUndefined();
  });
});
