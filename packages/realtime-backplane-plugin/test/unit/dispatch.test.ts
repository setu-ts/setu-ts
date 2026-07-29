/**
 * Tests for shared frame dispatch — handler isolation.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { RealtimeFrame, RealtimeFrameHandler } from '@hono-enterprise/common';
import { dispatchFrame } from '../../src/transports/dispatch.ts';

const FRAME: RealtimeFrame = { kind: 'ws-room', origin: 'node-a', name: 'lobby', data: 'hi' };

describe('dispatchFrame', () => {
  it('delivers to every handler', () => {
    const seen: string[] = [];
    dispatchFrame([() => seen.push('a'), () => seen.push('b')], FRAME, () => {});
    expect(seen).toEqual(['a', 'b']);
  });

  it('continues past a throwing handler and reports it', () => {
    // The WebSocket and SSE plugins share one backplane; a throw from one must
    // never stop delivery to the other.
    const seen: string[] = [];
    const errors: unknown[] = [];
    dispatchFrame(
      [
        () => {
          throw new Error('consumer blew up');
        },
        () => seen.push('second'),
      ],
      FRAME,
      (error) => errors.push(error),
    );

    expect(seen).toEqual(['second']);
    expect((errors[0] as Error).message).toBe('consumer blew up');
  });

  it('isolates every handler independently', () => {
    const seen: string[] = [];
    const errors: unknown[] = [];
    dispatchFrame(
      [
        () => {
          throw new Error('first');
        },
        () => seen.push('middle'),
        () => {
          throw new Error('third');
        },
      ],
      FRAME,
      (error) => errors.push(error),
    );

    expect(seen).toEqual(['middle']);
    expect(errors.length).toBe(2);
  });

  it('never throws out of the dispatch itself', () => {
    // On the Redis and broker paths this runs inside a driver callback, where
    // an escaping throw would be unhandled.
    expect(() =>
      dispatchFrame(
        [() => {
          throw new Error('boom');
        }],
        FRAME,
        () => {},
      )
    ).not.toThrow();
  });

  it('snapshots the handler set so a handler may unsubscribe during delivery', () => {
    const handlers = new Set<RealtimeFrameHandler>();
    const seen: string[] = [];
    const first = (): void => {
      seen.push('first');
      handlers.delete(second);
    };
    const second = (): void => {
      seen.push('second');
    };
    handlers.add(first);
    handlers.add(second);

    dispatchFrame(handlers, FRAME, () => {});

    // Mutating the live set mid-iteration must not skip or crash the fan-out.
    expect(seen).toEqual(['first', 'second']);
  });

  it('coerces a non-Error throw for the reporter', () => {
    const errors: unknown[] = [];
    dispatchFrame(
      [() => {
        throw 'a string';
      }],
      FRAME,
      (error) => errors.push(error),
    );
    expect(errors).toEqual(['a string']);
  });
});
