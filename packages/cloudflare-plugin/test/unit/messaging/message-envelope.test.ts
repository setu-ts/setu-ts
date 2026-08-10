/**
 * The envelope is the only thing that carries a topic onto a Cloudflare queue,
 * which has none — so a guard that accepts a foreign body would route another
 * producer's message into an application handler, and one that rejects our own
 * would retry every message until the queue dead-lettered it.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  encodePublishEnvelope,
  encodeReplyEnvelope,
  encodeRequestEnvelope,
  isPublishEnvelope,
  isQueueEnvelope,
  isReplyEnvelope,
  isRequestEnvelope,
} from '../../../src/messaging/message-envelope.ts';

describe('encodePublishEnvelope', () => {
  it('carries the topic, id, and payload under the current version', () => {
    expect(encodePublishEnvelope('user.created', 'id-1', { userId: 7 })).toEqual({
      v: 1,
      kind: 'msg',
      topic: 'user.created',
      id: 'id-1',
      payload: { userId: 7 },
    });
  });

  it('round-trips through its own guard', () => {
    const envelope = encodePublishEnvelope('t', 'id-1', 'payload');
    expect(isPublishEnvelope(envelope)).toBe(true);
    expect(isQueueEnvelope(envelope)).toBe(true);
    expect(isRequestEnvelope(envelope)).toBe(false);
  });

  it('preserves a null payload, which is a legitimate message', () => {
    const envelope = encodePublishEnvelope('t', 'id-1', null);
    expect(isPublishEnvelope(envelope)).toBe(true);
    expect(envelope.payload).toBeNull();
  });
});

describe('encodeRequestEnvelope', () => {
  it('carries the correlation id and reply address', () => {
    expect(encodeRequestEnvelope('sum', 'id-1', 'corr-1', 'rr.inbox.abc', [1, 2])).toEqual({
      v: 1,
      kind: 'rpc-req',
      topic: 'sum',
      id: 'id-1',
      correlationId: 'corr-1',
      replyTo: 'rr.inbox.abc',
      payload: [1, 2],
    });
  });

  it('round-trips through its own guard', () => {
    const envelope = encodeRequestEnvelope('sum', 'id-1', 'corr-1', 'rr.inbox.abc', 2);
    expect(isRequestEnvelope(envelope)).toBe(true);
    expect(isQueueEnvelope(envelope)).toBe(true);
    expect(isPublishEnvelope(envelope)).toBe(false);
  });
});

describe('encodeReplyEnvelope', () => {
  it('carries a resolved payload', () => {
    expect(encodeReplyEnvelope('corr-1', { ok: true, payload: 3 })).toEqual({
      v: 1,
      kind: 'rpc-reply',
      correlationId: 'corr-1',
      ok: true,
      payload: 3,
    });
  });

  it('carries a failure message instead of a payload', () => {
    expect(encodeReplyEnvelope('corr-1', { ok: false, error: 'boom' })).toEqual({
      v: 1,
      kind: 'rpc-reply',
      correlationId: 'corr-1',
      ok: false,
      error: 'boom',
    });
  });

  it('round-trips through its own guard on both arms', () => {
    expect(isReplyEnvelope(encodeReplyEnvelope('c', { ok: true, payload: 1 }))).toBe(true);
    expect(isReplyEnvelope(encodeReplyEnvelope('c', { ok: false, error: 'x' }))).toBe(true);
  });
});

describe('isQueueEnvelope', () => {
  const rejected: readonly [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'user.created'],
    ['a number', 7],
    ['an array', []],
    ['an object with no kind', { topic: 't', id: 'i', v: 1 }],
    ['an unknown kind', { v: 1, kind: 'other', topic: 't', id: 'i' }],
    ['a future version', { v: 2, kind: 'msg', topic: 't', id: 'i' }],
    ['a missing topic', { v: 1, kind: 'msg', id: 'i' }],
    ['a non-string topic', { v: 1, kind: 'msg', topic: 7, id: 'i' }],
    ['a missing id', { v: 1, kind: 'msg', topic: 't' }],
    ['a job envelope from the queue capability', { v: 1, name: 'send-email', id: 'i', data: {} }],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(isQueueEnvelope(value)).toBe(false);
      expect(isPublishEnvelope(value)).toBe(false);
      expect(isRequestEnvelope(value)).toBe(false);
    });
  }
});

describe('isRequestEnvelope', () => {
  it('rejects a request missing its correlation id', () => {
    expect(isRequestEnvelope({ v: 1, kind: 'rpc-req', topic: 't', id: 'i', replyTo: 'a' }))
      .toBe(false);
  });

  it('rejects a request missing its reply address', () => {
    expect(isRequestEnvelope({ v: 1, kind: 'rpc-req', topic: 't', id: 'i', correlationId: 'c' }))
      .toBe(false);
  });

  it('rejects a request whose reply address is not a string', () => {
    expect(
      isRequestEnvelope({
        v: 1,
        kind: 'rpc-req',
        topic: 't',
        id: 'i',
        correlationId: 'c',
        replyTo: 7,
      }),
    ).toBe(false);
  });
});

describe('isReplyEnvelope', () => {
  const rejected: readonly [string, unknown][] = [
    ['null', null],
    ['a string', 'reply'],
    ['a publish envelope', { v: 1, kind: 'msg', topic: 't', id: 'i' }],
    ['a future version', { v: 2, kind: 'rpc-reply', correlationId: 'c', ok: true }],
    ['a missing correlation id', { v: 1, kind: 'rpc-reply', ok: true }],
    ['a non-boolean ok', { v: 1, kind: 'rpc-reply', correlationId: 'c', ok: 'yes' }],
  ];

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(isReplyEnvelope(value)).toBe(false);
    });
  }
});
