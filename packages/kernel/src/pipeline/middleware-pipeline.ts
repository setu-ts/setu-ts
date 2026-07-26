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

import { executeChain } from './execute-chain.ts';

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
  /** Diagnostic names, positionally matching {@linkcode MiddlewarePipeline.compile}'s output. */
  #compiledNames: string[] | null = null;

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
    this.#compiledNames = sorted.map((entry) => entry.name);
    return this.#compiled;
  }

  /**
   * Diagnostic names of the compiled chain, in execution order.
   *
   * Each entry is the `name` passed through {@linkcode MiddlewareOptions}, or a
   * generated `<anonymous-N>` placeholder. Returns an empty array before
   * {@linkcode MiddlewarePipeline.compile} runs.
   *
   * @returns The compiled stage names, positionally matching the compiled chain
   * @internal Diagnostics seam — the kernel passes these to `executeChain` so a
   * double-`next()` error can name the offending stage.
   */
  compiledNames(): readonly string[] {
    return this.#compiledNames ?? [];
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
    await executeChain(chain, ctx, terminal, this.compiledNames());
  }
}
