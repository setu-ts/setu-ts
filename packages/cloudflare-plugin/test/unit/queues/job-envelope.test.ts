/**
 * The envelope is the only thing carrying a job's name and id across the
 * platform, so its guard has to reject everything that is not one — a producer
 * sharing the queue, a version skew mid-deploy, a hand-written test message.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { encodeJobEnvelope, isJobEnvelope } from '../../../src/queues/job-envelope.ts';

describe('encodeJobEnvelope', () => {
  it('carries the name, id and payload, and round-trips through the guard', () => {
    const envelope = encodeJobEnvelope('send-email', 'id-1', { to: 'a@example.com' });

    expect(envelope).toEqual({
      v: 1,
      name: 'send-email',
      id: 'id-1',
      data: { to: 'a@example.com' },
    });
    expect(isJobEnvelope(envelope)).toBe(true);
  });

  it('omits maxAttempts rather than setting it undefined', () => {
    // exactOptionalPropertyTypes is on, and an explicit `undefined` would also
    // survive JSON round-tripping as a present-but-null key on some paths.
    expect(Object.hasOwn(encodeJobEnvelope('j', 'id-1', {}), 'maxAttempts')).toBe(false);
    expect(encodeJobEnvelope('j', 'id-1', {}, 3).maxAttempts).toBe(3);
  });
});

describe('isJobEnvelope', () => {
  it('accepts a well-formed envelope with and without maxAttempts', () => {
    expect(isJobEnvelope({ v: 1, name: 'j', id: 'i', data: null })).toBe(true);
    expect(isJobEnvelope({ v: 1, name: 'j', id: 'i', data: null, maxAttempts: 2 })).toBe(true);
  });

  it('rejects anything that is not this version of the envelope', () => {
    // Each of these is a body a real queue can deliver, and every one of them
    // must be retried rather than routed.
    expect(isJobEnvelope(null)).toBe(false);
    expect(isJobEnvelope(undefined)).toBe(false);
    expect(isJobEnvelope('a string body')).toBe(false);
    expect(isJobEnvelope(42)).toBe(false);
    expect(isJobEnvelope([])).toBe(false);
    expect(isJobEnvelope({})).toBe(false);
    // A plain payload from another producer on the same queue.
    expect(isJobEnvelope({ to: 'a@example.com' })).toBe(false);
    // A future or past envelope version.
    expect(isJobEnvelope({ v: 2, name: 'j', id: 'i', data: null })).toBe(false);
    // Structurally close but missing a field the dispatcher needs.
    expect(isJobEnvelope({ v: 1, id: 'i', data: null })).toBe(false);
    expect(isJobEnvelope({ v: 1, name: 'j', data: null })).toBe(false);
    expect(isJobEnvelope({ v: 1, name: 7, id: 'i', data: null })).toBe(false);
    expect(isJobEnvelope({ v: 1, name: 'j', id: 8, data: null })).toBe(false);
    expect(isJobEnvelope({ v: 1, name: 'j', id: 'i', data: null, maxAttempts: 'two' })).toBe(false);
  });
});
