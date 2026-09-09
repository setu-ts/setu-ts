/**
 * Tests for {@linkcode serializeError} (M70f, X2-5).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { type SerializedError, serializeError } from '../../src/errors/serialize-error.ts';

describe('serializeError', () => {
  it('serializes a plain Error to { name, message, stack? }', () => {
    const err = new Error('boom');
    const out = serializeError(err);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('boom');
    expect(typeof out.stack).toBe('string');
    expect(out.cause).toBeUndefined();
  });

  it('serializes a named error preserving its name', () => {
    class Custom extends Error {
      constructor() {
        super('custom');
        this.name = 'Custom';
      }
    }
    const out = serializeError(new Custom());
    expect(out.name).toBe('Custom');
    expect(out.message).toBe('custom');
  });

  it('keeps only safe scalar driver classifiers', () => {
    const error = new Error('transaction failed') as Error & {
      code?: unknown;
      severity?: unknown;
      constraint?: unknown;
      query?: unknown;
      parameters?: unknown;
    };
    error.code = '40001';
    error.severity = 'ERROR';
    error.constraint = 'orders_customer_id_fkey';
    error.query = 'SELECT * FROM users WHERE password = $1';
    error.parameters = ['secret'];

    expect(serializeError(error).classifiers).toEqual({
      code: '40001',
      severity: 'ERROR',
      constraint: 'orders_customer_id_fkey',
    });
  });

  it('drops object-valued classifiers and truncates long strings by Unicode code point', () => {
    const error = new Error('driver failed') as Error & { code?: unknown; errno?: unknown };
    error.code = { query: 'secret' };
    error.errno = `${'😀'.repeat(513)}suffix`;

    const out = serializeError(error);
    expect(out.classifiers?.code).toBeUndefined();
    expect(out.classifiers?.errno).toBe(`${'😀'.repeat(512)}… [truncated]`);
  });

  it('serializes bounded AggregateError members and reports omitted entries', () => {
    const aggregate = new AggregateError(
      Array.from({ length: 10 }, (_, index) => new Error(`member-${index}`)),
    );

    const out = serializeError(aggregate);
    expect(out.errors).toHaveLength(8);
    expect(out.errors?.[0]?.message).toBe('member-0');
    expect(out.errors?.[7]?.message).toBe('member-7');
    expect(out.omittedErrorCount).toBe(2);
  });

  it('caps nested aggregate trees with a shared total-node budget', () => {
    const nested = (depth: number): AggregateError =>
      new AggregateError(
        Array.from({ length: 8 }, () => depth === 0 ? new Error('leaf') : nested(depth - 1)),
      );

    const count = (error: SerializedError): number =>
      1 + (error.errors?.reduce((total, member) => total + count(member), 0) ?? 0);

    const out = serializeError(nested(4));
    expect(count(out)).toBeLessThanOrEqual(64);
    expect(out.omittedErrorCount).toBeGreaterThan(0);
  });

  it('follows the cause chain recursively', () => {
    const root = new Error('root');
    const mid = new Error('mid', { cause: root });
    const top = new Error('top', { cause: mid });
    const out = serializeError(top);
    expect(out.message).toBe('top');
    expect(out.cause?.message).toBe('mid');
    expect(out.cause?.cause?.message).toBe('root');
    expect(out.cause?.cause?.cause).toBeUndefined();
  });

  it('serializes a non-Error cause to a message-only entry', () => {
    const err = new Error('outer', { cause: 'a string cause' });
    const out = serializeError(err);
    expect(out.cause?.name).toBe('Error');
    expect(out.cause?.message).toBe('a string cause');
    expect(out.cause?.stack).toBeUndefined();
  });

  it('terminates a self-referential cause at the bound', () => {
    const err = new Error('cyclic');
    // A self-referential cause: the cause points back at the error itself.
    (err as { cause?: unknown }).cause = err;
    const out = serializeError(err);
    // Must terminate and produce a bounded chain.
    expect(out.message).toBe('cyclic');
    expect(out.cause).toBeDefined();
    // Walk the chain — it must terminate within the bound.
    let depth = 0;
    let node: SerializedError | undefined = out;
    while (node !== undefined) {
      node = node.cause;
      depth++;
      if (depth > 100) {
        throw new Error('chain did not terminate');
      }
    }
    expect(depth).toBeLessThanOrEqual(11);
  });

  it('serializes a string input to { name, message }', () => {
    const out = serializeError('just a string');
    expect(out.name).toBe('Error');
    expect(out.message).toBe('just a string');
    expect(out.stack).toBeUndefined();
    expect(out.cause).toBeUndefined();
  });

  it('serializes a null input', () => {
    const out = serializeError(null);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('null');
  });

  it('serializes an object input via String()', () => {
    const out = serializeError({ a: 1 });
    expect(out.name).toBe('Error');
    expect(out.message).toBe('[object Object]');
  });
});

describe('serializeError never throws (code review, CodeRabbit)', () => {
  // A serializer on a logging path must never replace the error it was asked to
  // describe with a failure of its own. `String(value)` throws for a value with
  // no path to a primitive, and both shapes below are legal thrown values and
  // legal `Error` causes.
  const hostile: [string, unknown][] = [
    ['a null-prototype object', Object.create(null)],
    ['an object whose toString throws', {
      toString() {
        throw new Error('nope');
      },
    }],
  ];

  for (const [label, value] of hostile) {
    it(`describes ${label} instead of throwing`, () => {
      const out = serializeError(value);
      expect(out.name).toBe('Error');
      expect(typeof out.message).toBe('string');
      expect(out.message.length).toBeGreaterThan(0);
    });

    it(`describes ${label} as an Error cause instead of throwing`, () => {
      const out = serializeError(new Error('outer', { cause: value }));
      expect(out.message).toBe('outer');
      expect(typeof out.cause?.message).toBe('string');
    });
  }

  it('describes a revoked Proxy as a top-level value instead of throwing', () => {
    // A revoked `Proxy` throws from EVERY internal method — so `instanceof`,
    // `String()` and even `Object.prototype.toString` all reject. Nothing is
    // left to report but the fact itself.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const out = serializeError(proxy);
    expect(out.name).toBe('Error');
    expect(out.message).toBe('[unstringifiable value]');
  });

  it('describes a revoked Proxy as an Error cause instead of throwing', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const out = serializeError(new Error('outer', { cause: proxy }));
    expect(out.message).toBe('outer');
    expect(out.cause?.message).toBe('[unstringifiable value]');
  });

  it('describes a Proxy-wrapped Error whose get trap throws', () => {
    // The target IS a real Error, so `getPrototypeOf` succeeds and the value
    // passes `instanceof Error` — then every member read rejects. Proxy-wrapped
    // entities are ordinary in ORMs, DI containers and mocking libraries.
    const hostile = new Proxy(new Error('inner'), {
      get() {
        throw new Error('property access failed');
      },
    });

    const out = serializeError(hostile);
    expect(out.name).toBe('Error');
    expect(typeof out.message).toBe('string');
  });

  it('keeps the readable members when only one accessor is hostile', () => {
    // A per-member guard costs one field, not the whole report.
    const partial = new Error('readable message');
    Object.defineProperty(partial, 'stack', {
      get() {
        throw new Error('stack access failed');
      },
    });

    const out = serializeError(partial);
    expect(out.message).toBe('readable message');
    expect(out.name).toBe('Error');
    expect(out.stack).toBeUndefined();
  });

  it('keeps readable classifiers when one classifier accessor is hostile', () => {
    const partial = new Error('readable message') as Error & {
      code?: unknown;
      severity?: unknown;
    };
    partial.code = '40001';
    Object.defineProperty(partial, 'severity', {
      get() {
        throw new Error('severity access failed');
      },
    });

    expect(serializeError(partial).classifiers).toEqual({ code: '40001' });
  });

  it('stringifies a symbol rather than treating it as hostile', () => {
    // `String(Symbol('x'))` is specified to return 'Symbol(x)', NOT to throw —
    // unlike `'' + sym`. Pinned so the guard above is never justified by a
    // claim that is not true.
    expect(serializeError(Symbol('boom')).message).toBe('Symbol(boom)');
  });
});
