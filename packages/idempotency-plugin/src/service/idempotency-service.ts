/**
 * The idempotency service: one implementation behind both HTTP entry points
 * (plan §3.9, §3.14).
 *
 * @module
 */
import type {
  IdempotentIngressOptions,
  IdempotentRouteOptions,
  IdempotentWithinOptions,
  IdempotentWithinResult,
  IIdempotencyService,
  IIdempotencyStore,
  IIngressBehavior,
  ILogger,
  IRuntimeServices,
  MiddlewareFunction,
} from '@setu-ts/common';
import type { IdempotencyDefaults } from '../core/options.ts';
import { resolveIngressOptions, resolveRouteOptions } from '../core/options.ts';
import { IdempotencyConfigurationError } from '../errors.ts';
import { createIngressBehavior } from '../ingress/ingress-behavior.ts';
import { createHttpMiddleware } from '../middleware/http-middleware.ts';
import type { TransactionalRuntimeState } from '../within/transactional-runtime.ts';
import { purgeOnce } from '../within/transactional-runtime.ts';
import type { WithinDeps } from '../within/within.ts';
import { runWithin } from '../within/within.ts';

/** Everything the service needs, resolved once at `register()`. */
export interface ServiceDeps {
  /** The store. */
  readonly store: IIdempotencyStore;
  /** The runtime services (clock, uuid, subtle). */
  readonly runtime: IRuntimeServices;
  /** The logger thunk, read at call time. */
  readonly logger: () => ILogger | undefined;
  /** The plugin-level defaults. */
  readonly defaults: IdempotencyDefaults;
  /** The active tier-C state, or `undefined` until the plugin's `onInit` set it. */
  readonly transactional?: () => TransactionalRuntimeState | undefined;
}

/** The `within` dependencies derived from the service's own. */
function withinDeps(deps: ServiceDeps, state: TransactionalRuntimeState): WithinDeps {
  return {
    store: state.store,
    runtime: deps.runtime,
    logger: deps.logger,
    ttlMs: state.ttlMs,
    storeTimeoutMs: state.storeTimeoutMs,
    maxResultBytes: state.maxResultBytes,
  };
}

/**
 * The service registered under `CAPABILITIES.IDEMPOTENCY`.
 *
 * @since 0.9.0
 */
export class IdempotencyService implements IIdempotencyService {
  readonly #deps: ServiceDeps;

  /**
   * @param deps - The resolved dependencies
   */
  constructor(deps: ServiceDeps) {
    this.#deps = deps;
  }

  /** @inheritdoc */
  middleware(options?: IdempotentRouteOptions): MiddlewareFunction {
    const resolved = resolveRouteOptions(options, this.#deps.defaults);
    return createHttpMiddleware(this.#deps, resolved);
  }

  /** @inheritdoc */
  behavior(options: IdempotentIngressOptions): IIngressBehavior {
    const resolved = resolveIngressOptions(options, this.#deps.defaults);
    return createIngressBehavior(this.#deps, resolved);
  }

  /** @inheritdoc */
  within<R, S = unknown>(
    options: IdempotentWithinOptions,
    fn: (scope: S) => Promise<R>,
  ): Promise<IdempotentWithinResult<R>> {
    const state = this.#deps.transactional?.();
    if (state === undefined) {
      return Promise.reject(
        new IdempotencyConfigurationError(
          'transactional',
          'idempotency: within requires the transactional option',
        ),
      );
    }
    return runWithin<R, S>(withinDeps(this.#deps, state), options, fn);
  }

  /** @inheritdoc */
  purgeTransactional(): Promise<number> {
    const state = this.#deps.transactional?.();
    if (state === undefined) {
      return Promise.reject(
        new IdempotencyConfigurationError(
          'transactional',
          'idempotency: purgeTransactional requires the transactional option',
        ),
      );
    }
    return purgeOnce(state, this.#deps.logger, this.#deps.runtime);
  }
}
