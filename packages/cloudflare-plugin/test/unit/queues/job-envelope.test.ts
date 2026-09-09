/**
 * The envelope is the only thing carrying a job's name and id across the
 * platform, so its guard has to reject everything that is not one — a producer
 * sharing the queue, a version skew mid-deploy, a hand-written test message.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  encodeJobEnvelope,
  isJobEnvelope,
  readEnvelopeHeaders,
} from '../../../src/queues/job-envelope.ts';

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

  it('carries the caller-supplied header channel (M90i)', () => {
    const envelope = encodeJobEnvelope('j', 'id-1', {}, undefined, {
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'x-tenant': 't-1',
    });
    expect(envelope.headers).toEqual({
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      'x-tenant': 't-1',
    });
    // Additive: an older consumer's guard still accepts it, which is what makes
    // this safe without bumping the envelope version.
    expect(isJobEnvelope(envelope)).toBe(true);
  });

  it('omits headers rather than setting them undefined', () => {
    // ABSENT means "this job carried no channel" on the committed contract;
    // a present-but-undefined key would report an empty channel instead.
    expect(Object.hasOwn(encodeJobEnvelope('j', 'id-1', {}), 'headers')).toBe(false);
  });

  it('carries an EMPTY map as an empty map', () => {
    expect(encodeJobEnvelope('j', 'id-1', {}, undefined, {}).headers).toEqual({});
  });
});

describe('readEnvelopeHeaders', () => {
  it('returns a well-formed string map', () => {
    expect(readEnvelopeHeaders({ traceparent: 'tp', 'x-a': 'b' }))
      .toEqual({ traceparent: 'tp', 'x-a': 'b' });
    expect(readEnvelopeHeaders({})).toEqual({});
  });

  it('reports undefined for an absent or malformed map', () => {
    // Absent and malformed collapse to one answer here — both mean "no usable
    // channel" — while the caller keeps them apart for reporting.
    expect(readEnvelopeHeaders(undefined)).toBeUndefined();
    expect(readEnvelopeHeaders(null)).toBeUndefined();
    expect(readEnvelopeHeaders('not-a-map')).toBeUndefined();
    expect(readEnvelopeHeaders(['traceparent', 'tp'])).toBeUndefined();
    expect(readEnvelopeHeaders({ traceparent: 'tp', depth: 3 })).toBeUndefined();
  });

  it('does not let a __proto__ key pollute a prototype', () => {
    const read = readEnvelopeHeaders(JSON.parse('{"__proto__":"x","a":"b"}'));
    expect(read?.a).toBe('b');
    expect(Object.getPrototypeOf({} as Record<string, unknown>)).toBe(Object.prototype);
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
