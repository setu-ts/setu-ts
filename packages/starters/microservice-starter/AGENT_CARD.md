# @setu-ts/microservice-starter — compose HTTP and background jobs

**Add it:** install `@setu-ts/microservice-starter` directly; it has no `setu add` entry. Call
`createMicroserviceApp` in `setu.config.ts`; the starter itself provides no capability and composes
the REST plugins plus messaging, queue, resilience and telemetry.

## Accept a request and process its job

Use this factory in place of the scaffold's application construction; put the route function in the
module's routes file:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IJob, IQueue, IRouterApi } from '@setu-ts/common';
import { createMicroserviceApp } from '@setu-ts/microservice-starter';

export function registerReceiptRoutes(router: IRouterApi): void {
  router.post('/orders/:id/receipt', {
    handler: async (ctx) => {
      const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
      const id = await queue.add('receipt', { orderId: ctx.params.id! });
      return ctx.response.status(202).json({ id });
    },
  });
}

const app = createMicroserviceApp({
  queue: {
    processors: [{
      name: 'receipt',
      processor: async (job: IJob<{ orderId: string }>) => {
        console.log(job.data.orderId);
      },
    }],
  },
  openapi: { swagger: { assets: 'cdn' } },
});
registerReceiptRoutes(app.router);
await app.start({ port: 3000 });
```

## Behaviour the types do not show

- The factory returns an unstarted application and adds the RFC 9457 error handler at priority 0.
- Messaging, queue, resilience and telemetry are always registered: omitted options use the memory
  broker, memory queue, resilience defaults and no-op telemetry.
- Memory jobs and messages are process-local; configure durable backends for shared work.
- A messaging real-time backplane works here because the broker is present.
- This factory registers its broker and queue even on Workers; it does not perform the CLI
  microservice template's platform-binding swap.

## Other options

- `messaging`, `queue`, `resilience` and `telemetry` configure this tier's added plugins.
- REST arms include optional `database`, `auth`, `session`, `di`, `graphql` and `serviceDiscovery`.
- `realtime` opts into websocket, SSE and backplane plugins independently.
- `buildMicroservicePlugins` returns a plugin array without the factory's error middleware.
