/**
 * Real-time backplane contract — the port that lets in-process broadcast
 * groups (WebSocket rooms, SSE channels) reach peers on other replicas.
 *
 * Both the WebSocket and the SSE plugin hold their membership in ordinary
 * in-process sets, which is correct and fast for one instance and invisible to
 * every other instance. The backplane is the seam that closes that gap: a local
 * broadcast is also published here, every replica subscribes, and each delivers
 * arriving frames to its own local members.
 *
 * The port lives in `common` because two plugins consume it and no plugin may
 * import another. The transports that implement it live in
 * `@setu-ts/realtime-backplane-plugin`, which registers one under
 * `CAPABILITIES.REALTIME_BACKPLANE`; a consumer resolves that token optionally
 * and falls back to purely in-process behavior when it is absent.
 *
 * @module
 * @since 0.2.0
 */

/**
 * Which kind of broadcast group a {@linkcode RealtimeFrame} addresses.
 *
 * One backplane topic carries both, so a consumer must ignore the other kind
 * rather than assume every frame is its own — a WebSocket room and an SSE
 * channel may legitimately share a name.
 *
 * @since 0.2.0
 */
export type RealtimeFrameKind = 'ws-room' | 'sse-channel';

/**
 * One broadcast crossing the backplane.
 *
 * Every field is JSON-serializable, because the transports agree on nothing
 * richer: a message broker hands the payload to a serializer, and Redis
 * pub/sub carries strings.
 *
 * @since 0.2.0
 */
export interface RealtimeFrame {
  /** Which consumer the frame belongs to. */
  readonly kind: RealtimeFrameKind;
  /**
   * The publishing instance's identity.
   *
   * A subscriber drops frames carrying its own origin. Without this a
   * two-node cluster would echo every broadcast back and forth forever.
   */
  readonly origin: string;
  /** The room or channel name the frame addresses. */
  readonly name: string;
  /**
   * The payload, always a string.
   *
   * A WebSocket binary frame is base64-encoded and flagged by
   * {@linkcode RealtimeFrame.binary}; an SSE message is its JSON encoding.
   */
  readonly data: string;
  /** True when {@linkcode RealtimeFrame.data} is base64-encoded binary. */
  readonly binary?: boolean;
  /**
   * The connection excluded from this broadcast, by ID.
   *
   * `RoomBroadcastOptions.except` names a live connection object, which has no
   * meaning in another process — but connection IDs come from `runtime.uuid()`
   * and are therefore globally unique, so carrying the ID is what lets the
   * exclusion survive the wire. A receiving replica skips the member whose `id`
   * matches; ordinarily none does, since the excluded peer is connected to the
   * originating replica.
   *
   * Absent for SSE channels, whose `publish` has no exclusion option.
   *
   * @since 0.2.0
   */
  readonly exceptId?: string;
}

/**
 * Receives frames published by other instances.
 *
 * @param frame - The arriving frame, already filtered of own-origin echoes
 * @since 0.2.0
 */
export type RealtimeFrameHandler = (frame: RealtimeFrame) => void;

/**
 * A publish/subscribe transport carrying {@linkcode RealtimeFrame}s between
 * application instances.
 *
 * @example
 * ```typescript
 * const backplane = ctx.services.get<IRealtimeBackplane>(
 *   CAPABILITIES.REALTIME_BACKPLANE,
 * );
 * await backplane.subscribe((frame) => {
 *   if (frame.kind === 'sse-channel') {
 *     hub.channel(frame.name).publishLocal(JSON.parse(frame.data));
 *   }
 * });
 * ```
 * @since 0.2.0
 */
export interface IRealtimeBackplane {
  /**
   * This instance's identity, stamped onto every frame it publishes.
   *
   * Stable for the lifetime of the instance and distinct from every peer's.
   */
  readonly origin: string;
  /**
   * Opens the underlying transport. Idempotent.
   */
  connect(): Promise<void>;
  /**
   * Publishes a frame to every other subscribed instance.
   *
   * The frame is not delivered back to this instance's own handlers — a local
   * broadcast has already reached local members directly, and redelivering it
   * would double-send.
   *
   * @param frame - The frame to publish
   */
  publish(frame: RealtimeFrame): Promise<void>;
  /**
   * Registers a handler for frames arriving from other instances.
   *
   * May be called more than once; each consumer plugin registers its own.
   *
   * @param handler - Invoked per arriving frame
   * @returns A function that removes this handler
   */
  subscribe(handler: RealtimeFrameHandler): Promise<() => void>;
  /**
   * Closes the underlying transport and drops every handler.
   */
  close(): Promise<void>;
}
