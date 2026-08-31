/**
 * The `@Module` decorator — groups controllers and providers under one class.
 *
 * A module is a declaration, not a runtime object. `DecoratorPlugin` flattens
 * activated module trees into the controller and provider lists it already
 * registers; nothing constructs the decorated module class.
 *
 * @module
 */
import type { Constructor } from '@setu-ts/common';

import { classDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassDecorator } from '../metadata/context-bridge.ts';

/**
 * What a `@Module` declares.
 *
 * There is no `exports` member: Setu-TS has one application-wide service
 * registry and optional DI container, not a module visibility boundary.
 *
 * @since 0.2.0
 */
export interface ModuleOptions {
  /** Controller classes this module contributes. */
  readonly controllers?: readonly Constructor[];
  /** Provider classes this module contributes. */
  readonly providers?: readonly Constructor[];
  /** Other modules that this module includes. */
  readonly imports?: readonly Constructor[];
}

/**
 * Groups controllers and providers under one class.
 *
 * Pass this class, or a root module that imports it, to
 * `DecoratorPlugin({ modules })`.
 *
 * @param options - The controllers, providers, and imported modules
 * @returns A standard class decorator
 * @example
 * ```typescript
 * @Module({ controllers: [UsersController], providers: [UsersService] })
 * export class UsersModule {}
 *
 * @Module({ imports: [UsersModule] })
 * export class AppModule {}
 *
 * app.register(DecoratorPlugin({ modules: [AppModule] }));
 * ```
 * @since 0.2.0
 */
export function Module(options: ModuleOptions): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.mergeModule(target, {
      controllers: options.controllers ?? [],
      providers: options.providers ?? [],
      imports: options.imports ?? [],
    });
  });
}
