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

  it('stringifies a symbol rather than treating it as hostile', () => {
    // `String(Symbol('x'))` is specified to return 'Symbol(x)', NOT to throw —
    // unlike `'' + sym`. Pinned so the guard above is never justified by a
    // claim that is not true.
    expect(serializeError(Symbol('boom')).message).toBe('Symbol(boom)');
  });
});
