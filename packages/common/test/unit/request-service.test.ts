/**
 * Request-bound services (M130 §3.1): one instance per request and token,
 * shared within a request and never across requests, with or without
 * `ctx.slot`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import type { IRequestContext, IServiceRegistry } from '../../src/index.ts';
import {
  RequestServiceUnavailableError,
  requestService,
  resolveRequestService,
  serviceToken,
} from '../../src/index.ts';

interface Counter {
  readonly id: number;
  readonly principal: string;
}

function registry(entries: Record<string, object>): IServiceRegistry {
  return {
    register: () => {},
    registerFactory: () => {},
    get: <T extends object>(token: string) => {
      const value = entries[token];
      if (value === undefined) throw new Error(`No service registered for capability '${token}'`);
      return value as T;
    },
    getAll: () => [],
    has: (token) => token in entries,
    unregister: () => false,
  };
}

/** A context honoring the kernel's `slot` contract (a throwing factory stores nothing). */
function contextWithSlot(services: IServiceRegistry, principal = 'p'): IRequestContext {
  const slots = new Map<object, unknown>();
  return {
    services,
    state: new Map([['principal', principal]]),
    slot<T>(key: object, create: () => T): T {
      if (slots.has(key)) return slots.get(key) as T;
      const value = create();
      slots.set(key, value);
      return value;
    },
  } as unknown as IRequestContext;
}

function contextWithoutSlot(services: IServiceRegistry, principal = 'p'): IRequestContext {
  return { services, state: new Map([['principal', principal]]) } as unknown as IRequestContext;
}

const COUNTER = serviceToken<Counter>('module.counter');

function counterEntries(): { entries: Record<string, object>; calls: () => number } {
  let n = 0;
  const entry = requestService<Counter>((ctx) => ({
    id: ++n,
    principal: String(ctx.state.get('principal')),
  }));
  return { entries: { [COUNTER]: entry }, calls: () => n };
}

describe('serviceToken', () => {
  it('returns the validated name', () => {
    expect(serviceToken('module.products')).toBe('module.products');
  });

  it.each(['Bad:Name', 'module:products', 'Module.products', ''])('refuses %j', (name) => {
    expect(() => serviceToken(name)).toThrow(TypeError);
  });
});

describe('requestService', () => {
  it('returns a frozen entry holding the factory', () => {
    const create = (): object => ({});
    const entry = requestService(create);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.create).toBe(create);
    expect((entry as unknown as Record<symbol, unknown>)[Symbol.for('setu.request-service')]).toBe(
      true,
    );
  });
});

describe('resolveRequestService', () => {
  for (const [label, make] of [
    ['with slot', contextWithSlot],
    ['without slot', contextWithoutSlot],
  ] as const) {
    describe(label, () => {
      it('runs the factory once per request across two calls', () => {
        const { entries, calls } = counterEntries();
        const ctx = make(registry(entries));
        const first = resolveRequestService(ctx, COUNTER);
        const second = resolveRequestService(ctx, COUNTER);
        expect(second).toBe(first);
        expect(calls()).toBe(1);
      });

      it('gives two requests two instances', () => {
        const { entries, calls } = counterEntries();
        const services = registry(entries);
        const a = resolveRequestService(make(services, 'alice'), COUNTER);
        const b = resolveRequestService(make(services, 'bob'), COUNTER);
        expect(a).not.toBe(b);
        expect([a.principal, b.principal]).toEqual(['alice', 'bob']);
        expect(calls()).toBe(2);
      });

      it('does not cache a throwing factory, so the next call retries', () => {
        let attempts = 0;
        const entry = requestService<Counter>(() => {
          attempts += 1;
          if (attempts === 1) throw new Error('boom');
          return { id: attempts, principal: 'p' };
        });
        const ctx = make(registry({ [COUNTER]: entry }));
        expect(() => resolveRequestService(ctx, COUNTER)).toThrow('boom');
        expect(resolveRequestService(ctx, COUNTER).id).toBe(2);
        expect(resolveRequestService(ctx, COUNTER).id).toBe(2);
      });

      it('refuses a factory returning a non-object, naming the token', () => {
        const nullEntry = requestService(() => null as unknown as object);
        const numberEntry = requestService(() => 7 as unknown as object);
        const ctx = make(registry({ 'module.a': nullEntry, 'module.b': numberEntry }));
        expect(() => resolveRequestService(ctx, 'module.a')).toThrow(/'module\.a' returned null/);
        expect(() => resolveRequestService(ctx, 'module.b')).toThrow(TypeError);
        expect(() => resolveRequestService(ctx, 'module.b')).toThrow(/returned number/);
      });
    });
  }

  it('returns a plain entry as registered', () => {
    const logger = { info: () => {} };
    const ctx = contextWithSlot(registry({ logger }));
    expect(resolveRequestService(ctx, 'logger')).toBe(logger);
  });

  it('treats an unbranded object of the same shape as a plain entry', () => {
    const lookalike = { create: () => ({ id: 1 }) };
    const ctx = contextWithoutSlot(registry({ 'module.x': lookalike }));
    expect(resolveRequestService(ctx, 'module.x')).toBe(lookalike);
  });

  it('throws RequestServiceUnavailableError naming a missing token', () => {
    const ctx = contextWithSlot(registry({}));
    let caught: unknown;
    try {
      resolveRequestService(ctx, COUNTER);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestServiceUnavailableError);
    const error = caught as RequestServiceUnavailableError;
    expect(error.name).toBe('RequestServiceUnavailableError');
    expect(error.token).toBe('module.counter');
    expect(error.message).toContain("'module.counter'");
  });

  it('keeps distinct tokens apart within one request', () => {
    const a = requestService(() => ({ k: 'a' }));
    const b = requestService(() => ({ k: 'b' }));
    const ctx = contextWithSlot(registry({ 'module.a': a, 'module.b': b }));
    expect(resolveRequestService<{ k: string }>(ctx, 'module.a').k).toBe('a');
    expect(resolveRequestService<{ k: string }>(ctx, 'module.b').k).toBe('b');
  });

  it('never shares an instance between 50 interleaved concurrent requests', async () => {
    const { entries } = counterEntries();
    const services = registry(entries);
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const ctx =
          i % 2 === 0 ? contextWithSlot(services, `u${i}`) : contextWithoutSlot(services, `u${i}`);
        const first = resolveRequestService(ctx, COUNTER);
        await new Promise((resolve) => setTimeout(resolve, (i * 7) % 5));
        const second = resolveRequestService(ctx, COUNTER);
        return { i, first, second };
      }),
    );
    const ids = new Set<number>();
    for (const { i, first, second } of results) {
      expect(second).toBe(first);
      expect(first.principal).toBe(`u${i}`);
      ids.add(first.id);
    }
    expect(ids.size).toBe(50);
  });
});
