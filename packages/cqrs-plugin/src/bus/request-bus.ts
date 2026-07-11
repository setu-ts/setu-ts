/**
 * Internal shared request bus implementation.
 *
 * INTERNAL: not exported from the barrel.
 *
 * @module
 */
import type { CqrsRequest, IPipelineBehavior } from '@hono-enterprise/common';
import { composePipeline } from '../behaviors/pipeline-behavior.ts';
import { HandlerNotFoundError } from '../errors/handler-not-found.ts';

/**
 * Internal handler adapter type (type-erased).
 */
type ErasedHandler = (request: CqrsRequest) => Promise<unknown>;

/**
 * Internal shared bus for commands and queries.
 *
 * Provides handler registration, pipeline composition, and execution.
 *
 * @since 0.1.0
 */
export class RequestBus {
  private readonly handlers = new Map<string, ErasedHandler>();

  /**
   * Creates a new request bus.
   *
   * @param behaviors - Behaviors to apply to every execution (default: `[]`)
   */
  constructor(private readonly behaviors: readonly IPipelineBehavior[] = []) {}

  /**
   * Registers a handler for a request type.
   *
   * @param type - The request type name
   * @param handler - The handler function
   */
  registerHandler(type: string, handler: ErasedHandler): void {
    this.handlers.set(type, handler);
  }

  /**
   * Executes a request through the pipeline.
   *
   * @param request - The request to execute
   * @returns The result of the terminal handler
   * @throws {TypeError} if `request.type` is not a string
   * @throws {HandlerNotFoundError} if no handler is registered for the type
   */
  execute<TResult>(request: CqrsRequest): Promise<TResult> {
    if (typeof request.type !== 'string') {
      throw new TypeError('CQRS request must have a string `type`.');
    }

    const handler = this.handlers.get(request.type);
    if (handler === undefined) {
      throw new HandlerNotFoundError(request.type);
    }

    return composePipeline(request, this.behaviors, () => handler(request)) as Promise<TResult>;
  }

  /**
   * The number of registered handlers.
   */
  get handlerCount(): number {
    return this.handlers.size;
  }

  /**
   * Clears all registered handlers.
   */
  clear(): void {
    this.handlers.clear();
  }
}
