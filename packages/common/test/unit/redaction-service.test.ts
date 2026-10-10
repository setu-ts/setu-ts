/** Tests for the common clone-on-write redaction service. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMaskRedactor, createRedactionService } from '../../src/index.ts';
import type { RedactionContext, Redactor } from '../../src/index.ts';
import { createFieldMatcher } from '../../src/redaction/field-matcher.ts';

describe('createRedactionService', () => {
  it('redacts literal, wildcard, and array paths without mutating input', () => {
    const service = createRedactionService({
      fields: { 'auth.token': 'secret', 'users.*.email': 'pii' },
    });
    const source = {
      auth: { token: 'keep-me', role: 'admin' },
      users: [{ email: 'one@example.com' }],
    };

    expect(service.redactRecord(source)).toEqual({
      auth: { token: '[Redacted]', role: 'admin' },
      users: [{ email: '[Redacted]' }],
    });
    expect(source.auth.token).toBe('keep-me');
    expect(source.users[0]?.email).toBe('one@example.com');
  });

  it('matches policy fields case-insensitively and supplies redactor context', () => {
    let context: { path: string; classification: string } | undefined;
    const service = createRedactionService({
      fields: { apiKey: 'secret' },
      defaultRedactor: (_value, received) => {
        context = received;
        return 'safe';
      },
    });

    expect(service.redactValue('APIKEY', 'key')).toBe('safe');
    expect(context).toEqual({ path: 'APIKEY', classification: 'secret' });
  });

  it('masks strings, erases non-strings, and preserves unmatched identity', () => {
    const nested = { retained: true };
    const service = createRedactionService({
      fields: { card: 'pci', count: 'pci' },
      redactors: { pci: createMaskRedactor({ keep: 4 }) },
    });
    const result = service.redactRecord({ card: '12345678', count: 4, nested });

    expect(result).toEqual({ card: '****5678', count: '[Redacted]', nested });
    expect(result.nested).toBe(nested);
    expect(service.redactValue('other', 'unchanged')).toBe('unchanged');
  });

  it('matches double-star patterns at every depth, including the top level', () => {
    const service = createRedactionService({ fields: { '**.token': 'secret' } });

    expect(service.redactRecord({ token: 'top', nested: { token: 'deep' } })).toEqual({
      token: '[Redacted]',
      nested: { token: '[Redacted]' },
    });
  });

  it('matches pathological globstar patterns without changing their result', () => {
    const matcher = createFieldMatcher(
      { '**.data.**.data.**.data.**.missing': 'secret' },
      true,
    );

    expect(matcher(Array.from({ length: 32 }, () => 'data').join('.'))).toBeUndefined();
  });

  it('selects the most specific matching field pattern', () => {
    const service = createRedactionService({
      fields: { '**': 'pii', 'auth.token': 'secret' },
      redactors: { pii: () => 'broad', secret: () => 'specific' },
    });

    expect(service.redactValue('auth.token', 'value')).toBe('specific');
    expect(service.redactValue('profile.email', 'value')).toBe('broad');
  });

  it('uses only own redactor entries for application-defined classifications', () => {
    const fallback = () => 'fallback';
    const inherited = createRedactionService({
      fields: { constructor: 'constructor', prototype: '__proto__' },
      redactors: { custom: () => 'not-selected' },
      defaultRedactor: fallback,
    });
    const redactors: Record<string, Redactor> = Object.create(null);
    Object.defineProperty(redactors, '__proto__', { value: () => 'custom', enumerable: true });
    const custom = createRedactionService({
      fields: { value: '__proto__' },
      redactors,
      defaultRedactor: fallback,
    });

    expect(inherited.redactValue('constructor', 'secret')).toBe('fallback');
    expect(inherited.redactValue('prototype', 'secret')).toBe('fallback');
    expect(custom.redactValue('value', 'secret')).toBe('custom');
  });

  it('erases short strings and applies the default mask suffix', () => {
    expect(createMaskRedactor({ keep: 4 })('ab', { path: 'p', classification: 'pci' })).toBe(
      '[Redacted]',
    );
    expect(createMaskRedactor()('12345678', { path: 'p', classification: 'pci' })).toBe('****5678');
  });

  it('fails closed when a mask suffix is not a non-negative safe integer', () => {
    for (const keep of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        createMaskRedactor({ keep })('12345678', { path: 'card', classification: 'pci' }),
      ).toBe('[Redacted]');
    }
  });

  it('preserves cycle topology while failing closed for deep subtrees', () => {
    const date = new Date(0);
    const cycle: Record<string, unknown> = { date, token: 'secret' };
    cycle.self = cycle;
    const service = createRedactionService({ fields: { token: 'secret' } });

    const result = service.redactRecord(cycle) as Record<string, unknown>;
    expect(result).not.toBe(cycle);
    expect(result.date).toBe(date);
    expect(result.token).toBe('[Redacted]');
    expect(result.self).toBe(result);

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 32; index++) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    cursor.token = 'secret';

    let redactedCursor = service.redactRecord(deep) as Record<string, unknown>;
    for (let index = 0; index < 31; index++) {
      redactedCursor = redactedCursor.child as Record<string, unknown>;
    }
    expect(redactedCursor.child).toBe('[Redacted]');
  });

  it('applies a per-field redactor next to a class redactor in one policy (V8-30)', () => {
    const service = createRedactionService({
      fields: {
        'user.email': { classification: 'pii', redactor: createMaskRedactor({ keep: 4 }) },
        'user.name': { classification: 'pii' },
      },
      redactors: { pii: () => 'class-level' },
      defaultRedactor: () => 'default-level',
    });

    expect(
      service.redactRecord({ user: { email: 'jane@example.com', name: 'Jane' } }),
    ).toEqual({ user: { email: '************.com', name: 'class-level' } });
  });

  it('selects redactors by the documented precedence (field, class, default, erase)', () => {
    const field = (): string => 'field';
    const byClass = (): string => 'class';
    const byDefault = (): string => 'default';
    const withDefault = createRedactionService({
      fields: {
        'a.field': { classification: 'pii', redactor: field },
        'a.class': { classification: 'pii' },
        'a.default': { classification: 'other' },
      },
      redactors: { pii: byClass },
      defaultRedactor: byDefault,
    });

    expect(withDefault.redactValue('a.field', 'value')).toBe('field');
    expect(withDefault.redactValue('a.class', 'value')).toBe('class');
    expect(withDefault.redactValue('a.default', 'value')).toBe('default');

    const erased = createRedactionService({
      fields: { 'a.erase': { classification: 'other' } },
    });
    expect(erased.redactValue('a.erase', 'value')).toBe('[Redacted]');
  });

  it('reports the matched classification to a per-field redactor', () => {
    let context: RedactionContext | undefined;
    const service = createRedactionService({
      fields: {
        'user.email': {
          classification: 'pii',
          redactor: (_value, received) => {
            context = received;
            return 'safe';
          },
        },
      },
    });

    expect(service.redactValue('user.email', 'value')).toBe('safe');
    expect(context).toEqual({ path: 'user.email', classification: 'pii' });
  });

  it('agrees between redactRecord and redactValue for object-arm fields', () => {
    const service = createRedactionService({
      fields: { email: { classification: 'pii', redactor: createMaskRedactor({ keep: 4 }) } },
    });

    expect(service.redactValue('email', 'abcd1234')).toBe('****1234');
    expect(service.redactRecord({ email: 'abcd1234' })).toEqual({ email: '****1234' });
  });

  it('keeps specificity ordering across string and object field forms', () => {
    const service = createRedactionService({
      fields: {
        '**': 'pii',
        'auth.token': { classification: 'secret', redactor: () => 'specific' },
      },
      redactors: { pii: () => 'broad' },
    });

    expect(service.redactValue('auth.token', 'value')).toBe('specific');
    expect(service.redactValue('profile.email', 'value')).toBe('broad');
  });
});
