/**
 * The `WebSocketPair` seam for Durable Object code.
 *
 * `WebSocketPair` is a Workers-only global with no counterpart on Deno, Node or
 * Bun, so reading it directly would make the fan-out object unconstructible —
 * and therefore untestable — everywhere else. It is reached through an
 * injectable host whose default is built by an exported factory, which is the
 * committed pattern `packages/runtime/src/adapters/workers/cf-ws-upgrader.ts`
 * established for exactly this: a factory rather than a constant, so the
 * boundary cast is evaluated only when an upgrade actually happens and so a
 * unit test can call it directly instead of leaving the default path uncovered.
 *
 * That module is in a different package and is deliberately NOT imported —
 * AI_GUIDELINES §2.2 forbids reaching into another package's internals, and
 * `runtime` is a plugin package. This is a local implementation of the same
 * pattern, in the same category as M30b's `pemToDer` copy.
 *
 * @module
 * @since 0.2.0
 */

import type { IDurableObjectClientSocket, IDurableObjectWebSocket } from './do-facades.ts';

/**
 * A created `WebSocketPair`.
 *
 * The client half travels back to the caller inside the 101 response; the
 * server half stays with the Durable Object, which hands it to
 * `state.acceptWebSocket`.
 *
 * @since 0.2.0
 */
export interface DurableObjectWebSocketPair {
  /** Handed back to the connecting replica in the 101 response. */
  readonly client: IDurableObjectClientSocket;
  /** Retained by the Durable Object and accepted for hibernation. */
  readonly server: IDurableObjectWebSocket;
}

/**
 * Supplies the socket pair a Durable Object upgrade needs.
 *
 * @since 0.2.0
 */
export interface DurableObjectWebSocketHost {
  /**
   * Creates a linked client/server socket pair.
   *
   * @returns The pair
   */
  createPair(): DurableObjectWebSocketPair;
}

/** Shape of the Workers `WebSocketPair` constructor on `globalThis`. */
interface WebSocketPairGlobal {
  WebSocketPair?: new () => Record<string, unknown>;
}

/**
 * Builds the default host from the real Workers global.
 *
 * Exported as a factory rather than a constant so the boundary cast runs only
 * when an upgrade happens — importing this module on Deno must not throw — and
 * so a unit test can drive the default path directly.
 *
 * @returns A host backed by the `WebSocketPair` global
 * @throws {Error} When `WebSocketPair` is absent, i.e. off the Workers runtime,
 * or when the global yields an incomplete pair
 * @example
 * ```typescript
 * // Inside the Durable Object class the application exports:
 * const core = new RealtimeBackplaneObjectCore(this.ctx, {
 *   createPair: createDefaultDurableObjectWebSocketHost(),
 * });
 * ```
 * @since 0.2.0
 */
export function createDefaultDurableObjectWebSocketHost(): DurableObjectWebSocketHost {
  return {
    createPair(): DurableObjectWebSocketPair {
      // The ONE sanctioned boundary cast in this module, matching how the
      // runtime package reaches the same global.
      const ctor = (globalThis as WebSocketPairGlobal).WebSocketPair;
      if (ctor === undefined) {
        throw new Error(
          'WebSocketPair is not available — the Durable Object realtime backplane requires ' +
            'the Cloudflare Workers runtime. Pass a createPair host to run it elsewhere.',
        );
      }
      const pair = new ctor();
      const client = pair[0];
      const server = pair[1];
      if (client === undefined || server === undefined) {
        throw new Error('WebSocketPair did not produce a client/server pair');
      }
      return {
        client: client as IDurableObjectClientSocket,
        server: server as IDurableObjectWebSocket,
      };
    },
  };
}
