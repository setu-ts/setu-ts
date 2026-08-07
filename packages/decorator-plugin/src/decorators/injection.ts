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
 * Declares a constructor injection token. The `DecoratorPlugin` resolves each
 * token (from the DI container or service registry) and passes the results to
 * the constructor.
 *
 * Usable in two positions:
 *
 * - **On a constructor parameter** (preferred) — one token per parameter, bound
 *   to that argument by position, so reordering the constructor cannot
 *   misinject. This is the form a NestJS reader expects.
 * - **On the class** (deprecated) — a positional token list matching the
 *   constructor's arguments.
 *
 * A token is always required: type-inferred injection needs
 * `emitDecoratorMetadata`, which Deno does not support, so parameter types
 * cannot be read.
 *
 * The two forms are mutually exclusive; a class carrying both fails at
 * `register()` rather than silently preferring one.
 *
 * @param tokens - Capability tokens to inject. Exactly one in the parameter
 * position; one per constructor argument in the (deprecated) class position.
 * @returns A decorator valid in either the class or the constructor-parameter
 * position
 * @throws {Error} When used on a method parameter (only constructor parameters
 * are injected), or when the parameter position receives anything other than
 * exactly one token.
 * @example Parameter position — preferred
 * ```typescript
 * @Injectable()
 * class UserRepository {
 *   constructor(
 *     @Inject(CAPABILITIES.DATABASE) private db: Db,
 *     @Inject(CAPABILITIES.LOGGER) private logger: ILogger,
 *   ) {}
 * }
 * ```
 * @example Class position — deprecated, still supported
 * ```typescript
 * @Injectable()
 * @Inject('database', 'logger')
 * class UserRepository {
 *   constructor(db: Db, logger: ILogger) { … }
 * }
 * ```
 * @since 0.1.0
 */
export function Inject(...tokens: string[]): ClassDecorator & ParameterDecorator {
  const decorator = (
    target: object,
    propertyKey?: string | symbol,
    parameterIndex?: number,
  ): void => {
    // A class decorator receives one argument; a parameter decorator receives
    // three, the third being the argument index.
    if (typeof parameterIndex === 'number') {
      if (propertyKey !== undefined) {
        throw new Error(
          `@Inject is only valid on a constructor parameter, but was applied to parameter ` +
            `${parameterIndex} of method "${String(propertyKey)}". Method parameters are bound ` +
            `with @Body/@Query/@Param/@Headers instead.`,
        );
      }
      if (tokens.length !== 1) {
        throw new Error(
          `@Inject on a constructor parameter takes exactly one token, but received ` +
            `${tokens.length}. One token per parameter.`,
        );
      }
      metadataStore.mergeCtorParam(target as Constructor, parameterIndex, tokens[0] as string);
      return;
    }
    metadataStore.mergeService(target as unknown as Constructor, { inject: tokens });
  };

  return decorator as unknown as ClassDecorator & ParameterDecorator;
}

/**
 * Marks a constructor parameter as optional: when its `@Inject` token has no
 * provider, the argument receives `undefined` instead of failing construction.
 *
 * Pairs with `@Inject` on the same parameter and never replaces it — a token is
 * still required, because type-inferred injection needs `emitDecoratorMetadata`
 * (unsupported on Deno). The two may be written in either order.
 *
 * `@Optional` means the dependency is **absent**, not that construction may
 * fail: a token that IS provided is resolved normally, and an error thrown
 * while building it — a circular dependency, a throwing factory — propagates
 * rather than being swallowed into `undefined`.
 *
 * Honored identically on both construction paths: the DI container when one is
 * registered, and the kernel's service registry otherwise.
 *
 * @returns A constructor-parameter decorator
 * @throws {Error} When used on a method parameter — only constructor parameters
 * are injected.
 * @example
 * ```typescript
 * @Injectable()
 * class ReportService {
 *   constructor(
 *     @Inject(CAPABILITIES.DATABASE) private db: Db,
 *     @Optional() @Inject(CAPABILITIES.CACHE) private cache?: ICacheService,
 *   ) {}
 * }
 * ```
 * @since 0.2.0
 */
export function Optional(): ParameterDecorator {
  return (target: object, propertyKey?: string | symbol, parameterIndex?: number): void => {
    if (propertyKey !== undefined) {
      throw new Error(
        `@Optional is only valid on a constructor parameter, but was applied to parameter ` +
          `${String(parameterIndex)} of method "${String(propertyKey)}". Method parameters are ` +
          `bound with @Body/@Query/@Param/@Header instead.`,
      );
    }
    metadataStore.mergeCtorOptional(target as Constructor, parameterIndex as number);
  };
}
