/**
 * Per-connection links for a backplane whose sockets belong to one request.
 *
 * On Cloudflare Workers every I/O object (a client WebSocket, an outbound
 * socket) belongs to the request that created it, and touching it from another
 * request throws. A room cannot then hold its members in one isolate-wide set
 * and write to all of them from whichever request broadcasts. A backplane that
 * implements {@linkcode IRealtimeLinkBackplane} gives each connection its own
 * link to the hub instead, opened in that connection's own request: frames for
 * the connection arrive on its link and are delivered there, and a broadcast
 * travels over the sender's link or, from any other request, over an HTTP
 * publish that needs no socket.
 *
 * Additive: {@linkcode IRealtimeBackplane} is unchanged, and the backplane is
 * still registered under `CAPABILITIES.REALTIME_BACKPLANE`; a consumer narrows
 * it with {@linkcode hasConnectionLinks}.
 *
 * @module
 * @since 0.14.0
 */

import type { IRealtimeBackplane, RealtimeFrame } from './realtime.ts';

/**
 * One connection's link to the backplane hub.
 *
 * @since 0.14.0
 */
export interface IRealtimeConnectionLink {
  /**
   * Sends a frame over this link. Frames sent before the link is open are
   * queued (bounded) and sent once it opens.
   *
   * The hub delivers a link's own frame to every other link, never back to
   * this one, so the caller delivers to its own connection itself when it
   * should.
   *
   * @param frame - The frame to publish
   * @returns `false` when the frame could not be handed to the link (it is
   *   closed, the call came from a request that does not own it, or the
   *   implementation's queue or frame bound refuses it); the caller then
   *   publishes another way
   */
  publish(frame: RealtimeFrame): boolean;
  /**
   * Closes the link. Idempotent; a closed link delivers nothing more. When an
   * open (the first or a reopen) is in flight, frames queued before it are
   * sent once it opens and the link then closes, so a connection that leaves
   * quickly does not lose what it already broadcast (an implementation keeps
   * that flush alive where its platform allows). Frames queued while a lost
   * link waits to reopen are dropped and reported.
   */
  close(): void;
}

/**
 * A backplane that can give each connection its own link.
 *
 * @since 0.14.0
 */
export interface IRealtimeLinkBackplane extends IRealtimeBackplane {
  /**
   * Opens a link for one connection. Must be called from the request that owns
   * the connection; `deliver` then runs in that request too.
   *
   * @param connectionId - The connection's id, for diagnostics only
   * @param deliver - Receives every frame the hub sends this link, unfiltered;
   *   the caller decides whether its connection should see it
   * @param onLost - Called once, in the owning request, when the link has
   *   given up reopening a lost socket and will deliver nothing more; the
   *   caller should close its connection so the client reconnects. Not called
   *   after {@linkcode IRealtimeConnectionLink.close}. Since 0.14.0.
   * @returns The link
   */
  openConnectionLink(
    connectionId: string,
    deliver: (frame: RealtimeFrame) => void,
    onLost?: () => void,
  ): IRealtimeConnectionLink;
  /**
   * Publishes a frame to every link through the hub without a socket, so it
   * works from any request (a route handler, a timer). The hub sends it to
   * every link, the caller's own connection's link included.
   *
   * @param frame - The frame to publish
   * @returns Resolves once the hub has accepted the frame
   */
  publishViaHub(frame: RealtimeFrame): Promise<void>;
}

/**
 * Whether a backplane gives each connection its own link.
 *
 * @param backplane - The registered backplane
 * @returns `true` when it implements {@linkcode IRealtimeLinkBackplane}
 * @example
 * ```typescript
 * if (hasConnectionLinks(backplane)) {
 *   const link = backplane.openConnectionLink(conn.id, (frame) => {});
 *   link.close();
 * }
 * ```
 * @since 0.14.0
 */
export function hasConnectionLinks(
  backplane: IRealtimeBackplane,
): backplane is IRealtimeLinkBackplane {
  const candidate = backplane as Partial<IRealtimeLinkBackplane>;
  return (
    typeof candidate.openConnectionLink === 'function' &&
    typeof candidate.publishViaHub === 'function'
  );
}
