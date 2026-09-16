/** Tests for the common clone-on-write redaction service. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createMaskRedactor, createRedactionService } from '../../src/index.ts';

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

  it('fails closed when a mask suffix is not a non-negative safe integer', () => {
    for (const keep of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        createMaskRedactor({ keep })('12345678', { path: 'card', classification: 'pci' }),
      ).toBe('[Redacted]');
    }
  });

  it('does not descend into non-plain objects or cycles', () => {
    const date = new Date(0);
    const cycle: Record<string, unknown> = { date };
    cycle.self = cycle;
    const service = createRedactionService({ fields: { missing: 'secret' } });

    const result = service.redactRecord(cycle);
    expect(result).toBe(cycle);
    expect(result.date).toBe(date);
  });
});
