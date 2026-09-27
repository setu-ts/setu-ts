/**
 * Unit tests for event dispatch observations (M98j): the bounded collector
 * behind `IEventDiagnosticsSource`, the WeakMap attachment on the bus, and
 * the exact invocation-order guarantees of the observed dispatch.
 *
 * The signature each call type-checks against is the committed §3 contract:
 * `IEventDiagnosticsSource.snapshot()`, and the plugin option
 * `EventsPluginOptions.diagnostics`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IEventDiagnosticsSource, IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { EventsPlugin } from '../../src/index.ts';
import type { EventsDiagnosticsOptions } from '../../src/interfaces/index.ts';
import {
  compileEventsDiagnosticsPolicy,
  createDisabledEventSource,
  EVENT_COLLECTOR_ERRORS,
  EVENT_COLLECTOR_LIMITS,
  EventObservationCollector,
} from '../../src/diagnostics/event-observations.ts';
import { attachEventObserver, InMemoryEventBus } from '../../src/bus/in-memory-event-bus.ts';

/** A mutable monotonic clock standing in for `IRuntimeServices`. */
class MutableClock {
  nowMs = 0;
  hrtime(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

/** A minimal `IRuntimeServices` whose `hrtime` is the mutable clock. */
function clockRuntime(clock: MutableClock): IRuntimeServices {
  return {
    hrtime: () => clock.hrtime(),
  } as unknown as IRuntimeServices;
}

/** Builds a collector over a policy for one alias and two types. */
function collector(
  clock: MutableClock,
  events: Record<string, string> = { 'user-created': 'users' },
  alias = 'bus',
): EventObservationCollector {
  const policy = compileEventsDiagnosticsPolicy(
    {
      enabled: true,
      alias,
      events,
    } satisfies EventsDiagnosticsOptions,
  );
  return new EventObservationCollector(policy, clockRuntime(clock));
}

/** A deeply-frozen helper: asserts an object graph is frozen at every level. */
function expectDeeplyFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    expect(Object.isFrozen(value)).toBe(true);
    for (const member of Array.isArray(value) ? value : Object.values(value)) {
      expectDeeplyFrozen(member);
    }
  }
}

describe('compileEventsDiagnosticsPolicy (M98j option validation)', () => {
  it('refuses a non-object, a non-literal enabled, and a missing events map', () => {
    expect(() => compileEventsDiagnosticsPolicy(null as unknown as EventsDiagnosticsOptions))
      .toThrow(EVENT_COLLECTOR_ERRORS.badOptions);
    expect(() =>
      compileEventsDiagnosticsPolicy({ enabled: false } as unknown as EventsDiagnosticsOptions)
    ).toThrow(EVENT_COLLECTOR_ERRORS.notEnabled);
    expect(() =>
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 'bus',
      } as unknown as EventsDiagnosticsOptions)
    ).toThrow(EVENT_COLLECTOR_ERRORS.badEvents);
  });

  it('refuses bad aliases: wrong type, oversized, control characters, duplicates', () => {
    expect(() =>
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 4 as unknown as string,
        events: {},
      } as unknown as EventsDiagnosticsOptions)
    ).toThrow(EVENT_COLLECTOR_ERRORS.badAlias);
    expect(() =>
      compileEventsDiagnosticsPolicy({ enabled: true, alias: 'a'.repeat(65), events: {} })
    ).toThrow(EVENT_COLLECTOR_ERRORS.aliasBytes);
    expect(() => compileEventsDiagnosticsPolicy({ enabled: true, alias: 'bus\n', events: {} }))
      .toThrow(EVENT_COLLECTOR_ERRORS.aliasControl);
    expect(() =>
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 'bus',
        events: { 'a': 'same', 'b': 'same' },
      })
    ).toThrow(EVENT_COLLECTOR_ERRORS.duplicateAlias);
  });

  it('refuses more than 64 approved types and a non-string alias value', () => {
    const sixtyFive = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`t${index}`, `alias${index}`]),
    );
    expect(() => compileEventsDiagnosticsPolicy({ enabled: true, alias: 'bus', events: sixtyFive }))
      .toThrow(EVENT_COLLECTOR_ERRORS.tooManyEvents);
    expect(() =>
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 'bus',
        events: { t: 3 as unknown as string },
      } as unknown as EventsDiagnosticsOptions)
    ).toThrow(EVENT_COLLECTOR_ERRORS.badEvents);
  });

  it('ignores inherited properties of the events map and compiles own entries', () => {
    const events: Record<string, string> = Object.create({ inherited: 'nope' });
    events['user-created'] = 'users';
    const policy = compileEventsDiagnosticsPolicy(
      {
        enabled: true,
        alias: 'bus',
        events,
      } satisfies EventsDiagnosticsOptions,
    );
    expect(policy.aliasByType.get('user-created')).toBe('users');
    expect(policy.aliasByType.has('inherited')).toBe(false);
  });
});

