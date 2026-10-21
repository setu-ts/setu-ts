# @setu-ts/decorator-plugin — class-based controllers and services

`setu new app --template class-based` installs and registers decorators and DI. In an existing app,
run `setu add decorator`, install, then register `DecoratorPlugin` in `setu.config.ts`.

TC39 standard decorators: put `@Params(...)` on the method, one source per argument. `@Body()` on a
parameter does not compile. Put `@Inject(...)` on the class, one token per constructor argument;
framework contracts come from `@setu-ts/common`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig } from '@setu-ts/common';
import { Controller, DecoratorPlugin, Get, HttpCode, Inject, Param, Params } from '@setu-ts/decorator-plugin';

@Controller('/orders')
@Inject(CAPABILITIES.CONFIG)
class OrdersController {
  constructor(private readonly config: IConfig) {}

  @Get('/:id')
  @HttpCode(200)
  @Params(Param('id'))
  find(id: string): { id: string; currency: string } {
    return { id, currency: this.config.get('CURRENCY', { default: 'INR' }) };
  }
}

export const decorators = DecoratorPlugin({ controllers: [OrdersController] });
```

- Register a config provider for that token. A plain handler return becomes JSON; `@HttpCode(n)`,
  `@ResponseHeader(name,value)`, `@Redirect(url)` shape it. `Ctx()` supplies `IRequestContext` for
  `ctx.response.status(201).json(value)`.
- Argument sources: `Body<T>()`, `Param('id')`, `Query('q')`, `Header('x')`, `Cookie('sid')`,
  `CurrentUser()`, `Ctx()`. `@ValidateBody(schema)` enforces only with a validation provider and
  `enforceSchemas: true` (default); otherwise the schema is descriptive.
- `setu g controller orders` writes `src/controllers/orders.controller.ts`; its managed
  `src/controllers/index.ts` exports `APP_CONTROLLERS` for `controllers`. `setu g service orders`
  writes `src/services/orders.service.ts` with `@Injectable({token:'orders-service'})`;
  `src/services/index.ts` exports `APP_SERVICES` for `services`.
- `setu g module orders` writes `src/modules/orders/orders.module.ts`. Edit its
  `@Module({controllers,providers,imports})`; `src/modules/index.ts` exports `MODULES` for
  `modules`. These arrays feed `DecoratorPlugin` in `setu.config.ts`.
- Non-HTTP classes go in `ingress`: `src/ingress/index.ts` supplies `INGRESS_HANDLERS`. Register the
  matching queue/events/messaging/etc. provider too. A class with HTTP and non-HTTP handlers needs
  both `controllers` and `ingress`.

<!-- card-allow: APP_CONTROLLERS APP_SERVICES MODULES INGRESS_HANDLERS -->
