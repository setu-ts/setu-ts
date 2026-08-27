import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { registerContextManager } from '../../src/tracing/context-manager.ts';

describe('registerContextManager', () => {
  it('registers the manager and treats an existing host manager as usable', async () => {
    let received = false;
    const api = {
      setGlobalContextManager: () => {
        received = true;
        return false;
      },
    };

    const result = await registerContextManager(api, () =>
      Promise.resolve({
        enable: () => undefined,
        disable: () => undefined,
      }));

    expect(received).toBe(true);
    expect(result).toBe(true);
  });

  it('degrades safely when the optional manager cannot load', async () => {
    const result = await registerContextManager(
      { setGlobalContextManager: () => true },
      () => Promise.reject(new Error('not installed')),
    );
    expect(result).toBe(false);
  });
});
