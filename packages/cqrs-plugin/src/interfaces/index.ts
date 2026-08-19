/**
 * CQRS plugin options and interfaces.
 *
 * @module
 */
import type {
  ICommandHandler,
  IPipelineBehavior,
  IQueryHandler,
  RegistryFactory,
} from '@setu-ts/common';

/**
 * One command handler and the command type the bus routes to it.
 *
 * A PAIR rather than a bare handler because that is exactly what
 * `ICommandBus.register(type, handler)` takes: the type is a string the command
 * carries, and deriving it from the handler's class name would invent a second source
 * of truth for the same value.
 *
 * The handler is typed at `ICommandHandler`'s defaults (`CqrsCommand`, `unknown`) so a
 * heterogeneous list of concretely-typed handlers is assignable without `any`:
 * `handle` is declared with METHOD syntax, so TypeScript compares its parameter
 * bivariantly even under `strictFunctionTypes`.
 *
 * @since 0.1.0
 */
export interface CommandHandlerRegistration {
  /** Command type name, matching `command.type`. */
  readonly type: string;
  /**
   * The handler to register for that type, or a factory that builds one from
   * the service registry.
   *
   * An instance registers on the bus during `register()`. A factory is called
   * at the `onInit` phase — after every plugin has registered — and its result
   * is registered under this entry's `type`, so it can resolve a capability
   * (the event bus, the logger) its contract's message parameter cannot carry.
   */
  readonly handler: ICommandHandler | RegistryFactory<ICommandHandler>;
}

/**
 * One query handler and the query type the bus routes to it.
 *
 * @see {@linkcode CommandHandlerRegistration} for why the handler is typed at the
 * interface's defaults.
 *
 * @since 0.1.0
 */
export interface QueryHandlerRegistration {
  /** Query type name, matching `query.type`. */
  readonly type: string;
  /**
   * The handler to register for that type, or a factory that builds one from
   * the service registry.
   *
   * See {@linkcode CommandHandlerRegistration.handler} for the instance and
   * factory arms and their timing.
   */
  readonly handler: IQueryHandler | RegistryFactory<IQueryHandler>;
}

/**
 * Options for {@linkcode CqrsPlugin}.
 *
 * @since 0.1.0
 */
export interface CqrsPluginOptions {
  /**
   * Command handlers registered on the command bus at `register()` time.
   *
   * The declarative alternative to resolving `CAPABILITIES.COMMAND_BUS` and calling
   * `register` imperatively — which application code has no phase to do, since
   * `IApplication` exposes no lifecycle hooks and the bus does not exist until the
   * plugin has registered.
   *
   * Default: `[]` (no handlers).
   *
   * @since 0.1.0
   */
  commandHandlers?: readonly CommandHandlerRegistration[];
  /**
   * Query handlers registered on the query bus at `register()` time.
   *
   * Default: `[]` (no handlers).
   *
   * @since 0.1.0
   */
  queryHandlers?: readonly QueryHandlerRegistration[];
  /**
   * Pipeline behaviors applied to every command and query execution.
   *
   * Behaviors are invoked in declared order. Each behavior receives the
   * request and a `next()` function; returning without calling `next()`
   * short-circuits the pipeline (the handler and later behaviors do not run).
   *
   * An entry is either a behavior instance or a factory that builds one from
   * the service registry. At the `onInit` phase the WHOLE list is resolved in
   * declared order and installed on both buses, so a mixed list runs in
   * declared order — not instances-then-factories.
   *
   * Default: `[]` (no behaviors).
   */
  behaviors?: readonly (IPipelineBehavior | RegistryFactory<IPipelineBehavior>)[];
}
