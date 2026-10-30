import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, ISseService } from '@setu-ts/common';
import { SMOKE_TOKEN } from '../../contract.ts';

/**
 * Registers an authenticated SSE stream that sends one event and closes,
 * plus `/resume`, which reports the `Last-Event-ID` of the latest reconnect.
 */
export function registerEventsRoutes(router: IRouterApi): void {
  let eventCount = 0;
  let resumedWith: string | null = null;

  router.get('/events', (ctx) => {
    if (ctx.request.headers.get('authorization') !== `Bearer ${SMOKE_TOKEN}`) {
      return ctx.response.status(401).send();
    }
    eventCount += 1;
    resumedWith = ctx.request.headers.get('last-event-id');
    const connection = ctx.services.get<ISseService>(CAPABILITIES.SSE).open(ctx);
    connection.send({ id: String(eventCount), event: 'score', data: { eventCount } });
    // Closing the stream makes the client reconnect, carrying the last event id.
    setTimeout(() => connection.close(), 25);
    return connection.result;
  });

  router.get('/resume', (ctx) => ctx.response.json({ resumedWith }));
}
