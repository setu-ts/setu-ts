/**
 * @module
 *
 * `@hono-enterprise/realtime-backplane-plugin` — cross-replica fan-out for
 * WebSocket rooms and SSE channels.
 *
 * The WebSocket and SSE plugins hold their broadcast membership in ordinary
 * in-process sets: correct and fast on one instance, invisible to every other.
 * This plugin registers an {@linkcode IRealtimeBackplane} under
 * `CAPABILITIES.REALTIME_BACKPLANE`, which both of those plugins resolve
 * **optionally** — so registering it is what makes `ws.room('lobby')` and
 * `sse.channel('news')` reach clients connected to a different replica, and
 * removing it returns them to in-process behavior with no application change.
 *
 * Three transports ship: `'memory'` (the default, a real single-process bus),
 * `'messaging'` (over whatever broker is registered under
 * `CAPABILITIES.MESSAGING`, reusing all five of the messaging plugin's brokers
 * with no new dependency), and `'redis'` (Redis pub/sub over an inject-or-lazy
 * `ioredis`). A `'custom'` arm accepts any `IRealtimeBackplane`.
 *
 * Two caveats are structural rather than incidental: `Room.size` and
 * `SseChannel.size` keep reporting **local** membership, and
 * `RoomBroadcastOptions.except` is honored only on the originating instance,
 * because it names a live in-process connection with no cross-process identity.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@hono-enterprise/kernel';
 * import { RuntimePlugin } from '@hono-enterprise/runtime';
 * import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';
 * import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin(),
 *     RealtimeBackplanePlugin({ transport: 'redis', url: 'redis://localhost:6379' }),
 *     WebSocketPlugin(),
 *   ],
 * });
 * ```
 * @since 0.2.0
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

export { RealtimeBackplanePlugin } from './plugin/realtime-backplane-plugin.ts';

// ── Transports ──────────────────────────────────────────────────────────────

export { createBackplane } from './transports/backplane-factory.ts';
export { MemoryBackplane } from './transports/memory-backplane.ts';
export { isRealtimeFrame, MessagingBackplane } from './transports/messaging-backplane.ts';
export { RedisBackplane } from './transports/redis-backplane.ts';
export { adaptRedisModule, loadRedisModule, RedisModuleError } from './transports/redis-module.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export { DEFAULT_TOPIC } from './interfaces/index.ts';
export type {
  BackplaneCommonOptions,
  CustomBackplaneOptions,
  IRedisBackplaneClient,
  IRedisModule,
  MemoryBackplaneOptions,
  MessagingBackplaneOptions,
  RealtimeBackplanePluginOptions,
  RedisBackplaneOptions,
} from './interfaces/index.ts';

// ── Re-export the common contracts for convenience ──────────────────────────

export type {
  EncodedPayload,
  IRealtimeBackplane,
  RealtimeFrame,
  RealtimeFrameHandler,
  RealtimeFrameKind,
} from '@hono-enterprise/common';
// Re-exported so a custom transport can honor the identical wire shape without
// reaching past this package.
export { CAPABILITIES, decodeFrameData, encodeFrameData } from '@hono-enterprise/common';
