/**
 * Records what a non-JSON-serializable `SseMessage.data` does at runtime, and
 * why M74's narrowing of that member to `JsonValue` is the fix rather than a
 * runtime guard.
 *
 * Every case here needs the compiler defeated by a cast, which is the point:
 * after the narrowing these paths are unreachable from typed source. The
 * behaviour they document is genuinely divergent and would be a poor thing to
 * discover in production —
 *
 * - `conn.send(msg)` throws to the caller;
 * - `channel.publish(msg)` with no backplane delivers to NOBODY and reports
 *   NOTHING, because `publishLocal` wraps each member send in a swallow;
 * - `channel.publish(msg)` WITH a backplane throws synchronously, because the
 *   publisher builds its frame with `JSON.stringify(msg)` outside any `try`.
 *
 * So the same payload is silent, loud, or loud-in-a-different-place depending
 * on configuration. §3.8 of the milestone plan records the decision not to add
 * runtime reporting: the swallow is correct for the case it exists to serve
 * (one unwritable member must never abort a fan-out), and the type removes the
 * payload before it can reach any of these paths.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HandlerResult, ISseConnection, SseMessage } from '@setu-ts/common';
import { ChannelRegistry, SseChannelImpl } from '../../src/channels/channel-registry.ts';
import { encodeSseMessage } from '../../src/utils/sse-frame.ts';

/** A payload the compiler now refuses; only a cast can produce one. */
const bigintPayload = { balance: 10n } as unknown as SseMessage['data'];

function recordingConn(received: SseMessage[]): ISseConnection {
  return {
    get id() {
      return 'c1';
    },
    get lastEventId() {
      return null;
    },
    get isOpen() {
      return true;
    },
    get result(): HandlerResult {
      return undefined as unknown as HandlerResult;
    },
    send(msg: SseMessage): void {
      // Encoding here rather than storing raw is what makes this fixture
      // honour the real contract: SseConnection.send encodes, and the encode is
      // where a non-serializable payload actually fails.
      encodeSseMessage(msg);
      received.push(msg);
    },
    comment(): void {},
    close(): void {},
  };
}

describe('non-serializable SSE data (M74 / X3-8)', () => {
  it('makes the frame encoder throw', () => {
    expect(() => encodeSseMessage({ data: bigintPayload })).toThrow(TypeError);
  });

  it('is swallowed by a channel publish with no backplane — no delivery, no error', () => {
    const received: SseMessage[] = [];
    const channel = new SseChannelImpl('deploys');
    channel.add(recordingConn(received));

    // Reports success while delivering to nobody. This is the case the type
    // removes; nothing here is a defect to fix at runtime.
    expect(() => {
      channel.publish({ data: bigintPayload });
    }).not.toThrow();
    expect(received).toEqual([]);
  });

  it('throws synchronously out of publish when a backplane is registered', () => {
    // Same payload, same call, opposite observable behaviour — because the
    // backplane publisher JSON.stringify-es the whole message outside a try.
    const registry = new ChannelRegistry(() => {
      JSON.stringify({ data: bigintPayload });
    });

    expect(() => {
      registry.get('deploys').publish({ data: bigintPayload });
    }).toThrow(TypeError);
  });

  it('delivers every JSON-safe payload the narrowed type admits', () => {
    // The positive half: what the type accepts, the encoder writes.
    const received: SseMessage[] = [];
    const channel = new SseChannelImpl('deploys');
    channel.add(recordingConn(received));

    channel.publish({ data: { build: 412, tags: ['live'], note: undefined } });

    expect(received).toHaveLength(1);
    expect(encodeSseMessage(received[0] as SseMessage)).toBe(
      'data: {"build":412,"tags":["live"]}\n\n',
    );
  });
});
