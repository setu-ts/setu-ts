import { describe, expect, it } from 'vitest';

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

describe('LifecycleManager after a cancelled start', () => {
  it('runs a late close hook at once and drops every other registration', async () => {
    const lifecycle = new LifecycleManager();
    const late: (() => void | Promise<void>)[] = [];
    lifecycle.cancelRegistrations((hook) => late.push(hook));
    const ran: string[] = [];
    lifecycle.onRegister(() => void ran.push('register'));
    lifecycle.onInit(() => void ran.push('init'));
    lifecycle.onBootstrap(() => void ran.push('bootstrap'));
    lifecycle.onRequest(() => void ran.push('request'));
    lifecycle.onResponse(() => void ran.push('response'));
    lifecycle.onError(() => void ran.push('error'));
    lifecycle.onStopping(() => void ran.push('stopping'));
    lifecycle.onShutdown(() => void ran.push('shutdown'));
    lifecycle.onClose(() => void ran.push('close'));

    await lifecycle.runRegister();
    await lifecycle.runInit();
    await lifecycle.runBootstrap();
    await lifecycle.runStopping();
    await lifecycle.runShutdown();
    await lifecycle.runClose();
    expect(lifecycle.getRequestHooks()).toHaveLength(0);
    expect(lifecycle.getResponseHooks()).toHaveLength(0);
    expect(lifecycle.getErrorHooks()).toHaveLength(0);
    expect(lifecycle.hasStopping()).toBe(false);
    expect(ran).toEqual([]);
    expect(late).toHaveLength(1);
    await late[0]!();
    expect(ran).toEqual(['close']);
  });
});
