import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { registerContextManager } from '../../src/tracing/context-manager.ts';

/** A context manager stand-in with the two members OTel's registration accepts. */
function fakeManager(): { enable(): unknown; disable(): unknown } {
  return { enable: () => undefined, disable: () => undefined };
}

describe('registerContextManager', () => {
  it('reports `registered` when it installs the manager itself', async () => {
    let received: unknown = null;
    const outcome = await registerContextManager(
      {
        setGlobalContextManager: (manager) => {
          received = manager;
          return true;
        },
      },
      () => Promise.resolve(fakeManager()),
    );

    expect(received).not.toBeNull();
    expect(outcome).toEqual({ activated: true, adopted: 'registered' });
  });

  it('reports `existing` — not a failure — when a manager is already installed', async () => {
    // OTel refuses a second registration, but the host's manager propagates
    // context just as well, so activation IS available. The two cases must stay
    // distinguishable: collapsing them (the `|| true` form) makes the
    // setGlobalContextManager return value dead and the outcome unreadable.
    const outcome = await registerContextManager(
      { setGlobalContextManager: () => false },
      () => Promise.resolve(fakeManager()),
    );

    expect(outcome).toEqual({ activated: true, adopted: 'existing' });
  });

  it('degrades with a named reason when the optional manager cannot load', async () => {
    let called = false;
    const outcome = await registerContextManager(
      {
        setGlobalContextManager: () => {
          called = true;
          return true;
        },
      },
      () => Promise.reject(new Error('not installed')),
    );

    expect(outcome.activated).toBe(false);
    expect(called).toBe(false);
    // The reason names BOTH the specifier and the underlying failure, so an
    // operator reading the warn line knows what to install.
    expect(outcome.activated === false && outcome.reason).toContain(
      '@opentelemetry/context-async-hooks',
    );
    expect(outcome.activated === false && outcome.reason).toContain('not installed');
  });

  it('names a non-Error rejection rather than reporting "undefined"', async () => {
    const outcome = await registerContextManager(
      { setGlobalContextManager: () => true },
      () => Promise.reject('bare string'),
    );

    expect(outcome.activated).toBe(false);
    expect(outcome.activated === false && outcome.reason).toContain('bare string');
  });

  it('never throws, so a failure cannot prevent startup', async () => {
    // Activation is an enhancement. A throwing registration must degrade to
    // unnested spans, never propagate out of `register()` and stop the app.
    const outcome = await registerContextManager(
      {
        setGlobalContextManager: () => {
          throw new Error('registration exploded');
        },
      },
      () => Promise.resolve(fakeManager()),
    );

    expect(outcome.activated).toBe(false);
    expect(outcome.activated === false && outcome.reason).toContain('registration exploded');
  });
});
