/**
 * The inbox row mapping (M108 §3.5): what a record is written as and what a
 * stored row reads back as.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { allRows, idsFor, marker, memoryService, storeOver } from '../../fixtures/inbox-store.ts';

describe('inbox row mapping', () => {
  it('writes every optional column as null and reads it back as absent', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await store.run(marker('a'), () => Promise.resolve());

    const [row] = await allRows(service);
    expect(row).toMatchObject({
      kind: 'setu-inbox',
      envelopeId: null,
      lastError: null,
      envelope: null,
    });
    const read = await store.find(idsFor('a').marker);
    expect(read).toEqual(marker('a'));
    expect(read && 'envelope' in read).toBe(false);
  });

  it('round-trips every optional field when present', async () => {
    const store = storeOver(await memoryService());
    const parked = marker('b', {
      status: 'parked',
      envelopeId: 'e-1',
      lastError: 'boom',
      envelope: '{"id":"e-1"}',
    });
    await store.park(parked);
    expect(await store.find(parked.id)).toEqual(parked);
  });

  it('drops an adapter column the record does not declare', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    await service.getRepository('Inbox').create({
      ...marker('c'),
      envelopeId: null,
      lastError: null,
      envelope: null,
      systemColumn: 'x',
    });
    expect(await store.find(idsFor('c').marker)).toEqual(marker('c'));
  });
});