describe('EventObservationCollector (M98j bounded capture)', () => {
  it('answers a deeply frozen disabled snapshot from the inert source', () => {
    const source = createDisabledEventSource();
    const snapshot = source.snapshot();
    expect(snapshot).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
    expectDeeplyFrozen(snapshot);
  });

  it('aggregates observations per (alias, operation) and reports ready', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    const publishAt = observer.begin('users', 'publish');
    clock.advance(2);
    observer.end('users', 'publish', publishAt, true);
    clock.advance(3);
    const firstAt = observer.begin('users', 'handler');
    clock.advance(1);
    observer.end('users', 'handler', firstAt, true);
    clock.advance(1);
    const secondAt = observer.begin('users', 'handler');
    clock.advance(3);
    observer.end('users', 'handler', secondAt, false);
    const snapshot = observer.snapshot();
    expect(snapshot.state).toBe('ready');
    expect(snapshot.alias).toBe('bus');
    expect(snapshot.coverage).toBe('owned-instance');
    const byOperation = Object.fromEntries(
      snapshot.records.map((record) => [record.operation, record]),
    );
    expect(byOperation['publish']).toEqual({
      alias: 'users',
      operation: 'publish',
      count: 1,
      started: 1,
      succeeded: 1,
      failed: 0,
      noSubscribers: 0,
      lastDurationMs: 2,
      ageMs: 8,
    });
    expect(byOperation['handler']).toEqual({
      alias: 'users',
      operation: 'handler',
      count: 2,
      started: 2,
      succeeded: 1,
      failed: 1,
      noSubscribers: 0,
      lastDurationMs: 3,
      ageMs: 0,
    });
    expectDeeplyFrozen(snapshot);
  });

  it('counts a no-subscriber publication as succeeded with noSubscribers', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.observe('users', 'publish', true, 0, true);
    const [record] = observer.snapshot().records;
    expect(record!.noSubscribers).toBe(1);
    expect(record!.succeeded).toBe(1);
    expect(record!.failed).toBe(0);
  });

  it('expires records after 60s without an observation and clears their counters', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.observe('users', 'publish', true, 1);
    clock.advance(EVENT_COLLECTOR_LIMITS.retentionMs + 1);
    const snapshot = observer.snapshot();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.state).toBe('no-data');
  });

  it('reports stale when every retained record is older than 30s', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.observe('users', 'publish', true, 1);
    clock.advance(EVENT_COLLECTOR_LIMITS.staleMs + 1);
    const snapshot = observer.snapshot();
    expect(snapshot.records.length).toBe(1);
    expect(snapshot.state).toBe('stale');
  });

  it('stops capturing after a clock failure and latches collection-failed', () => {
    const throwingRuntime = {
      hrtime: () => {
        throw new Error('clock gone');
      },
    } as unknown as IRuntimeServices;
    const policy = compileEventsDiagnosticsPolicy({
      enabled: true,
      alias: 'bus',
      events: { t: 'alias' },
    });
    const observer = new EventObservationCollector(policy, throwingRuntime);
    observer.observe('alias', 'publish', true, 1);
    const snapshot = observer.snapshot();
    expect(snapshot.state).toBe('collection-failed');
    expect(snapshot.records).toEqual([]);
    expect(snapshot.alias).toBe('bus');
    // A latched source stays failed: no capture resumes.
    observer.observe('alias', 'publish', true, 1);
    expect(observer.snapshot().records).toEqual([]);
  });

  it('ignores every call after close and answers disabled with a null alias', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.observe('users', 'publish', true, 1);
    observer.close();
    observer.observe('users', 'publish', true, 1);
    const snapshot = observer.snapshot();
    expect(snapshot.state).toBe('disabled');
    expect(snapshot.alias).toBeNull();
    expect(snapshot.records).toEqual([]);
  });

  it('drops NEW tuples at the 64-slot capacity and keeps updating existing ones', () => {
    const clock = new MutableClock();
    // 33 aliases x 2 operations = 66 tuples > 64 slots.
    const events: Record<string, string> = {};
    for (let index = 0; index < 33; index++) {
      events[`t${index}`] = `alias${index}`;
    }
    const observer = collector(clock, events);
    for (let index = 0; index < 33; index++) {
      observer.observe(`alias${index}`, 'publish', true, 1);
      observer.observe(`alias${index}`, 'handler', true, 1);
    }
    const snapshot = observer.snapshot();
    expect(snapshot.records.length).toBe(EVENT_COLLECTOR_LIMITS.recordSlots);
    expect(snapshot.dropped).toBe(2);
    // Existing tuples keep updating after the drop.
    const before = snapshot.records.find((record) => record.alias === 'alias0')!.count;
    observer.observe('alias0', 'publish', true, 1);
    const after = observer.snapshot().records.find((record) => record.alias === 'alias0')!.count;
    expect(after).toBe(before + 1);
  });

  it('clamps negative and fractional durations to non-negative integers', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.observe('users', 'publish', true, -5);
    observer.observe('users', 'handler', true, 2.9);
    const records = observer.snapshot().records;
    expect(records.find((record) => record.operation === 'publish')!.lastDurationMs).toBe(0);
    expect(records.find((record) => record.operation === 'handler')!.lastDurationMs).toBe(2);
  });
});

