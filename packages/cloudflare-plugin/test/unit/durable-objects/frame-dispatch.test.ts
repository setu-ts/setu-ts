/**
 * The local copy of the frame validator and dispatcher.
 *
 * Both matter for the same reason: a Durable Object namespace is shared
 * infrastructure, and this loop runs inside a socket event listener where an
 * escaping throw is unhandled and would stop delivery to the OTHER consumer
 * plugin subscribed to the same backplane.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { RealtimeFrame, RealtimeFrameHandler } from '@hono-enterprise/common';
import { dispatchFrame, isRealtimeFrame } from '../../../src/durable-objects/frame-dispatch.ts';

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

describe('dispatchFrame', () => {
  it('delivers to every handler', () => {
    const seen: string[] = [];
    const handlers: RealtimeFrameHandler[] = [
      (f) => seen.push(`a:${f.name}`),
      (f) => seen.push(`b:${f.name}`),
    ];

    dispatchFrame(handlers, FRAME, () => {});

    expect(seen).toEqual(['a:lobby', 'b:lobby']);
  });

  it('a throwing handler does not starve the handlers after it', () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    const handlers: RealtimeFrameHandler[] = [
      () => {
        throw new Error('subscriber exploded');
      },
      (f) => seen.push(f.name),
    ];

    dispatchFrame(handlers, FRAME, (error) => errors.push(error));

    expect(seen).toEqual(['lobby']);
    expect((errors[0] as Error).message).toBe('subscriber exploded');
  });

  it('snapshots handlers, so one unsubscribing mid-dispatch cannot skip another', () => {
    const seen: string[] = [];
    const set = new Set<RealtimeFrameHandler>();
    const second: RealtimeFrameHandler = (f) => seen.push(`second:${f.name}`);
    const first: RealtimeFrameHandler = (f) => {
      seen.push(`first:${f.name}`);
      // Without the snapshot this deletion would shorten the live iteration
      // and `second` would never run.
      set.delete(second);
    };
    set.add(first);
    set.add(second);

    dispatchFrame(set, FRAME, () => {});

    expect(seen).toEqual(['first:lobby', 'second:lobby']);
  });
});
