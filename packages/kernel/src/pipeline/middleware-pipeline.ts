/**
 * Middleware pipeline — ASP.NET Core-style ordered execution with priority
 * bands, short-circuiting, and double-next protection.
 *
 * @module
 */
import type {
  IMiddlewareApi,
  IRequestContext,
  MiddlewareFunction,
  MiddlewareOptions,
} from '@hono-enterprise/common';

interface MiddlewareEntry {
  fn: MiddlewareFunction;
  priority: number;
  name: string;
  index: number;
}

const DEFAULT_PRIORITY = 500;

/**
 * Middleware pipeline: collect middleware with priorities, compile into a
 * sorted chain, then execute with classic next()-chaining semantics.
 */
export class MiddlewarePipeline implements IMiddlewareApi {
  readonly #entries: MiddlewareEntry[] = [];
  #compiled: MiddlewareFunction[] | null = null;

  add(middleware: MiddlewareFunction, options?: MiddlewareOptions): void {
    if (this.#compiled !== null) {
      throw new Error('Cannot add middleware after the pipeline has been compiled.');
    }
    this.#entries.push({
      fn: middleware,
      priority: options?.priority ?? DEFAULT_PRIORITY,
      name: options?.name ?? `<anonymous-${this.#entries.length}>`,
      index: this.#entries.length,
    });
  }

  /**
   * Sorts middleware stably by (priority, insertion order) and freezes the
   * chain. After calling, no further middleware may be added.
   */
  compile(): readonly MiddlewareFunction[] {
    if (this.#compiled !== null) {
      return this.#compiled;
    }
    const sorted = [...this.#entries].sort(
      (a, b) => a.priority - b.priority || a.index - b.index,
    );
    this.#compiled = sorted.map((entry) => entry.fn);
    return this.#compiled;
  }

  /**
   * Executes the compiled pipeline using classic next()-chaining.
   *
   * @param ctx - The request context
   * @param terminal - Called when all middleware have completed
   * @throws {Error} If next() is called multiple times in a single middleware
   */
  async execute(ctx: IRequestContext, terminal: () => Promise<void>): Promise<void> {
    const chain = this.#compiled ?? this.compile();
    let index = 0;

    const run = async (): Promise<void> => {
      if (index >= chain.length) {
        await terminal();
        return;
      }
      const fn = chain[index];
      index++;
      let nextCalled = false;
      const next: () => Promise<void> = () => {
        if (nextCalled) {
          throw new Error(`next() called multiple times in middleware ${fn.name ?? '<anonymous>'}`);
        }
        nextCalled = true;
        return run();
      };
      await fn(ctx, next);
    };

    await run();
  }
}
