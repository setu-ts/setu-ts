import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * Wire validation for the Durable Object backplane.
 *
 * Both matter for the same reason: a Durable Object namespace is shared
 * infrastructure, and this loop runs inside a socket event listener where an
 * escaping throw is unhandled and would stop delivery to the OTHER consumer
 * plugin subscribed to the same backplane.
 */

import { describe, expect, it } from 'vitest';

import type { RealtimeFrame } from '@setu-ts/common';
import { isRealtimeFrame } from '../../../src/durable-objects/frame-guard.ts';

const FRAME: RealtimeFrame = {
  kind: 'ws-room',
  origin: 'replica-a',
  name: 'lobby',
  data: 'hello',
};

describe('isRealtimeFrame', () => {
  it('accepts a minimal frame', () => {
    expect(isRealtimeFrame(FRAME)).toBe(true);
  });

  it('accepts a frame carrying the optional fields', () => {
    expect(isRealtimeFrame({ ...FRAME, binary: true, exceptId: 'conn-1' })).toBe(true);
  });

  it('rejects a non-object', () => {
    expect(isRealtimeFrame(null)).toBe(false);
    expect(isRealtimeFrame('frame')).toBe(false);
    expect(isRealtimeFrame(7)).toBe(false);
  });

  it('rejects an unknown kind, so another application sharing the object is ignored', () => {
    expect(isRealtimeFrame({ ...FRAME, kind: 'chat-room' })).toBe(false);
  });

  it('rejects a missing or mistyped required field', () => {
    expect(isRealtimeFrame({ ...FRAME, kind: undefined })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, origin: 42 })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, name: undefined })).toBe(false);
    // `data` is contracted as a string — a binary payload arrives base64-encoded.
    expect(isRealtimeFrame({ ...FRAME, data: new Uint8Array([1]) })).toBe(false);
  });

  it('rejects a mistyped optional field rather than ignoring it', () => {
    expect(isRealtimeFrame({ ...FRAME, binary: 'yes' })).toBe(false);
    expect(isRealtimeFrame({ ...FRAME, exceptId: 5 })).toBe(false);
  });
});
