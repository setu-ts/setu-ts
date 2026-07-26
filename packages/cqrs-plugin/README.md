# @hono-enterprise/cqrs-plugin

Command Query Responsibility Segregation. Registers an `ICqrsFacade` under `CAPABILITIES.CQRS`
(`'cqrs'`), exposing a `commandBus` and a `queryBus`.

Both buses share one request pipeline, so a behavior registered once applies to commands and queries
alike.

## Installation

```typescript
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
```

## Usage

```typescript
import { CqrsPlugin } from '@hono-enterprise/cqrs-plugin';
import { CAPABILITIES, type ICqrsFacade, type IPipelineBehavior } from '@hono-enterprise/common';

const timing: IPipelineBehavior = {
  async handle(request, next) {
    const started = runtime.hrtime();
    const result = await next();
    logger.debug('handled', { type: request.type, ms: runtime.hrtime() - started });
    return result;
  },
};

app.register(CqrsPlugin({ behaviors: [timing] }));

const cqrs = app.services.get<ICqrsFacade>(CAPABILITIES.CQRS);

cqrs.commandBus.register(CreateUserCommand, createUserHandler);
cqrs.queryBus.register(GetUserQuery, getUserHandler);

await cqrs.commandBus.execute(new CreateUserCommand({ email: 'ada@example.com' }));
const user = await cqrs.queryBus.execute<User>(new GetUserQuery({ id: '123' }));
```

## Options

| Option      | Type                  | Default | Description                                            |
| ----------- | --------------------- | ------- | ------------------------------------------------------ |
| `behaviors` | `IPipelineBehavior[]` | `[]`    | Applied to every command and query, in declared order. |

A behavior that returns **without calling `next()`** short-circuits the pipeline — the handler and
all later behaviors do not run.

## Errors

`HandlerNotFoundError` is exported for `instanceof` handling; it is thrown when a request reaches a
bus with no registered handler.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
