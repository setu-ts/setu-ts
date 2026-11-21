/**
 * The fatal-error observers behind `IRuntimeServices.onFatalError` (V13-11),
 * driven through fake process and event hosts. The real mechanisms are proved
 * in child processes by `test/e2e/fatal-error-process.test.ts`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import {
  createBunFatalErrorObserver,
  createDenoFatalErrorObserver,
  createNodeFatalErrorObserver,
  processFatalErrors,
} from '../../src/adapters/shared/fatal-error-observer.ts';
import type { FatalErrorHandler } from '../../src/adapters/shared/fatal-error-observer.ts';
import { buildNodeHost, createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';
import { buildBunHost, createBunRuntimeServices } from '../../src/adapters/bun/bun-runtime.ts';

/** A process double that records listeners like `EventEmitter`. */
class FakeProcess {
  readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void): this {
    this.listeners.set(
      event,
      (this.listeners.get(event) ?? []).filter((entry) => entry !== listener),
    );
    return this;
  }
  listenerCount(event: string): number {
    return this.listeners.get(event)?.length ?? 0;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** Records reports. */
function recorder(): { handler: FatalErrorHandler; seen: [unknown, string][] } {
  const seen: [unknown, string][] = [];
  return { seen, handler: (error, origin) => seen.push([error, origin]) };
}

describe('Node observer', () => {
  it('reports both origins from the monitor and removes its one listener when empty', () => {
    const proc = new FakeProcess();
    const subscribe = createNodeFatalErrorObserver(proc);
    const a = recorder();
    const b = recorder();
    const offA = subscribe(a.handler);
    const offB = subscribe(b.handler);
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1);

    const error = new Error('x');
    proc.emit('uncaughtExceptionMonitor', error, 'uncaughtException');
    proc.emit('uncaughtExceptionMonitor', error, 'unhandledRejection');
    expect(a.seen).toEqual([
      [error, 'uncaughtException'],
      [error, 'unhandledRejection'],
    ]);
    expect(b.seen).toHaveLength(2);

    offA();
    offA();
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1);
    offB();
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    // Subscribing again reinstalls it.
    subscribe(a.handler);
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(1);
  });

  it('isolates a throwing handler', () => {
    const proc = new FakeProcess();
    const subscribe = createNodeFatalErrorObserver(proc);
    const after = recorder();
    subscribe(() => {
      throw new Error('handler broke');
    });
    subscribe(after.handler);
    expect(() => proc.emit('uncaughtExceptionMonitor', 'boom', 'uncaughtException')).not.toThrow();
    expect(after.seen).toEqual([['boom', 'uncaughtException']]);
  });
});

describe('Bun observer', () => {
  it('rethrows an unhandled rejection when it is the only listener, reporting it once', () => {
    const proc = new FakeProcess();
    const subscribe = createBunFatalErrorObserver(proc);
    const seen = recorder();
    subscribe(seen.handler);
    const reason = new Error('rejected');
    expect(() => proc.emit('unhandledRejection', reason)).toThrow(reason);
    // Bun turns the rethrow into an uncaught exception: not reported again.
    proc.emit('uncaughtExceptionMonitor', reason, 'uncaughtException');
    expect(seen.seen).toEqual([[reason, 'unhandledRejection']]);
  });

  it('wraps a primitive reason so the rethrow is recognised too', () => {
    const proc = new FakeProcess();
    const subscribe = createBunFatalErrorObserver(proc);
    const seen = recorder();
    subscribe(seen.handler);
    let thrown: unknown;
    try {
      proc.emit('unhandledRejection', 'plain');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('Unhandled rejection: plain');
    proc.emit('uncaughtExceptionMonitor', thrown, 'uncaughtException');
    expect(seen.seen).toEqual([['plain', 'unhandledRejection']]);
  });

  it('does not rethrow when the application has its own rejection listener', () => {
    const proc = new FakeProcess();
    proc.on('unhandledRejection', () => {});
    const subscribe = createBunFatalErrorObserver(proc);
    const seen = recorder();
    subscribe(seen.handler);
    expect(() => proc.emit('unhandledRejection', new Error('handled'))).not.toThrow();
    expect(seen.seen).toHaveLength(1);
  });

  it('reports a thrown error from the monitor and removes both listeners', () => {
    const proc = new FakeProcess();
    const subscribe = createBunFatalErrorObserver(proc);
    const seen = recorder();
    const off = subscribe(seen.handler);
    proc.emit('uncaughtExceptionMonitor', 'thrown', 'uncaughtException');
    expect(seen.seen).toEqual([['thrown', 'uncaughtException']]);
    off();
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    expect(proc.listenerCount('unhandledRejection')).toBe(0);
  });
});

describe('Deno observer', () => {
  it('reports the global error and unhandledrejection events and detaches', () => {
    const target = new EventTarget();
    const subscribe = createDenoFatalErrorObserver(target);
    const seen = recorder();
    const off = subscribe(seen.handler);
    const error = new Error('thrown');
    const errorEvent = Object.assign(new Event('error'), { error });
    target.dispatchEvent(errorEvent);
    const rejection = Object.assign(new Event('unhandledrejection'), { reason: 'why' });
    target.dispatchEvent(rejection);
    expect(seen.seen).toEqual([
      [error, 'uncaughtException'],
      ['why', 'unhandledRejection'],
    ]);
    off();
    target.dispatchEvent(errorEvent);
    expect(seen.seen).toHaveLength(2);
  });
});

describe('runtime wiring', () => {
  it('builds onFatalError only from a process that can add, remove and count listeners', () => {
    expect(processFatalErrors({ on() {} }, createNodeFatalErrorObserver)).toEqual({});
    const proc = new FakeProcess();
    expect(typeof processFatalErrors(proc, createNodeFatalErrorObserver).onFatalError).toBe(
      'function',
    );
  });

  it('exposes onFatalError on the Node and Bun runtimes over a real process', () => {
    expect(typeof createNodeRuntimeServices(buildNodeHost()).onFatalError).toBe('function');
    expect(typeof createBunRuntimeServices(buildBunHost()).onFatalError).toBe('function');
  });

  it('subscribes the Node runtime through the process it was built from', () => {
    const proc = new FakeProcess();
    const host = buildNodeHost({
      fs: {} as never,
      proc: Object.assign(proc, { version: 'v24', env: {}, exit: (() => {}) as never }),
      hostname: () => 'h',
    });
    const seen = recorder();
    const off = createNodeRuntimeServices(host).onFatalError!(seen.handler);
    proc.emit('uncaughtExceptionMonitor', 'x', 'uncaughtException');
    expect(seen.seen).toEqual([['x', 'uncaughtException']]);
    off();
    expect(proc.listenerCount('uncaughtExceptionMonitor')).toBe(0);
  });

  it('omits onFatalError where the host cannot observe', () => {
    const host = { ...buildNodeHost() };
    delete host.onFatalError;
    expect(createNodeRuntimeServices(host).onFatalError).toBeUndefined();
  });

  it('forwards SIGHUP through onSignal (V13-12)', () => {
    const proc = new FakeProcess();
    const host = buildNodeHost({
      fs: {} as never,
      proc: Object.assign(proc, { version: 'v24', env: {}, exit: (() => {}) as never }),
      hostname: () => 'h',
    });
    let ran = false;
    createNodeRuntimeServices(host).onSignal!('SIGHUP', () => {
      ran = true;
    });
    proc.emit('SIGHUP');
    expect(ran).toBe(true);
  });
});
