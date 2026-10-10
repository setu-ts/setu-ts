/**
 * The outbox port's contract (M107 §3.1–§3.3). The `IUnitOfWork` →
 * `IOutboxWriteScope` assignability check lives in `database-plugin`, which
 * owns `IUnitOfWork`; `common` imports no plugin, even in tests.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CAPABILITIES,
  createCapabilityToken,
  OUTBOX_RECORD_KIND,
  type OutboxRecord,
  type OutboxTransition,
} from '../../src/index.ts';

describe('outbox port contract', () => {
  it('the OUTBOX token passes the capability-token grammar, as does a named instance', () => {
    expect(createCapabilityToken(CAPABILITIES.OUTBOX)).toBe('outbox');
    expect(createCapabilityToken(`${CAPABILITIES.OUTBOX}.billing`)).toBe('outbox.billing');
  });

  it('a record carries the discriminator as its literal type', () => {
    const record: OutboxRecord = {
      id: 'e1',
      kind: OUTBOX_RECORD_KIND,
      topic: 't.v1',
      envelope: '{}',
      options: '{}',
      position: 'p',
      createdAt: 0,
      status: 'pending',
      attempts: 0,
      availableAt: 0,
      claimVersion: 0,
      leaseUntil: 0,
    };
    // @ts-expect-error — any other kind is a compile error.
    const wrong: OutboxRecord = { ...record, kind: 'business' };
    expect(record.kind).toBe('setu-outbox');
    expect(wrong.kind).toBe('business');
  });

  it('a not-pending transition cannot report pending, and a not-failed one cannot report failed', () => {
    const sent: OutboxTransition = {
      outcome: 'not-pending',
      status: 'sent',
    };
    // @ts-expect-error — `pending` is the expected status, never the reported one.
    const badPending: OutboxTransition = { outcome: 'not-pending', status: 'pending' };
    // @ts-expect-error — `failed` is the expected status, never the reported one.
    const badFailed: OutboxTransition = { outcome: 'not-failed', status: 'failed' };
    expect(sent.outcome).toBe('not-pending');
    const lost: OutboxTransition = { outcome: 'claim-lost' };
    expect(lost.outcome).toBe('claim-lost');
    expect([badPending.outcome, badFailed.outcome]).toEqual(['not-pending', 'not-failed']);
  });
});
