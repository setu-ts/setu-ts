/**
 * Circular dependency detector — tracks the active resolution chain and
 * throws when a token appears twice, indicating a dependency cycle.
 *
 * One detector instance tracks each compiler walk. Because {@linkcode enter}/{@linkcode leave} are balanced in a
 * `try`/`finally`, the stack is empty between top-level resolutions, so cycles
 * like `A → B → A` are caught at the point they recur without leaking state
 * into the next resolve.
 *
 * @module
 */

import type { ContainerToken } from '@setu-ts/common';
import { tokenName } from './errors.ts';

/**
 * Detects circular dependencies during graph compilation.
 *
 * Maintains an ordered stack (for readable error messages) and a set
 * (for O(1) membership checks).
 *
 * @since 0.1.0
 */
export class CircularDetector {
  readonly #stack: ContainerToken[] = [];
  readonly #active: Set<ContainerToken> = new Set();

  /**
   * Marks a token as currently being resolved.
   *
   * @param token - The token entering resolution
   *
   * @returns Nothing
   * @throws {Error} If the token is already in the resolution chain
   *
   * @since 0.11.0
   */
  enter(token: ContainerToken): void {
    if (this.#active.has(token)) {
      const start = this.#stack.indexOf(token);
      const cycle = this.#stack.slice(start).concat(token).map(tokenName).join(' → ');
      throw new Error(`Circular dependency detected: ${cycle}`);
    }
    this.#stack.push(token);
    this.#active.add(token);
  }

  /**
   * Removes the most recently entered token from the resolution chain.
   */
  leave(): void {
    const token = this.#stack.pop();
    if (token !== undefined) {
      this.#active.delete(token);
    }
  }

  /**
   * Reports whether any tokens are currently being resolved.
   *
   * @returns `true` if the resolution stack is non-empty
   */
  get isActive(): boolean {
    return this.#stack.length > 0;
  }
}
