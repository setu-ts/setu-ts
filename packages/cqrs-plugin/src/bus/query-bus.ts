/**
 * Query bus implementation.
 *
 * @module
 */
import type {
  CqrsQuery,
  IPipelineBehavior,
  IQueryBus,
  IQueryHandler,
} from '@hono-enterprise/common';
import { RequestBus } from './request-bus.ts';

/**
 * Concrete query bus implementing {@linkcode IQueryBus}.
 *
 * @since 0.1.0
 */
export class QueryBus implements IQueryBus {
  private readonly bus: RequestBus;

  /**
   * Creates a new query bus.
   *
   * @param behaviors - Behaviors to apply to every query execution (default: `[]`)
   */
  constructor(behaviors: readonly IPipelineBehavior[] = []) {
    this.bus = new RequestBus(behaviors);
  }

  /**
   * Registers a query handler.
   *
   * @param type - The query type name
   * @param handler - The query handler
   */
  register<TQuery extends CqrsQuery, TResult>(
    type: string,
    handler: IQueryHandler<TQuery, TResult>,
  ): void {
    this.bus.registerHandler(type, (req) => Promise.resolve(handler.handle(req as TQuery)));
  }

  /**
   * Executes a query.
   *
   * @param query - The query to execute
   * @returns The handler's result
   */
  execute<TResult = unknown>(query: CqrsQuery): Promise<TResult> {
    return this.bus.execute<TResult>(query);
  }

  /**
   * The number of registered query handlers.
   *
   * INTERNAL: not part of the `IQueryBus` interface.
   */
  get handlerCount(): number {
    return this.bus.handlerCount;
  }

  /**
   * Clears all registered query handlers.
   *
   * INTERNAL: not part of the `IQueryBus` interface.
   */
  clear(): void {
    this.bus.clear();
  }
}
