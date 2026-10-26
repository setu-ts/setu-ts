/** Compiled dependency injection container and explicit lifetime ownership. @module */
import type {
  ContainerToken,
  IContainer,
  IRequestContext,
  ProbeTiming,
  Provider,
  ProviderOptions,
  ServiceScope,
} from '@setu-ts/common';
import { isPromiseLike, withDeadline } from '@setu-ts/common';
import { Compiler } from './compiler.ts';
import type { ResolutionScope } from './compiler.ts';
import {
  ContainerClosedError,
  RequestScopeUnavailableError,
  ScopeDisposedError,
  ScopeRequiredError,
  tokenName,
} from './errors.ts';
import { ProviderRegistry } from './provider-registry.ts';
import type { ProviderEntry } from './provider-registry.ts';

/** Fixed bound for one asynchronous disposal. @since 0.11.0 */
const DISPOSAL_TIMEOUT_MS = 5000;

/**
 * External resolver used for auto-registration fallback. A subset of
 * {@linkcode IServiceRegistry} — when a token is not in the DI container
 * and `autoRegister` is enabled, the container delegates here.
 *
 * @since 0.1.0
 */
export interface ExternalResolver {
  /**
   * Reports whether the external source can resolve the token.
   *
   * @param token - The capability token
   * @returns `true` if the external source has the token
   */
  has(token: string): boolean;
  /**
   * Resolves a token from the external source.
   *
   * @param token - The capability token
   * @returns The resolved instance
   */
  resolve(token: string): unknown;
}

/**
 * Configuration for constructing a {@linkcode DiContainer}.
 *
 * @since 0.1.0
 */
export interface ContainerConfig {
  /** Default lifecycle scope for providers without an explicit scope. */
  readonly defaultScope: ServiceScope;
  /** Optional external resolver for auto-registration fallback. */
  readonly externalResolver?: ExternalResolver;
  /**
   * When `true`, resolving an unregistered token falls back to the
   * external resolver and caches the result as a singleton.
   */
  readonly autoRegister: boolean;
  /**
   * Timer surface for asynchronous disposal deadlines, inherited by scopes.
   * Omit to use withDeadline's default timers.
   *
   * @since 0.11.0
   */
  readonly timing?: ProbeTiming;
  /**
   * Reports request-scope disposal failures, inherited by scopes. When omitted,
   * deferred cleanup throws or rejects so its caller can report the failure.
   *
   * @since 0.11.0
   */
  readonly reportDisposeError?: (error: unknown) => void;
}

/**
 * A lazily compiled container, open until its owner calls close().
 * @example
 * ```typescript
 * const root = new DiContainer({ defaultScope: "singleton", autoRegister: false });
 * root.register("port", { useValue: 3000 });
 * root.close();
 * const port = root.resolve<number>("port");
 * ```
 *
 * @since 0.1.0
 */
export class DiContainer implements IContainer, ResolutionScope {
  readonly #config: ContainerConfig;
  #registry: ProviderRegistry | undefined;
  #compiler: Compiler | undefined;
  readonly #parent: DiContainer | undefined;
  #requestKey: object | undefined;
  #requests: WeakMap<IRequestContext, IContainer> | undefined;
  #providers: WeakMap<Provider<unknown>, ProviderEntry> | undefined;
  #cleanups:
    | {
        readonly token: ContainerToken;
        readonly run: () => void | Promise<void>;
      }[]
    | undefined;
  #closed = false;
  #disposed = false;
  /** Internal slot storage, allocated on first scoped resolution. @internal */
  slots: unknown[] | undefined;
  /**
   * Instances of scope-local registrations, allocated on first local resolve.
   * @since 0.11.0
   * @internal
   */
  localInstances: Map<ProviderEntry, unknown> | undefined;
  /** Internal owner of singleton instances. @internal */
  readonly root: DiContainer;

