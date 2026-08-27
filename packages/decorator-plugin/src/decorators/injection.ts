/**
 * Injection decorators — mark services for registration and declare
 * constructor injection tokens.
 *
 * @module
 */
import type { ServiceScope } from '@setu-ts/common';

import { classDecorator } from '../metadata/context-bridge.ts';
import type { SetuClassDecorator } from '../metadata/context-bridge.ts';

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
 * A constructor dependency: a capability token, or a token wrapped by
 * {@linkcode Optional}.
 *
 * @since 0.2.0
 */
export type InjectToken = string | OptionalToken;

/**
 * A token marked optional by {@linkcode Optional}.
 *
 * @since 0.2.0
 */
export interface OptionalToken {
  /** The capability token to resolve. */
  readonly token: string;
  /** Discriminator marking this dependency as optional. */
  readonly optional: true;
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
export function Injectable(options?: InjectableOptions): SetuClassDecorator {
  return classDecorator((store, target) => {
    store.mergeService(target, options ?? {});
  });
}

/**
 * Declares the constructor injection tokens for a class, one per constructor
 * argument in argument order. The `DecoratorPlugin` resolves each token (from
 * the DI container or the service registry) and passes the results to the
 * constructor.
 *
 * A token is always required: type-inferred injection needs
 * `emitDecoratorMetadata`, which Deno does not support, so parameter types
 * cannot be read.
 *
 * Wrap a token in {@linkcode Optional} to let the argument receive `undefined`
 * when the token has no provider.
 *
 * @param tokens - One entry per constructor argument, in argument order
 * @returns A class decorator
 * @example
 * ```typescript
 * @Injectable()
 * @Inject(CAPABILITIES.DATABASE, Optional(CAPABILITIES.CACHE))
 * class UserRepository {
 *   constructor(private db: Db, private cache?: ICacheService) {}
 * }
 * ```
 * @since 0.1.0
 */
export function Inject(...tokens: readonly InjectToken[]): SetuClassDecorator {
  const names = tokens.map((t) => (typeof t === 'string' ? t : t.token));
  const optional = tokens.reduce<number[]>((acc, t, index) => {
    if (typeof t !== 'string') {
      acc.push(index);
    }
    return acc;
  }, []);
  return classDecorator((store, target) => {
    store.mergeService(target, { inject: names });
    // Replaces rather than accumulates: `mergeService` replaces `inject`, so two
    // stacked `@Inject(...)` decorators must not leave the winner's token list
    // paired with the loser's optional indices.
    store.setCtorOptional(target, optional);
  });
}

/**
 * Marks a constructor dependency as optional: when the token has no provider,
 * the argument receives `undefined` instead of failing construction.
 *
 * Used inside {@linkcode Inject}, in the position of the argument it describes.
 *
 * `Optional` means the dependency is **absent**, not that construction may
 * fail: a token that IS provided is resolved normally, and an error thrown
 * while building it — a circular dependency, a throwing factory — propagates
 * rather than being swallowed into `undefined`.
 *
 * Honored identically on both construction paths: the DI container when one is
 * registered, and the kernel's service registry otherwise.
 *
 * @param token - The capability token to resolve when a provider exists
 * @returns An optional-token marker for use inside `@Inject`
 * @example
 * ```typescript
 * @Injectable()
 * @Inject(CAPABILITIES.DATABASE, Optional(CAPABILITIES.CACHE))
 * class ReportService {
 *   constructor(private db: Db, private cache?: ICacheService) {}
 * }
 * ```
 * @since 0.2.0
 */
export function Optional(token: string): OptionalToken {
  return { token, optional: true };
}
