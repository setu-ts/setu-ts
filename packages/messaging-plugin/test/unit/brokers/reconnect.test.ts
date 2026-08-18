import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import { fullJitterDelay, ReconnectSupervisor } from '../../../src/brokers/reconnect.ts';

/**
 * Drains the microtask queue: a real 0ms macrotask runs only after every
 * pending microtask (the supervisor's async attempt chain) has settled. The
 * fake clock's timers are a separate mechanism and are unaffected.
 */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * A controllable clock so backoff delays are deterministic and can be flushed
 * without real waiting.
 */
function makeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
      // Fire due timers in order; a timer may schedule more timers.
      for (const [id, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    setTimeout: (fn: () => void, ms: number): TimerHandle => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return { id } as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle) => {
      timers.delete((handle as { id: number }).id);
    },
    pending: () => timers.size,
  };
}

function makeRuntime(clock: ReturnType<typeof makeClock>): IRuntimeServices {
  return {
    platform: () => 'deno' as const,
    version: () => 'test',
    now: () => clock.now(),
    hrtime: () => clock.now(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: (fn: () => void, ms: number) => clock.setTimeout(fn, ms),
    clearInterval: (handle: TimerHandle) => clock.clearTimeout(handle),
    uuid: () => 'u',
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit');
    },
    hostname: () => 'localhost',
  };
}

