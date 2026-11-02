import { it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';
import { canonicalJson, idempotencyKey } from '../../src/call/idempotency-key.ts';
it('sorts nested keys, preserves array order and derives a stable SHA-256 vector', async () => {
  expect(canonicalJson({ b: [{ z: 2, a: 1 }], a: null })).toBe('{"a":null,"b":[{"a":1,"z":2}]}');
  const subtle = webcrypto.subtle as SubtleCrypto;
  expect(await idempotencyKey('read', { b: 2, a: 1 }, subtle)).toBe(
    await idempotencyKey('read', { a: 1, b: 2 }, subtle),
  );
  expect(await idempotencyKey('read', { a: 1 }, subtle)).not.toBe(
    await idempotencyKey('read', { a: 2 }, subtle),
  );
  expect(await idempotencyKey('read', {}, subtle)).toBe(
    'mcp-RRD-k6KpPmiXbIWLbErLpJDkHbHX0iYZtE_jOCq2uUM',
  );
});
