/**
 * The inbox port's contract (M108 §3.1, §3.5, §3.10). The `IUnitOfWork`
 * scope the database bridge hands a handler is asserted in
 * `database-plugin`, which owns `IUnitOfWork`; `common` imports no plugin,
 * even in tests.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CAPABILITIES,
  createCapabilityToken,
  type IInboxStore,
  INBOX_RECORD_KIND,
  type InboxRecord,
  type InboxReleaseOutcome,
} from '../../src/index.ts';

const marker: InboxRecord = {
  id: 'a'.repeat(64),
  kind: INBOX_RECORD_KIND,
  consumer: 'payroll',
  topic: 'people.hired.v1',
  status: 'processed',
  attempts: 0,
  updatedAt: 0,
};

describe('inbox port contract', () => {
  it('the INBOX token passes the capability-token grammar, as does a named instance', () => {
    expect(createCapabilityToken(CAPABILITIES.INBOX)).toBe('inbox');
    expect(createCapabilityToken(`${CAPABILITIES.INBOX}.billing`)).toBe('inbox.billing');
  });

  it('a record carries the discriminator as its literal type', () => {
    // @ts-expect-error — any other kind is a compile error.
    const wrong: InboxRecord = { ...marker, kind: 'business' };
    expect(marker.kind).toBe('setu-inbox');
    expect(wrong.kind).toBe('business');
  });

  it('a not-parked release cannot report parked', () => {
    const done: InboxReleaseOutcome = { outcome: 'not-parked', status: 'processed' };
    // @ts-expect-error — `parked` is the expected status, never the reported one.
    const bad: InboxReleaseOutcome = { outcome: 'not-parked', status: 'parked' };
    expect([done.outcome, bad.outcome]).toEqual(['not-parked', 'not-parked']);
  });

  it('a minimal store implements the port, every method returning a promise', async () => {
    const store: IInboxStore = {
      find: () => Promise.resolve(undefined),
      run: (_marker, work) => work({}),
      recordFailure: () => Promise.resolve(1),
      park: () => Promise.resolve('applied'),
      parked: () => Promise.resolve([]),
      release: () => Promise.resolve({ outcome: 'missing' }),
      stats: () => Promise.resolve({ parked: 0 }),
      purge: () => Promise.resolve(0),
      verify: () => Promise.resolve(),
    };
    expect(await store.run(marker, () => Promise.resolve(7))).toBe(7);
    expect(await store.find(marker.id)).toBeUndefined();
  });
});