describe('fullJitterDelay', () => {
  it('is always within [0, min(maxMs, initialMs * 2^attempt)]', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const ceiling = Math.min(30_000, 500 * 2 ** attempt);
      for (let i = 0; i < 200; i++) {
        const d = fullJitterDelay(attempt, 500, 30_000);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('caps at maxMs for large attempt indices', () => {
    for (let i = 0; i < 200; i++) {
      expect(fullJitterDelay(100, 500, 30_000)).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('ReconnectSupervisor', () => {
  it('drive mode requires reconnect and replay', () => {
    const runtime = makeRuntime(makeClock());
    expect(
      () =>
        new ReconnectSupervisor({
          runtime,
          mode: 'drive',
          attachFaultListener: () => () => {},
        }),
    ).toThrow('drive mode requires reconnect and replay');
  });

  it('observe mode does not require reconnect/replay', () => {
    const runtime = makeRuntime(makeClock());
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => () => {},
    });
    expect(sup.faulted).toBe(false);
  });

  it('drive: a fault triggers a reconnect, reassert, and replay on success', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    let reconnects = 0;
    let reasserts = 0;
    let replays = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      initialMs: 1,
      maxMs: 2,
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      reassert: () => {
        reasserts++;
        return Promise.resolve();
      },
      replay: () => {
        replays++;
        return Promise.resolve();
      },
      attachFaultListener: () => () => {},
    });
    sup.start();
    expect(sup.faulted).toBe(false);
    sup.fault();
    expect(sup.faulted).toBe(true);
    // Flush the (tiny) backoff timer, then the async attempt chain.
    clock.advance(1000);
    await flush();
    expect(reconnects).toBe(1);
    expect(reasserts).toBe(1);
    expect(replays).toBe(1);
    expect(sup.faulted).toBe(false);
  });

  it('drive: a failing reconnect retries rather than terminating', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    let attempts = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      initialMs: 1,
      maxMs: 2,
      reconnect: () => {
        attempts++;
        return Promise.reject(new Error('still down'));
      },
      replay: () => Promise.resolve(),
      attachFaultListener: () => () => {},
    });
    sup.start();
    sup.fault();
    // Flush several backoff windows; each failed attempt reschedules.
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await flush();
    }
    expect(attempts).toBeGreaterThan(1);
    expect(sup.faulted).toBe(true);
  });

  it('observe: a fault only sets the flag; recovery clears it', () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => () => {},
    });
    sup.start();
    sup.fault();
    expect(sup.faulted).toBe(true);
    // Observe mode must not schedule any reconnect timer.
    expect(clock.pending()).toBe(0);
    sup.recovered();
    expect(sup.faulted).toBe(false);
  });

  it('stop() cancels a pending attempt and removes every attached listener', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    let added = 0;
    let removed = 0;
    let reconnects = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      initialMs: 1000,
      maxMs: 2000,
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      replay: () => Promise.resolve(),
      attachFaultListener: () => {
        added++;
        return () => {
          removed++;
        };
      },
    });
    sup.start();
    expect(added).toBe(1);
    sup.fault();
    expect(clock.pending()).toBe(1);
    sup.stop();
    // Pending attempt cancelled; listener removed.
    expect(clock.pending()).toBe(0);
    expect(removed).toBe(1);
    // A late clock flush must not fire the cancelled attempt.
    clock.advance(10_000);
    await flush();
    expect(reconnects).toBe(0);
  });

  it('drive: reconnecting re-attaches listeners so cycles do not accumulate', async () => {
    const clock = makeClock();
    const runtime = makeRuntime(clock);
    let added = 0;
    let removed = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'drive',
      initialMs: 1,
      maxMs: 2,
      reconnect: async () => {},
      replay: async () => {},
      attachFaultListener: () => {
        added++;
        return () => {
          removed++;
        };
      },
    });
    sup.start();
    // Drive three fault/reconnect cycles.
    for (let i = 0; i < 3; i++) {
      sup.fault();
      clock.advance(1000);
      await flush();
    }
    // Each successful reconnect re-attaches (adds 1) after detaching the old
    // (removes 1), so net listeners stay at 1, not N.
    sup.stop();
    expect(added).toBe(1 + 3); // start + 3 re-attaches
    expect(removed).toBe(1 + 3); // 3 detach-on-reattach + 1 final stop
  });

  it('start() is idempotent: a second call attaches no extra listeners', () => {
    const runtime = makeRuntime(makeClock());
    let added = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => {
        added++;
        return () => {};
      },
    });
    sup.start();
    sup.start(); // already running: no-op
    expect(added).toBe(1);
  });

  it('start() after stop() is a no-op', () => {
    const runtime = makeRuntime(makeClock());
    let added = 0;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => {
        added++;
        return () => {};
      },
    });
    sup.start();
    sup.stop();
    sup.start(); // stopping: no-op
    expect(added).toBe(1);
  });

  it('opens ONE attempt loop when the client reports a loss twice', async () => {
    // amqplib's `onSocketError` emits `'error'` and then `'close'`, and
    // RabbitMqBroker wires the SAME listener to both, so a single socket loss
    // calls fault() twice. Without the fault-window guard each call started
    // its own reconnect loop: two connections opened, one orphaned (never
    // closed, because `#reconnect()` overwrites `#connection`), and a
    // duplicate consumer registered per active subscription.
    const clock = makeClock();
    let reconnects = 0;
    let replays = 0;
    const sup = new ReconnectSupervisor({
      runtime: makeRuntime(clock),
      mode: 'drive',
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      replay: () => {
        replays++;
        return Promise.resolve();
      },
      attachFaultListener: () => () => {},
    });
    sup.start();

    sup.fault(); // 'error'
    sup.fault(); // 'close', same underlying loss

    expect(clock.pending()).toBe(1);
    clock.advance(60_000);
    await flush();
    await flush();

    expect(reconnects).toBe(1);
    expect(replays).toBe(1);
  });

  it('opens a fresh attempt loop for a LATER, distinct fault', async () => {
    // The guard is a fault WINDOW, not a one-shot: once an attempt succeeds
    // the window closes, and a subsequent outage must reconnect again.
    const clock = makeClock();
    let reconnects = 0;
    const sup = new ReconnectSupervisor({
      runtime: makeRuntime(clock),
      mode: 'drive',
      reconnect: () => {
        reconnects++;
        return Promise.resolve();
      },
      replay: () => Promise.resolve(),
      attachFaultListener: () => () => {},
    });
    sup.start();

    sup.fault();
    clock.advance(60_000);
    await flush();
    await flush();
    expect(reconnects).toBe(1);
    expect(sup.faulted).toBe(false);

    sup.fault(); // a new outage, after recovery
    clock.advance(60_000);
    await flush();
    await flush();
    expect(reconnects).toBe(2);
  });

  it('fault() before start() is a no-op', () => {
    const runtime = makeRuntime(makeClock());
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => () => {},
    });
    sup.fault(); // not running: no-op
    expect(sup.faulted).toBe(false);
  });

  it('fault() after stop() is a no-op', () => {
    const runtime = makeRuntime(makeClock());
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => () => {},
    });
    sup.start();
    sup.stop();
    sup.fault(); // stopping: no-op
    expect(sup.faulted).toBe(false);
  });

  it('recovered() after stop() is a no-op', () => {
    const runtime = makeRuntime(makeClock());
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: () => () => {},
    });
    sup.start();
    sup.fault();
    sup.stop();
    sup.recovered(); // stopping: no-op
    expect(sup.faulted).toBe(false);
  });

  it('observe: a recovery listener attached at start() clears the fault', () => {
    const runtime = makeRuntime(makeClock());
    let onFault: (() => void) | undefined;
    let onRecovered: (() => void) | undefined;
    const sup = new ReconnectSupervisor({
      runtime,
      mode: 'observe',
      attachFaultListener: (fn) => {
        onFault = fn;
        return () => {};
      },
      attachRecoveryListener: (fn) => {
        onRecovered = fn;
        return () => {};
      },
    });
    sup.start();
    expect(onFault).toBeDefined();
    expect(onRecovered).toBeDefined();
    onFault!();
    expect(sup.faulted).toBe(true);
    onRecovered!();
    expect(sup.faulted).toBe(false);
  });
});