describe('InMemoryEventBus with an attached observer (M98j)', () => {
  it('observes publish entry, each handler await, and exact invocation order', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    const order: string[] = [];
    const unsubscribe = bus.subscribe('user-created', async () => {
      await Promise.resolve();
      clock.advance(1);
      order.push('first');
    });
    bus.subscribe('user-created', async () => {
      await Promise.resolve();
      clock.advance(1);
      order.push('second');
    });
    await bus.publish({
      type: 'user-created',
      id: 'event-1',
      occurredOn: new Date(0),
      data: 'SECRET-PAYLOAD',
    });
    expect(order).toEqual(['first', 'second']);
    const records = observer.snapshot().records;
    const publish = records.find((record) => record.operation === 'publish')!;
    const handler = records.find((record) => record.operation === 'handler')!;
    expect(publish.succeeded).toBe(1);
    expect(handler.count).toBe(2);
    expect(handler.succeeded).toBe(2);
    // Exactly one evaluation per handler: no second dispatch pass.
    expect(order.length).toBe(2);
    unsubscribe();
  });

  it('counts handler rejection on the handler record and keeps errorHandler propagation', async () => {
    const clock = new MutableClock();
    const seen: string[] = [];
    const bus = new InMemoryEventBus({
      async: false,
      errorHandler: (error) => void seen.push(String(error)),
    });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', () => {
      throw new Error('SECRET-ERROR');
    });
    // A sync throw inside the async handler propagates as a rejection; the
    // unobserved dispatch catches it through the SAME path.
    await bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null });
    expect(seen).toEqual(['Error: SECRET-ERROR']);
    const records = observer.snapshot().records;
    expect(records.find((record) => record.operation === 'handler')!.failed).toBe(1);
    expect(records.find((record) => record.operation === 'publish')!.succeeded).toBe(1);
  });

  it('counts a thrown errorHandler as a failed publish and propagates in sync mode', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({
      async: false,
      errorHandler: () => {
        throw new Error('handler-throw');
      },
    });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', () => {
      throw new Error('SECRET-ERROR');
    });
    await expect(
      bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null }),
    ).rejects.toThrow('handler-throw');
    const records = observer.snapshot().records;
    expect(records.find((record) => record.operation === 'publish')!.failed).toBe(1);
  });

  it('observes a no-subscriber publication with noSubscribers and nothing else', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    await bus.publish({
      type: 'user-created',
      id: 'event-1',
      occurredOn: new Date(0),
      data: 'SECRET-PAYLOAD',
    });
    const records = observer.snapshot().records;
    expect(records.length).toBe(1);
    expect(records[0]!.operation).toBe('publish');
    expect(records[0]!.noSubscribers).toBe(1);
  });

  it('resolves async publication before handlers settle; publish record settles with dispatch', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: true, errorHandler: () => {} });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    let done = false;
    bus.subscribe('user-created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      clock.advance(1);
      done = true;
    });
    await bus.publish({
      type: 'user-created',
      id: 'event-1',
      occurredOn: new Date(0),
      data: 'SECRET-PAYLOAD',
    });
    expect(done).toBe(false);
    await bus.whenIdle();
    expect(done).toBe(true);
    const records = observer.snapshot().records;
    expect(records.find((record) => record.operation === 'publish')!.succeeded).toBe(1);
    expect(records.find((record) => record.operation === 'handler')!.succeeded).toBe(1);
  });

  it('publishBatch counts one publish and N handler observations per constituent event', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock, { 'a': 'a-alias', 'b': 'b-alias' });
    attachEventObserver(bus, observer);
    bus.subscribe('a', () => {});
    bus.subscribe('b', () => {});
    await bus.publishBatch([
      { type: 'a', id: 'a-1', occurredOn: new Date(0), data: 'SECRET' },
      { type: 'b', id: 'b-1', occurredOn: new Date(0), data: 'SECRET' },
    ]);
    const records = observer.snapshot().records;
    const aPublish = records.find((record) =>
      record.alias === 'a-alias' && record.operation === 'publish'
    )!;
    const bPublish = records.find((record) =>
      record.alias === 'b-alias' && record.operation === 'publish'
    )!;
    expect(aPublish.count).toBe(1);
    expect(bPublish.count).toBe(1);
    expect(records.filter((record) => record.operation === 'handler').length).toBe(2);
  });

  it('never observes an unapproved event type, not even as dropped', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock, { approved: 'ok' });
    attachEventObserver(bus, observer);
    bus.subscribe('secret-type', () => {});
    await bus.publish({
      type: 'secret-type',
      id: 's-1',
      occurredOn: new Date(0),
      data: 'SECRET-PAYLOAD',
      aggregateId: 'AGG-CANARY',
    });
    const snapshot = observer.snapshot();
    expect(snapshot.records).toEqual([]);
    expect(snapshot.dropped).toBe(0);
  });

  it('keeps an unattached bus unobserved: no collector, no changed behavior', async () => {
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    let calls = 0;
    bus.subscribe('user-created', () => void calls++);
    await bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null });
    expect(calls).toBe(1);
  });

  it('detaching the observer makes later publishes unobserved', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', () => {});
    await bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null });
    attachEventObserver(bus, null);
    await bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null });
    const records = observer.snapshot().records;
    expect(records.find((record) => record.operation === 'publish')!.count).toBe(1);
  });

  it('discards an observation arriving after the collector closed (shutdown race)', async () => {
    const bus = new InMemoryEventBus({ async: true, errorHandler: () => {} });
    const observer = collector(new MutableClock());
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await bus.publish({ type: 'user-created', id: 'event-1', occurredOn: new Date(0), data: null });
    observer.close();
    await bus.whenIdle();
    expect(observer.snapshot().state).toBe('disabled');
  });

  it('never leaks the payload canary into a snapshot', async () => {
    const clock = new MutableClock();
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    const observer = collector(clock);
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', () => {});
    await bus.publish({
      type: 'user-created',
      id: 'event-1',
      occurredOn: new Date(0),
      data: 'PAYLOAD-CANARY-SYNTHETIC',
    });
    expect(JSON.stringify(observer.snapshot()).includes('PAYLOAD-CANARY-SYNTHETIC')).toBe(false);
    expect(JSON.stringify(observer.snapshot()).includes('user-created')).toBe(false);
  });
});

