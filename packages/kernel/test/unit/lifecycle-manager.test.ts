import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { LifecycleManager } from '../../src/lifecycle/lifecycle-manager.ts';

describe('LifecycleManager.runRegister', () => {
  it('runs registered onRegister hooks in registration order', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];
    lifecycle.onRegister(() => {
      order.push('first');
    });
    lifecycle.onRegister(() => {
      order.push('second');
    });

    await lifecycle.runRegister();

    expect(order).toEqual(['first', 'second']);
  });

  it('drains only hooks added since the previous call (cursor)', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];

    lifecycle.onRegister(() => {
      order.push('a');
    });
    await lifecycle.runRegister();

    // Hook added after the first drain must run on the next drain, and the
    // already-run hook must NOT run again.
    lifecycle.onRegister(() => {
      order.push('b');
    });
    await lifecycle.runRegister();

    expect(order).toEqual(['a', 'b']);
  });

  it('is a no-op when there are no pending hooks', async () => {
    const lifecycle = new LifecycleManager();
    await lifecycle.runRegister();
    // A second drain with nothing added is also safe.
    await lifecycle.runRegister();
  });

  it('drains a hook registered by another onRegister hook in the same pass', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];

    lifecycle.onRegister(() => {
      order.push('outer');
      lifecycle.onRegister(() => {
        order.push('inner');
      });
    });

    await lifecycle.runRegister();

    expect(order).toEqual(['outer', 'inner']);
  });

  it('supports async onRegister hooks', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];

    lifecycle.onRegister(async () => {
      await Promise.resolve();
      order.push('async');
    });

    await lifecycle.runRegister();

    expect(order).toEqual(['async']);
  });
});

describe('LifecycleManager — onStopping', () => {
  it('runs stopping hooks in reverse registration order (LIFO)', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];

    lifecycle.onStopping(() => {
      order.push('first');
    });
    lifecycle.onStopping(() => {
      order.push('second');
    });

    await lifecycle.runStopping();

    expect(order).toEqual(['second', 'first']);
  });

  it('awaits async stopping hooks', async () => {
    const lifecycle = new LifecycleManager();
    const order: string[] = [];

    lifecycle.onStopping(async () => {
      await Promise.resolve();
      order.push('async');
    });

    await lifecycle.runStopping();

    expect(order).toEqual(['async']);
  });

  it('runStopping() over an empty array resolves', async () => {
    const lifecycle = new LifecycleManager();
    await lifecycle.runStopping();
    expect(lifecycle.hasStopping()).toBe(false);
  });

  it('hasStopping() reports whether any hook is registered', () => {
    const lifecycle = new LifecycleManager();
    expect(lifecycle.hasStopping()).toBe(false);
    lifecycle.onStopping(() => {});
    expect(lifecycle.hasStopping()).toBe(true);
  });

  it('a rejecting stopping hook surfaces from runStopping()', async () => {
    const lifecycle = new LifecycleManager();
    lifecycle.onStopping(() => Promise.reject(new Error('hook failed')));
    await expect(lifecycle.runStopping()).rejects.toThrow('hook failed');
  });
});
