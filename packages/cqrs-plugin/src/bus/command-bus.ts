/**
 * Command bus implementation.
 *
 * @module
 */
import type {
  CqrsCommand,
  ICommandBus,
  ICommandHandler,
  IPipelineBehavior,
} from '@hono-enterprise/common';
import { RequestBus } from './request-bus.ts';

/**
 * Concrete command bus implementing {@linkcode ICommandBus}.
 *
 * @since 0.1.0
 */
export class CommandBus implements ICommandBus {
  private readonly bus: RequestBus;

  /**
   * Creates a new command bus.
   *
   * @param behaviors - Behaviors to apply to every command execution (default: `[]`)
   */
  constructor(behaviors: readonly IPipelineBehavior[] = []) {
    this.bus = new RequestBus(behaviors);
  }

  /**
   * Registers a command handler.
   *
   * @param type - The command type name
   * @param handler - The command handler
   */
  register<TCommand extends CqrsCommand, TResult>(
    type: string,
    handler: ICommandHandler<TCommand, TResult>,
  ): void {
    this.bus.registerHandler(type, (req) => Promise.resolve(handler.handle(req as TCommand)));
  }

  /**
   * Executes a command.
   *
   * @param command - The command to execute
   * @returns The handler's result
   */
  execute<TResult = unknown>(command: CqrsCommand): Promise<TResult> {
    return this.bus.execute<TResult>(command);
  }

  /**
   * The number of registered command handlers.
   *
   * INTERNAL: not part of the `ICommandBus` interface.
   */
  get handlerCount(): number {
    return this.bus.handlerCount;
  }

  /**
   * Clears all registered command handlers.
   *
   * INTERNAL: not part of the `ICommandBus` interface.
   */
  clear(): void {
    this.bus.clear();
  }
}