describe('EventsPlugin diagnostics registration (M98j)', () => {
  it('registers an events-diagnostics source as a MULTI provider without claiming the token', async () => {
    const registrations: { key: string; multi: boolean }[] = [];
    const provides: string[] = [];
    const hooks: (() => void)[] = [];
    const ctx = {
      services: {
        has: (_key: string) => false,
        get: <T>(_key: string) => undefined as T,
        register: (key: string, _value: unknown, options?: { multi?: boolean }) => {
          registrations.push({ key, multi: options?.multi === true });
        },
      },
      lifecycle: {
        onInit: (hook: () => void) => void hooks.push(hook),
        onClose: (hook: () => void) => void hooks.push(hook),
      },
      health: { register: () => {} },
      runtime: clockRuntime(new MutableClock()),
      logger: undefined,
    } as unknown as Parameters<ReturnType<typeof EventsPlugin>['register']>[0];
    const plugin = EventsPlugin({
      diagnostics: {
        enabled: true,
        alias: 'bus',
        events: { 'user-created': 'users' },
      },
    });
    provides.push(...(plugin.provides ?? []));
    await plugin.register(ctx);
    const source = registrations.find((entry) => entry.key === CAPABILITIES.EVENTS_DIAGNOSTICS);
    expect(source).toBeDefined();
    expect(source!.multi).toBe(true);
    expect(provides.includes(CAPABILITIES.EVENTS_DIAGNOSTICS)).toBe(false);
  });

  it('registers the inert disabled source when the diagnostics option is absent', async () => {
    let registered: unknown = null;
    const ctx = {
      services: {
        has: (_key: string) => false,
        get: <T>(_key: string) => undefined as T,
        register: (_key: string, value: unknown, _options?: unknown) => {
          if (_key === CAPABILITIES.EVENTS_DIAGNOSTICS) registered = value;
        },
      },
      lifecycle: { onInit: (_hook: () => void) => {}, onClose: (_hook: () => void) => {} },
      health: { register: () => {} },
      runtime: clockRuntime(new MutableClock()),
      logger: undefined,
    } as unknown as Parameters<ReturnType<typeof EventsPlugin>['register']>[0];
    const plugin = EventsPlugin();
    await plugin.register(ctx);
    const source = registered as IEventDiagnosticsSource;
    expect(source.snapshot().state).toBe('disabled');
  });

  it('refuses an invalid diagnostics option at construction, before any application exists', () => {
    expect(() =>
      EventsPlugin({
        diagnostics: {
          enabled: false,
          alias: 'bus',
          events: {},
        } as unknown as EventsDiagnosticsOptions,
      })
    ).toThrow(EVENT_COLLECTOR_ERRORS.notEnabled);
  });
});

