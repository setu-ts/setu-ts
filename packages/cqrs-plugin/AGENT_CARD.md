# @setu-ts/cqrs-plugin — command and query buses

`setu add cqrs` prints `CqrsPlugin()` and installs the package; it is zero-configuration. The plugin
registers an `ICqrsFacade` under `CAPABILITIES.CQRS`, plus the two buses under
`CAPABILITIES.COMMAND_BUS` and `CAPABILITIES.QUERY_BUS`. Both buses share one pipeline, so a
behavior registered once runs for commands and queries alike.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';

export function createCqrsApp() {
  return createApplication({
    plugins: [RuntimePlugin(), CqrsPlugin({ behaviors: [] })],
  });
}
```

```ts
import type { CqrsCommand, ICommandHandler, ICqrsFacade } from '@setu-ts/cqrs-plugin';

class CreateUserCommand implements CqrsCommand<{ email: string }> {
  readonly type = 'CreateUserCommand';
  constructor(readonly data: { email: string }) {}
}

class CreateUserHandler implements ICommandHandler<CreateUserCommand, string> {
  async handle(command: CreateUserCommand): Promise<string> {
    return command.data.email;
  }
}

export async function createUser(cqrs: ICqrsFacade, email: string): Promise<string> {
  cqrs.commandBus.register<CreateUserCommand, string>(
    'CreateUserCommand',
    new CreateUserHandler(),
  );
  return cqrs.commandBus.execute<string>(new CreateUserCommand({ email }));
}
```

- A request is routed by its string `type`; a class instance or a plain `{ type, data }` object both
  satisfy `CqrsCommand` / `CqrsQuery`.
- `behaviors` is `IPipelineBehavior[]`, invoked in declared order for both buses. One that returns
  without calling its `next` continuation short-circuits the handler and later behaviors.
- `commandHandlers` and `queryHandlers` take `{ type, handler }` pairs; `handler` is an instance or
  a factory resolved at `onInit`, so it can use any registered capability.
- `execute` rejects with `HandlerNotFoundError` (exported for `instanceof`) when no handler is
  registered, and rejects when `type` is not a string.
- `setu generate command-handler` writes handlers and wires them through these options.
