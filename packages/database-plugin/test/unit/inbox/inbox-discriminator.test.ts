/**
 * The discriminator rule (M108 §3.5): business rows sharing the inbox's
 * entity, carrying inbox-looking statuses, are never found, listed, counted,
 * released or purged.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  allRows,
  idsFor,
  marker,
  memoryService,
  seed,
  storeOver,
} from '../../fixtures/inbox-store.ts';

/** A business row shaped like an inbox row in every column but `kind`. */
function business(label: string, status: string): Record<string, unknown> {
  return {
    ...marker(label),
    kind: 'business',
    status,
    updatedAt: 1,
    envelopeId: null,
    lastError: null,
    envelope: '{"secret":true}',
  };
}

describe('inbox discriminator', () => {
  it('ignores business rows on every read and every write path', async () => {
    const service = await memoryService();
    await seed(service, [
      business('p', 'parked'),
      business('q', 'processed'),
      business('r', 'attempting'),
    ]);
    const store = storeOver(service);

    expect(await store.find(idsFor('p').marker)).toBeUndefined();
    expect(await store.parked(10)).toEqual([]);
    expect(await store.stats()).toEqual({ parked: 0 });
    expect(await store.release(idsFor('p'), 'retry', 5)).toEqual({ outcome: 'missing' });
    expect(await store.release(idsFor('p'), 'discard', 5)).toEqual({ outcome: 'missing' });
    expect(await store.purge(Number.MAX_SAFE_INTEGER, 100)).toBe(0);

    expect(await allRows(service)).toHaveLength(3);
  });
});