/** Counts unhandled rejections while `run` executes, suppressing each. */
async function countUnhandled(run: () => Promise<void>): Promise<number> {
  let unhandled = 0;
  const listener = (event: PromiseRejectionEvent) => {
    unhandled++;
    event.preventDefault();
  };
  globalThis.addEventListener('unhandledrejection', listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.removeEventListener('unhandledrejection', listener);
  }
  return unhandled;
}

const EVENT = { type: 'user-created', id: 'e', occurredOn: new Date(0), data: 'SECRET' };

describe('Observation never changes dispatch (M98j review fixes)', () => {
  it('counts a start before settlement, so an in-flight handler is visible', async () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    const bus = new InMemoryEventBus({ async: true, errorHandler: () => {} });
    attachEventObserver(bus, observer);
    let release!: () => void;
    bus.subscribe('user-created', () => new Promise<void>((resolve) => (release = resolve)));
    await bus.publish(EVENT);
    const inFlight = observer.snapshot().records.find((r) => r.operation === 'handler')!;
    expect(inFlight.started).toBe(1);
    expect(inFlight.count).toBe(0);
    expect(inFlight.lastDurationMs).toBeNull();
    release();
    await bus.whenIdle();
    const settled = observer.snapshot().records.find((r) => r.operation === 'handler')!;
    expect(settled.started).toBe(1);
    expect(settled.count).toBe(1);
  });

  it('expires a never-settled slot after the retention window', () => {
    const clock = new MutableClock();
    const observer = collector(clock);
    observer.begin('users', 'handler');
    clock.advance(60_001);
    expect(observer.snapshot().records).toEqual([]);
  });

  for (const async of [false, true]) {
    it(`a throwing clock changes nothing about dispatch (async: ${async})`, async () => {
      // Two handlers read the clock 1 + 2 times; fail at each of those reads.
      for (let failAt = 1; failAt <= 3; failAt++) {
        let reads = 0;
        const runtime = {
          hrtime: () => {
            reads++;
            if (reads >= failAt) throw new Error('clock gone');
            return reads;
          },
        } as unknown as IRuntimeServices;
        const observer = new EventObservationCollector(
          compileEventsDiagnosticsPolicy({
            enabled: true,
            alias: 'bus',
            events: { 'user-created': 'users' },
          }),
          runtime,
        );
        const seen: unknown[] = [];
        const bus = new InMemoryEventBus({ async, errorHandler: (error) => void seen.push(error) });
        attachEventObserver(bus, observer);
        const ran: string[] = [];
        bus.subscribe('user-created', () => void ran.push('a'));
        bus.subscribe('user-created', () => void ran.push('b'));
        await bus.publish(EVENT);
        await bus.whenIdle();
        expect(ran).toEqual(['a', 'b']);
        expect(seen).toEqual([]);
        expect(observer.snapshot().state).toBe('collection-failed');
      }
    });
  }

  it('a throwing clock never rejects a no-subscriber publish', async () => {
    const runtime = {
      hrtime: () => {
        throw new Error('clock gone');
      },
    } as unknown as IRuntimeServices;
    const observer = new EventObservationCollector(
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 'bus',
        events: { 'user-created': 'users' },
      }),
      runtime,
    );
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    attachEventObserver(bus, observer);
    await bus.publish(EVENT);
    expect(observer.snapshot().state).toBe('collection-failed');
  });

  it('an async errorHandler throw stays unhandled and rejects whenIdle, observed or not', async () => {
    const outcome = async (observed: boolean) => {
      const bus = new InMemoryEventBus({
        async: true,
        errorHandler: () => {
          throw new Error('errorHandler threw');
        },
      });
      const observer = collector(new MutableClock());
      if (observed) attachEventObserver(bus, observer);
      bus.subscribe('user-created', () => {
        throw new Error('handler');
      });
      let idle = 'resolved';
      const unhandled = await countUnhandled(async () => {
        await bus.publish(EVENT);
        await bus.whenIdle().catch(() => (idle = 'rejected'));
      });
      return { unhandled, idle, observer };
    };
    const plain = await outcome(false);
    const observed = await outcome(true);
    expect(observed.idle).toBe(plain.idle);
    expect(observed.idle).toBe('rejected');
    const unobservedOnly = await countUnhandled(async () => {
      const bus = new InMemoryEventBus({
        async: true,
        errorHandler: () => {
          throw new Error('x');
        },
      });
      bus.subscribe('user-created', () => {
        throw new Error('h');
      });
      await bus.publish(EVENT);
    });
    const observedOnly = await countUnhandled(async () => {
      const bus = new InMemoryEventBus({
        async: true,
        errorHandler: () => {
          throw new Error('x');
        },
      });
      attachEventObserver(bus, collector(new MutableClock()));
      bus.subscribe('user-created', () => {
        throw new Error('h');
      });
      await bus.publish(EVENT);
    });
    expect(unobservedOnly).toBe(1);
    expect(observedOnly).toBe(unobservedOnly);
    const publish = observed.observer.snapshot().records.find((r) => r.operation === 'publish')!;
    expect(publish.failed).toBe(1);
  });

  it('unsubscribing during dispatch runs the same handlers observed as unobserved', async () => {
    const run = async (observed: boolean) => {
      const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
      if (observed) attachEventObserver(bus, collector(new MutableClock()));
      const order: string[] = [];
      let dropSecond = () => {};
      bus.subscribe('user-created', () => {
        order.push('first');
        dropSecond();
      });
      dropSecond = bus.subscribe('user-created', () => void order.push('second'));
      bus.subscribe('user-created', () => void order.push('third'));
      await bus.publish(EVENT);
      return order;
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('reaches the 64-slot capacity with a valid policy and counts drops', async () => {
    const events: Record<string, string> = {};
    for (let index = 0; index < 40; index++) events[`t${index}`] = `a${index}`;
    const observer = collector(new MutableClock(), events);
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    attachEventObserver(bus, observer);
    for (let index = 0; index < 40; index++) {
      bus.subscribe(`t${index}`, () => {});
      await bus.publish({ ...EVENT, type: `t${index}` });
    }
    const snapshot = observer.snapshot();
    expect(snapshot.records.length).toBe(64);
    // 40 aliases × 2 operations = 80 tuples; 16 settle-time observations are refused.
    expect(snapshot.dropped).toBe(16);
  });

  it('shutdown with a pending handler discards its late settlement', async () => {
    let closeHook: (() => Promise<void>) | undefined;
    let registered: IEventDiagnosticsSource | undefined;
    let bus: InMemoryEventBus | undefined;
    const ctx = {
      services: {
        has: () => false,
        get: <T>() => undefined as T,
        register: (key: string, value: unknown) => {
          if (key === CAPABILITIES.EVENTS_DIAGNOSTICS) {
            registered = value as IEventDiagnosticsSource;
          }
          if (key === CAPABILITIES.EVENTS) bus = value as InMemoryEventBus;
        },
      },
      lifecycle: {
        onInit: () => {},
        onClose: (hook: () => Promise<void>) => void (closeHook = hook),
      },
      health: { register: () => {} },
      runtime: clockRuntime(new MutableClock()),
      logger: undefined,
    } as unknown as Parameters<ReturnType<typeof EventsPlugin>['register']>[0];
    const plugin = EventsPlugin({
      async: true,
      diagnostics: { enabled: true, alias: 'bus', events: { 'user-created': 'users' } },
    });
    await plugin.register(ctx);
    let release!: () => void;
    bus!.subscribe('user-created', () => new Promise<void>((resolve) => (release = resolve)));
    await bus!.publish(EVENT);
    await closeHook!();
    release();
    await bus!.whenIdle();
    expect(registered!.snapshot()).toEqual({
      state: 'disabled',
      alias: null,
      coverage: 'owned-instance',
      records: [],
      dropped: 0,
    });
  });
});

describe('Clock reads per publication (M98j overhead)', () => {
  it('reads the clock 1 + handlers times, and once for a no-subscriber publish', async () => {
    let reads = 0;
    const runtime = { hrtime: () => ++reads } as unknown as IRuntimeServices;
    const observer = new EventObservationCollector(
      compileEventsDiagnosticsPolicy({
        enabled: true,
        alias: 'bus',
        events: { 'user-created': 'users', idle: 'idle' },
      }),
      runtime,
    );
    const bus = new InMemoryEventBus({ async: false, errorHandler: () => {} });
    attachEventObserver(bus, observer);
    bus.subscribe('user-created', () => {});
    bus.subscribe('user-created', () => {});
    await bus.publish(EVENT);
    expect(reads).toBe(3);
    await bus.publish({ ...EVENT, type: 'idle' });
    expect(reads).toBe(4);
    const handler = observer.snapshot().records.find((r) => r.operation === 'handler')!;
    expect(handler).toMatchObject({ started: 2, count: 2, succeeded: 2 });
  });
});
