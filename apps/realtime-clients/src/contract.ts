/**
 * Values the server and the client driver must agree on.
 *
 * Dependency-free on purpose: the driver also runs under plain Node, Bun and
 * workerd, none of which resolve the workspace's `@setu-ts/*` source paths.
 */

/** The bearer token the SSE route requires. */
export const SMOKE_TOKEN = 'smoke-token';

/** The WebSocket route the idle-survival check connects to. */
export const IDLE_SOCKET_PATH = '/ws/idle';