  /**
   * @param config - Container defaults and optional external resolver
   *
   * @param parent - Internal parent when constructing a scope
   *
   * @since 0.11.0
   */
  constructor(config: ContainerConfig, parent?: DiContainer) {
    this.#config = config;
    this.#parent = parent;
    this.root = parent?.root ?? this;
    if (parent === undefined) {
      this.#registry = new ProviderRegistry();
      this.#compiler = new Compiler(
        this.#registry,
        config.autoRegister ? config.externalResolver : undefined,
      );
    }
  }

  /** Materializes local registration state without materializing empty ancestors. */
  #ownRegistry(): ProviderRegistry {
    if (this.#registry === undefined) {
      const parent = this.#parent!;
      this.#registry = new ProviderRegistry(() => parent.#activeRegistry());
      this.#compiler = new Compiler(
        this.#registry,
        this.#config.autoRegister ? this.#config.externalResolver : undefined,
        () => parent.#activeCompiler(),
      );
    }
    return this.#registry;
  }

  /** Reads through untouched scopes to the nearest registry with registrations. */
  #activeRegistry(): ProviderRegistry {
    return this.#registry ?? this.#parent!.#activeRegistry();
  }

  /** Reads through untouched scopes without creating compiler or registry state. */
  #activeCompiler(): Compiler {
    return this.#compiler ?? this.#parent!.#activeCompiler();
  }

  /**
   * Registers a provider while open; a scope may add only new leaf tokens.
   * Singleton registrations on a scope are stored as scoped, so their instances
   * and disposals belong to that scope rather than the root.
   *
   * @param token - Identity or string token
   *
   * @param provider - Construction recipe
   *
   * @param options - Lifetime and optional cleanup
   *
   * @returns Nothing
   * @throws {ContainerClosedError} If this container is closed
   * @throws {Error} If the token already exists in this chain
   *
   * @since 0.11.0
   */
  register<T>(token: ContainerToken<T>, provider: Provider<T>, options?: ProviderOptions<T>): void {
    if (this.#closed) throw new ContainerClosedError(token);
    if (this.#parent?.has(token)) {
      throw new Error(
        `DI token '${typeof token === 'string' ? token : token.name}' is already registered.`,
      );
    }
    const requestedScope = options?.scope ?? this.#config.defaultScope;
    const scope =
      this.#parent !== undefined && requestedScope === 'singleton' ? 'scoped' : requestedScope;
    const existing =
      typeof token === 'function' && 'useClass' in provider && provider.useClass === token
        ? this.#providers?.get(provider as Provider<unknown>)
        : undefined;
    const entry: ProviderEntry =
      existing !== undefined && existing.scope === scope
        ? existing
        : {
            provider: provider as Provider<unknown>,
            scope,
            ...(options?.dispose === undefined
              ? {}
              : { dispose: options.dispose as (instance: unknown) => void | Promise<void> }),
          };
    this.#ownRegistry().register(token, entry);
    (this.#providers ??= new WeakMap()).set(provider as Provider<unknown>, entry);
  }

  /**
   * Resolves a token through its compiled graph.
   *
   * @param token - Token carrying the expected value type
   *
   * @returns The resolved instance
   * @throws {ContainerValidationError} If wiring is invalid
   * @throws {ScopeRequiredError} If root resolution reaches a scoped provider or creates a
   * disposable transient outside a singleton dependency graph
   * @throws {ScopeDisposedError} If this scope or its root is disposed
   *
   * @since 0.11.0
   */
  resolve<T>(token: ContainerToken<T>): T {
    if (this.#disposed || this.root.#disposed) throw new ScopeDisposedError(token);
    const compiled = this.#activeCompiler().compile(token);
    if (
      this.#parent === undefined &&
      (compiled.requiresScope || compiled.createsDisposableTransient)
    )
      throw new ScopeRequiredError(token);
    return compiled.resolve(this) as T;
  }

  /**
   * Reports explicit or external availability without constructing anything.
   *
   * @param token - Token to inspect
   *
   * @returns Whether resolution has a provider
   *
   * @since 0.11.0
   */
  has(token: ContainerToken): boolean {
    return this.#activeCompiler().has(token);
  }

  /**
   * Creates an independent scope with inherited compiled providers.
   *
   * @returns A child with fresh scoped slots
   *
   * @since 0.11.0
   */
  createScope(): IContainer {
    return new DiContainer(this.#config, this);
  }

  /**
   * Obtains the request-owned scope and schedules its disposal once.
   *
   * @param ctx - Request context with deferred cleanup
   *
   * @returns The cached scope for this context
   * @throws {RequestScopeUnavailableError} Without ctx.defer; use createTestApp
   *
   * @since 0.11.0
   */
  forRequest(ctx: IRequestContext): IContainer {
    if (ctx.defer === undefined) throw new RequestScopeUnavailableError();
    if (ctx.slot !== undefined) {
      return ctx.slot((this.#requestKey ??= {}), () => this.#createRequestScope(ctx));
    }
    const cached = this.#requests?.get(ctx);
    if (cached !== undefined) return cached;
    const scope = this.#createRequestScope(ctx);
    (this.#requests ??= new WeakMap()).set(ctx, scope);
    return scope;
  }

  /** Creates the scope and keeps observing its disposal beyond kernel cleanup bounds. */
  #createRequestScope(ctx: IRequestContext): IContainer {
    const scope = this.createScope();
    const report = this.#config.reportDisposeError;
    ctx.defer!((): void | Promise<void> => {
      try {
        const pending = scope.dispose();
        // Observe the scope's outcome even after the kernel's cleanup deadline.
        if (report !== undefined && isPromiseLike(pending)) {
          return Promise.resolve(pending).catch(report);
        }
        return pending;
      } catch (error) {
        if (report === undefined) throw error;
        report(error);
      }
    });
    return scope;
  }

  /**
   * Validates all providers without instantiation, then closes registration.
   *
   * @returns Nothing
   * @throws {ContainerValidationError} Listing every graph finding
   *
   * @since 0.11.0
   */
  close(): void {
    this.#activeCompiler().compileAll();
    this.#closed = true;
  }

  /**
   * Internal opaque-factory diagnostics used at bootstrap.
   *
   * @returns Unchecked factory tokens
   *
   * @since 0.11.0
   *
   * @internal
   */
  opaqueTokens(): readonly ContainerToken[] {
    return this.#activeCompiler().opaqueTokens();
  }

  /**
   * Internal ownership hook used only by compiled constructors.
   *
   * @param cleanup - Disposal of a just-created instance
   *
   * @param token - Provider identity used to name a disposal timeout
   *
   * @returns Nothing
   *
   * @since 0.11.0
   *
   * @internal
   */
  track(cleanup: () => void | Promise<void>, token: ContainerToken): void {
    (this.#cleanups ??= []).push({ run: cleanup, token });
  }

  /**
   * Runs all owned cleanups in reverse creation order, once.
   * Each asynchronous disposal has a fixed 5000 ms deadline; timeouts are
   * recorded with the provider's name and later disposals still run. A timed-out
   * disposal's later outcome is ignored. Synchronous disposals remain untimed
   * and synchronous.
   *
   * @returns A promise only when cleanup is asynchronous
   * @throws {AggregateError} After every cleanup runs, if any failed or timed out
   *
   * @since 0.11.0
   */
  dispose(): void | Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#cleanups === undefined) {
      this.slots = undefined;
      this.localInstances = undefined;
      return;
    }
    const errors: unknown[] = [];
    const finish = (): void => {
      this.slots = undefined;
      this.localInstances = undefined;
      this.#cleanups = undefined;
      if (errors.length > 0) throw new AggregateError(errors, 'DI disposal failed');
    };
    const run = (): void | Promise<void> => {
      while (this.#cleanups !== undefined && this.#cleanups.length > 0) {
        const cleanup = this.#cleanups.pop()!;
        try {
          const pending = cleanup.run();
          if (isPromiseLike(pending))
            return withDeadline(() => Promise.resolve(pending), {
              timeoutMs: DISPOSAL_TIMEOUT_MS,
              ...(this.#config.timing === undefined ? {} : { timing: this.#config.timing }),
              onTimeout: () =>
                new Error(
                  `DI disposal of ${tokenName(cleanup.token)} timed out after ${DISPOSAL_TIMEOUT_MS} ms`,
                ),
            })
              .catch((error: unknown) => {
                errors.push(error);
              })
              .then(run);
        } catch (error) {
          errors.push(error);
        }
      }
      finish();
    };
    return run();
  }
}
