/**
 * Inbox row ids (M108 §3.5): fixed length and alphabet whatever the producer
 * sent, injective over separator-bearing pairs, and an attempts id that never
 * equals a marker id.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveInboxIds, idsFromMarker, isMarkerId } from '../../../src/inbox/inbox-key.ts';

const subtle = crypto.subtle;

describe('inbox row ids', () => {
  it('a marker id is 64 lowercase hex characters and its attempts id adds a suffix', async () => {
    const ids = await deriveInboxIds(subtle, 'payroll', 'e-1');
    expect(ids.marker).toMatch(/^[0-9a-f]{64}$/);
    expect(ids.attempts).toBe(`${ids.marker}.attempts`);
    expect(isMarkerId(ids.marker)).toBe(true);
    expect(isMarkerId(ids.attempts)).toBe(false);
  });

  it('is deterministic, and differs per consumer and per envelope id', async () => {
    const a = await deriveInboxIds(subtle, 'payroll', 'e-1');
    expect(await deriveInboxIds(subtle, 'payroll', 'e-1')).toEqual(a);
    expect((await deriveInboxIds(subtle, 'billing', 'e-1')).marker).not.toBe(a.marker);
    expect((await deriveInboxIds(subtle, 'payroll', 'e-2')).marker).not.toBe(a.marker);
  });

  it('keeps separator-bearing pairs apart', async () => {
    const pairs: [string, string][] = [
      ['a|b', 'c'],
      ['a', 'b|c'],
      ['a","b', 'c'],
      ['a', '","b'],
      ['a\\', '"b'],
    ];
    const markers = new Set<string>();
    for (const [consumer, id] of pairs) {
      markers.add((await deriveInboxIds(subtle, consumer, id)).marker);
    }
    expect(markers.size).toBe(pairs.length);
  });

  it('keys an oversized id, and an id carrying control and forbidden characters', async () => {
    for (const id of ['x'.repeat(10_240), 'a\u0000b‮c"\\/?#', ' padded ']) {
      expect(isMarkerId((await deriveInboxIds(subtle, 'payroll', id)).marker)).toBe(true);
    }
  });

  it('an ill-formed id keys as its well-formed replacement', async () => {
    expect((await deriveInboxIds(subtle, 'c', 'a\ud800')).marker)
      .toBe((await deriveInboxIds(subtle, 'c', 'a�')).marker);
  });

  it('idsFromMarker and isMarkerId', () => {
    const marker = 'f'.repeat(64);
    expect(idsFromMarker(marker)).toEqual({ marker, attempts: `${marker}.attempts` });
    for (const bad of ['F'.repeat(64), 'f'.repeat(63), 7, undefined, `${marker}.attempts`]) {
      expect(isMarkerId(bad)).toBe(false);
    }
  });
});
