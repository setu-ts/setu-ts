/**
 * @module
 *
 * Server-Sent Events (SSE) plugin for real-time, one-way server-to-client
 * messaging over `text/event-stream`. Built on the Milestone 42 streaming
 * primitive (`IResponse.stream()` + `IRequestContext.signal`).
 *
 * @example
 * ```typescript
 * import { SsePlugin } from '@hono-enterprise/sse-plugin';
 * import { CAPABILITIES, ISseService } from '@hono-enterprise/common';
 *
 * const app = createApplication();
 * app.register(SsePlugin({ heartbeatMs: 15000, retryMs: 3000 }));
 * await app.start({ port: 3000 });
 *
 * app.router.get('/events', async (ctx) => {
 *   const sse = ctx.services.get<ISseService>(CAPABILITIES.SSE);
 *   const conn = sse.open(ctx);
 *   conn.send({ id: '1', data: 'hello world' });
 *   return conn.result;
 * });
 * ```
 * @since 0.1.0
 */

export { SsePlugin } from './plugin/sse-plugin.ts';
export { SseService } from './services/sse-service.ts';
export { SseConnection } from './connection/sse-connection.ts';
export type { SsePluginOptions } from './interfaces/index.ts';

// Re-export common SSE contracts for convenience.
export type { ISseConnection, ISseService, SseChannel, SseMessage } from '@hono-enterprise/common';
export { CAPABILITIES } from '@hono-enterprise/common';
