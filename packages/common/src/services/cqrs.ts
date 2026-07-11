/**
 * CQRS contracts: request/handler/bus/facade/behavior interfaces.
 *
 * Implemented by the CQRS plugin under `CAPABILITIES.CQRS`, `COMMAND_BUS`,
 * and `QUERY_BUS`. This module defines the types; the plugin provides the
 * runtime behavior.
 *
 * @module
 */

/**
 * A CQRS request identified by a string `type` and carrying typed `data`.
 *
 * Commands and queries are marker subtypes (semantic separation only — same shape).
 *
 * @typeParam TData - The payload type
 * @since 0.1.0
 */
export interface CqrsRequest<TData = unknown> {
  /** Request type name (e.g. `"CreateUser"`). Used for routing. */
  readonly type: string;
  /** The request payload. */
  readonly data: TData;
}

/**
 * A command: a request that mutates state and returns a result.
 *
 * @typeParam TData - The command payload type
 * @since 0.1.0
 */
export interface CqrsCommand<TData = unknown> extends CqrsRequest<TData> {}

/**
 * A query: a request that returns data without side effects.
 *
 * @typeParam TData - The query payload type
 * @since 0.1.0
 */
export interface CqrsQuery<TData = unknown> extends CqrsRequest<TData> {}

/**
 * Handles one command type.
 *
 * @typeParam TCommand - The command type
 * @typeParam TResult - The result type
 * @since 0.1.0
 */
export interface CqrsCommandHandler<TCommand extends CqrsCommand = CqrsCommand, TResult = unknown> {
  /**
   * Executes the command.
   *
   * @param command - The command to handle
   * @returns A result (sync or async)
   */
  handle(command: TCommand): TResult | Promise<TResult>;
}

/**
 * Handles one query type.
 *
 * @typeParam TQuery - The query type
 * @typeParam TResult - The result type
 * @since 0.1.0
 */
export interface CqrsQueryHandler<TQuery extends CqrsQuery = CqrsQuery, TResult = unknown> {
  /**
   * Executes the query.
   *
   * @param query - The query to handle
   * @returns A result (sync or async)
   */
  handle(query: TQuery): TResult | Promise<TResult>;
}

/**
 * Wraps a handler with cross-cutting logic (logging, timing, validation, etc.).
 *
 * Behaviors are typed to `CqrsRequest` so they can read `request.type`/`request.data`
 * type-safely without `any`.
 *
 * @typeParam TRequest - The request type (must extend `CqrsRequest`)
 * @typeParam TResult - The result type
 * @since 0.1.0
 */
export interface CqrsPipelineBehavior<
  TRequest extends CqrsRequest = CqrsRequest,
  TResult = unknown,
> {
  /**
   * Wraps the next handler in the pipeline.
   *
   * @param request - The request being handled
   * @param next - The next handler (or terminal handler)
   * @returns The result (sync or async)
   */
  handle(request: TRequest, next: () => Promise<TResult>): TResult | Promise<TResult>;
}

/**
 * Registers and executes commands.
 *
 * @since 0.1.0
 */
export interface ICommandBus {
  /**
   * Registers a handler for a command type.
   *
   * @typeParam TCommand - The command type
   * @typeParam TResult - The result type
   * @param type - Command type name (must match `command.type`)
   * @param handler - The command handler
   */
  register<TCommand extends CqrsCommand, TResult>(
    type: string,
    handler: CqrsCommandHandler<TCommand, TResult>,
  ): void;

  /**
   * Executes a command.
   *
   * @typeParam TResult - The expected result type
   * @param command - The command to execute
   * @returns The handler's result
   * @throws {HandlerNotFoundError} (from the plugin) if no handler is registered for `command.type`
   * @throws {TypeError} if `command.type` is not a string
   */
  execute<TResult = unknown>(command: CqrsCommand): Promise<TResult>;
}

/**
 * Registers and executes queries.
 *
 * @since 0.1.0
 */
export interface IQueryBus {
  /**
   * Registers a handler for a query type.
   *
   * @typeParam TQuery - The query type
   * @typeParam TResult - The result type
   * @param type - Query type name (must match `query.type`)
   * @param handler - The query handler
   */
  register<TQuery extends CqrsQuery, TResult>(
    type: string,
    handler: CqrsQueryHandler<TQuery, TResult>,
  ): void;

  /**
   * Executes a query.
   *
   * @typeParam TResult - The expected result type
   * @param query - The query to execute
   * @returns The handler's result
   * @throws {HandlerNotFoundError} (from the plugin) if no handler is registered for `query.type`
   * @throws {TypeError} if `query.type` is not a string
   */
  execute<TResult = unknown>(query: CqrsQuery): Promise<TResult>;
}

/**
 * Facade combining command and query buses.
 *
 * Registered under `CAPABILITIES.CQRS` so the `'cqrs'` token backs a real service.
 *
 * @since 0.1.0
 */
export interface ICqrsFacade {
  /** The command bus. */
  readonly commandBus: ICommandBus;
  /** The query bus. */
  readonly queryBus: IQueryBus;
}
