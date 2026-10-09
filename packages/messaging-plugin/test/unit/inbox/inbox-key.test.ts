/**
 * Inbox row ids (M108 §3.5): fixed length and alphabet whatever the producer
 * sent, injective over separator-bearing triples, distinct per topic, and an attempts id that never
 * equals a marker id.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  defaultInboxQueue,
  deriveInboxIds,
  idsFromMarker,
  isMarkerId,
} from '../../../src/inbox/inbox-key.ts';

const subtle = crypto.subtle;

describe('inbox row ids', () => {
  it('a marker id is 64 lowercase hex characters and its attempts id adds a suffix', async () => {
    const ids = await deriveInboxIds(subtle, 'payroll', 't', 'e-1');
    expect(ids.marker).toMatch(/^[0-9a-f]{64}$/);
    expect(ids.attempts).toBe(`${ids.marker}.attempts`);
    expect(isMarkerId(ids.marker)).toBe(true);
    expect(isMarkerId(ids.attempts)).toBe(false);
  });

  it('is deterministic, and differs per consumer, per topic and per envelope id', async () => {
    const a = await deriveInboxIds(subtle, 'payroll', 't', 'e-1');
    expect(await deriveInboxIds(subtle, 'payroll', 't', 'e-1')).toEqual(a);
    expect((await deriveInboxIds(subtle, 'billing', 't', 'e-1')).marker).not.toBe(a.marker);
    expect((await deriveInboxIds(subtle, 'payroll', 't', 'e-2')).marker).not.toBe(a.marker);
    // The audit finding: one consumer reading two topics must not let topic
    // B's event with topic A's id suppress topic A's event.
    expect((await deriveInboxIds(subtle, 'payroll', 'u', 'e-1')).marker).not.toBe(a.marker);
  });

  it('keeps separator-bearing triples apart', async () => {
    const triples: [string, string, string][] = [
      ['a|b', 't', 'c'],
      ['a', 't', 'b|c'],
      ['a","b', 't', 'c'],
      ['a', 't', '","b'],
      ['a\\', 't', '"b'],
      ['a', 'b|t', 'c'],
      ['a|b', 't', 'c|d'],
      ['a', 'b","t', 'c'],
    ];
    const markers = new Set<string>();
    for (const [consumer, topic, id] of triples) {
      markers.add((await deriveInboxIds(subtle, consumer, topic, id)).marker);
    }
    expect(markers.size).toBe(triples.length);
  });

  it('keys an oversized id, and an id carrying control and forbidden characters', async () => {
    for (const id of ['x'.repeat(10_240), 'a\u0000b‮c"\\/?#', ' padded ']) {
      expect(isMarkerId((await deriveInboxIds(subtle, 'payroll', 't', id)).marker)).toBe(true);
    }
  });

  it('an ill-formed id keys as its well-formed replacement', async () => {
    expect((await deriveInboxIds(subtle, 'c', 't', 'a\ud800')).marker)
      .toBe((await deriveInboxIds(subtle, 'c', 't', 'a�')).marker);
  });

  it('a default queue is inbox. plus 16 hex characters, legal on every broker', () => {
    for (const topic of ['people.hired.v1', 'projects/p/topics/x.v1', 'a b/c:d']) {
      expect(defaultInboxQueue('payroll', topic)).toMatch(/^inbox\.[0-9a-f]{16}$/);
    }
    expect(defaultInboxQueue('payroll', 'people.hired.v1')).toBe('inbox.ceb43f8aaeee103e');
  });

  it('a default queue keeps pairs apart that a joined name would merge', () => {
    // `a.b` + `c.v1` and `a` + `b.c.v1` both join to `a.b.c.v1`.
    const pairs: [string, string][] = [
      ['a.b', 'c.v1'],
      ['a', 'b.c.v1'],
      ['a', 'b'],
      ['b', 'a'],
      ['a","b', 'c'],
      ['a', '","b'],
    ];
    const queues = new Set(pairs.map(([consumer, topic]) => defaultInboxQueue(consumer, topic)));
    expect(queues.size).toBe(pairs.length);
  });

  it('idsFromMarker and isMarkerId', () => {
    const marker = 'f'.repeat(64);
    expect(idsFromMarker(marker)).toEqual({ marker, attempts: `${marker}.attempts` });
    for (const bad of ['F'.repeat(64), 'f'.repeat(63), 7, undefined, `${marker}.attempts`]) {
      expect(isMarkerId(bad)).toBe(false);
    }
  });
});
