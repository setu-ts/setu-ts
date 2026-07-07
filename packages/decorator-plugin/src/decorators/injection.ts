/**
 * Injection decorators — mark services for registration and declare
 * constructor injection tokens.
 *
 * @module
 */
import type { Constructor, ServiceScope } from '@hono-enterprise/common';

import { metadataStore } from '../metadata/metadata-store.ts';

/**
 * Options for {@linkcode Injectable}.
 *
 * @since 0.1.0
 */
export interface InjectableOptions {
  /** Lifecycle scope. */
  readonly scope?: ServiceScope;
  /** Capability token to register the service under. */
  readonly token?: string;
}

/**
 * Marks a class as injectable (eligible for DI container registration). When
 * the `DecoratorPlugin` runs, injectable classes in its `services` list (or
 * discovered) are registered with the DI container when present, or
 * instantiated directly otherwise.
 *
 * @param options - Optional scope and token
 * @returns A class decorator
 * @example
 * ```typescript
 * @Injectable({ scope: 'singleton', token: 'user-service' })
 * class UserService { … }
 * ```
 * @since 0.1.0
 */
export function Injectable(options?: InjectableOptions): ClassDecorator {
  return (target) => {
    metadataStore.mergeService(target as unknown as Constructor, options ?? {});
    return target;
  };
}

/**
 * Declares constructor injection tokens, in argument order. The
 * `DecoratorPlugin` resolves each token (from the DI container or service
 * registry) and passes the results to the constructor.
 *
 * @param tokens - Capability tokens to inject
 * @returns A class decorator
 * @example
 * ```typescript
 * @Injectable()
 * @Inject('database', 'logger')
 * class UserRepository {
 *   constructor(db: Db, logger: ILogger) { … }
 * }
 * ```
 * @since 0.1.0
 */
export function Inject(...tokens: string[]): ClassDecorator {
  return (target) => {
    metadataStore.mergeService(target as unknown as Constructor, { inject: tokens });
    return target;
  };
}
