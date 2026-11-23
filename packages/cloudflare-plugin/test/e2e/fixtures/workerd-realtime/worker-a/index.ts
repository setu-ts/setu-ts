/**
 * Worker A: the chat application, and the owner of the hub Durable Object
 * class that Worker B and the front Worker bind by `script_name`.
 *
 * @module
 */
import { DurableObject } from 'cloudflare:workers';
import { RealtimeBackplaneObjectCore } from '@setu-ts/cloudflare-plugin';
import type { IDurableObjectState, IDurableObjectWebSocket } from '@setu-ts/cloudflare-plugin';

export { default } from '../app.ts';

/** The topic's hub, with one fixture-only route that counts its sockets. */
export class RealtimeHub extends DurableObject {
  readonly #core: RealtimeBackplaneObjectCore;

  constructor(ctx: unknown, env: unknown) {
    super(ctx, env);
    this.#core = new RealtimeBackplaneObjectCore(ctx as IDurableObjectState);
  }

  fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === '/count') {
      return Promise.resolve(new Response(String(this.ctx.getWebSockets().length)));
    }
    return this.#core.fetch(request);
  }

  webSocketMessage(ws: IDurableObjectWebSocket, message: string | ArrayBuffer): void {
    this.#core.webSocketMessage(ws, message);
  }

  webSocketClose(ws: IDurableObjectWebSocket, code: number, reason: string): void {
    this.#core.webSocketClose(ws, code, reason);
  }

  webSocketError(ws: IDurableObjectWebSocket): void {
    this.#core.webSocketError(ws);
  }
}
