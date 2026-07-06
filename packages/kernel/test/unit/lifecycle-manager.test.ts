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
