# @setu-ts/cqrs-plugin — command and query dispatch

**Add it:** `setu add cqrs` adds it and wires `CqrsPlugin()` in a recognized functional config. It
provides `CAPABILITIES.CQRS` (`ICqrsFacade`), `CAPABILITIES.COMMAND_BUS` (`ICommandBus`) and
`CAPABILITIES.QUERY_BUS` (`IQueryBus`).

## Register a handler in setu.config.ts

```ts
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import type { CqrsCommand, ICommandHandler } from '@setu-ts/common';

type Echo = CqrsCommand<{ text: string }>;
const echo: ICommandHandler<Echo, string> = {
  handle: (command) => command.data.text,
};
export const cqrs = CqrsPlugin({
  commandHandlers: [{ type: 'echo', handler: echo }],
});
```

## Execute a command from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ICqrsFacade, IRouterApi } from '@setu-ts/common';

export function registerEchoRoutes(router: IRouterApi): void {
  router.get('/echo', {
    handler: async (ctx) => {
      const cqrs = ctx.services.get<ICqrsFacade>(CAPABILITIES.CQRS);
      const text = await cqrs.commandBus.execute<string>({
        type: 'echo', data: { text: 'hello' },
      });
      return ctx.response.json({ text });
    },
  });
}
```

## Behaviour the types do not show

- Routing uses the string `type`, not class identity; plain objects work.
- Registering the same type again replaces its previous handler.
- An unregistered type rejects with `HandlerNotFoundError`; a non-string type rejects with
  TypeError.
- `behaviors` run in declared order on both buses. Returning without calling the continuation skips
  the remaining behaviors and handler.
- Handler and behavior factories resolve at `onInit`, after capabilities are registered.

## Other options

- `queryHandlers` registers read handlers; execute them through `queryBus.execute`.
- `behaviors` accepts instances or factories receiving the service registry.
- `CommandBus` and `QueryBus` can also be constructed directly without the plugin.
