import { expectTypeOf, it } from 'vitest';
import {
  CAPABILITIES,
  requestService,
  requestServiceToken,
  serviceToken,
} from '../../src/index.ts';
import type { ILogger, IMailer, IServiceRegistry } from '../../src/index.ts';

it('checks every registry overload at compilation', () => {
  const check = (registry: IServiceRegistry, logger: ILogger): void => {
    expectTypeOf(registry.get(CAPABILITIES.LOGGER)).toEqualTypeOf<ILogger>();
    expectTypeOf(registry.getAll(CAPABILITIES.LOGGER)).toEqualTypeOf<readonly ILogger[]>();
    expectTypeOf(registry.get<ILogger>(CAPABILITIES.LOGGER)).toEqualTypeOf<ILogger>();
    expectTypeOf(registry.get<object>(CAPABILITIES.LOGGER)).toEqualTypeOf<object>();
    registry.getAll<ILogger>(CAPABILITIES.LOGGER);
    registry.getAll<object>(CAPABILITIES.LOGGER);
    // @ts-expect-error The logger does not serve mail.
    registry.get<IMailer>(CAPABILITIES.LOGGER);
    // @ts-expect-error A bound service cannot be downcast to an implementation.
    registry.get<ILogger & { privateState: string }>(CAPABILITIES.LOGGER);
    // @ts-expect-error The logger does not serve mail.
    registry.getAll<IMailer>(CAPABILITIES.LOGGER);
    registry.get<{ name: string }>(CAPABILITIES.CLI_COMMAND);
    registry.getAll<{ name: string }>(CAPABILITIES.CLI_COMMAND);
    registry.get<ILogger>('acme.logger');
    registry.getAll<ILogger>('acme.logger');
    const derived = `${CAPABILITIES.LOGGER}.named`;
    registry.get<ILogger>(derived);
    const singleton = serviceToken<ILogger>('app.logger');
    expectTypeOf(registry.get(singleton)).toEqualTypeOf<ILogger>();
    expectTypeOf(registry.getAll(singleton)).toEqualTypeOf<readonly ILogger[]>();
    registry.register(CAPABILITIES.LOGGER, logger);
    registry.register<ILogger>(CAPABILITIES.LOGGER, logger);
    registry.registerFactory(CAPABILITIES.LOGGER, () => logger);
    registry.registerFactory<ILogger>(CAPABILITIES.LOGGER, () => logger);
    registry.register(CAPABILITIES.CLI_COMMAND, { name: 'example' });
    registry.registerFactory(CAPABILITIES.CLI_COMMAND, () => ({ name: 'example' }));
    registry.register(singleton, logger);
    registry.registerFactory(singleton, () => logger);
    registry.register('acme.logger', logger);
    registry.registerFactory('acme.logger', () => logger);
    // @ts-expect-error The bound logger contract is required at registration.
    registry.register(CAPABILITIES.LOGGER, { send: () => Promise.resolve() });
    // @ts-expect-error The bound logger contract is required from the factory.
    registry.registerFactory(CAPABILITIES.LOGGER, () => ({ send: () => Promise.resolve() }));
    // A write must supply the whole bound contract; an empty, partial or wider object is refused.
    const partial = { info: (_message: string): void => undefined };
    type FullLogger = ILogger & { flush(): void };
    // @ts-expect-error An empty object is not a logger.
    registry.register(CAPABILITIES.LOGGER, {});
    // @ts-expect-error A logger with only `info` is not a logger.
    registry.register(CAPABILITIES.LOGGER, partial);
    // @ts-expect-error A wider explicit type cannot register under a bound token.
    registry.register<object>(CAPABILITIES.LOGGER, {});
    // @ts-expect-error An empty factory result is not a logger.
    registry.registerFactory(CAPABILITIES.LOGGER, () => ({}));
    // @ts-expect-error A wider explicit type cannot register a factory under a bound token.
    registry.registerFactory<object>(CAPABILITIES.LOGGER, () => ({}));
    // @ts-expect-error A partial factory result is not a logger.
    registry.registerFactory<typeof partial>(CAPABILITIES.LOGGER, () => partial);
    // An implementation with more than the contract is still accepted.
    registry.register<FullLogger>(CAPABILITIES.LOGGER, Object.assign(logger, { flush() {} }));
    registry.registerFactory<FullLogger>(CAPABILITIES.LOGGER, () =>
      Object.assign(logger, { flush() {} }),
    );
    const request = requestServiceToken<ILogger>('app.request-logger');
    const entry = requestService(() => logger);
    registry.register(request, entry);
    registry.registerFactory(request, () => entry);
    // @ts-expect-error A request token registers a wrapper, not the service itself.
    registry.register(request, logger);
    // @ts-expect-error A request factory must produce a wrapper.
    registry.registerFactory(request, () => logger);
    // @ts-expect-error Raw registry reads cannot resolve a request-bound token.
    registry.get(request);
    // @ts-expect-error Raw registry reads cannot resolve a request-bound token.
    registry.getAll(request);
    // @ts-expect-error An explicit type cannot bypass the request brand.
    registry.get<ILogger>(request);
  };
  expectTypeOf(check).toBeFunction();
});
