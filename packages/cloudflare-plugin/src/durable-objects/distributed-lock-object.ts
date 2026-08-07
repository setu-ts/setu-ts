/**
 * The Durable Object side of the distributed lock.
 *
 * @module
 * @since 0.2.0
 */

import type { IDurableObjectState } from './do-facades.ts';

/** The persisted holder record, one per lock key. */
interface LockHolder {
  /** The token handed to whoever acquired the lock. */
  readonly token: string;
  /** Wall-clock deadline, in epoch milliseconds. */
  readonly expiresAt: number;
}

/** The storage key one lock key maps to. Namespaced so a future */
/** per-object record cannot collide with a lock key literally named 'holder'. */
const HOLDER_KEY = 'lock:holder';

/**
 * Options for {@linkcode DistributedLockObjectCore}.
 *
 * @since 0.2.0
 */
export interface DistributedLockObjectCoreOptions {
  /**
   * Wall-clock source, in epoch milliseconds. Defaults to `Date.now`.
   *
   * This is the one place in the package that reads a clock directly, and the
   * deviation from AI_GUIDELINES §4.2 is deliberate: a Durable Object is
   * constructed by the platform as `(state, env)`, with no plugin context and
   * therefore no route to `IRuntimeServices`. This class IS the runtime
   * boundary for the object, in the same sense `packages/runtime` is for a
   * Worker. Injecting the seam is what keeps expiry testable without waiting.
   */
  readonly now?: () => number;
}

/**
 * Serializes lock acquisition for one key.
 *
 * One Durable Object per lock key, and a Durable Object executes one request at
 * a time — which is what makes the read-compare-write below atomic without a
 * transaction, and what makes this a genuine distributed lock rather than a
 * best-effort one.
 *
 * The holder record lives in `state.storage`, never in a field. A Durable
 * Object is evicted after 70–140 seconds of inactivity when it cannot
 * hibernate, and a lock TTL routinely outlives that; a deadline held in memory
 * would evaporate on eviction and hand the same lock to a second holder, which
 * is precisely the failure a distributed lock exists to prevent.
 *
 * @example
 * ```typescript
 * import { DurableObject } from 'cloudflare:workers';
 * import { DistributedLockObjectCore } from '@setu-ts/cloudflare-plugin';
 *
 * export class DistributedLockObject extends DurableObject {
 *   #core = new DistributedLockObjectCore(this.ctx);
 *
 *   override fetch(request: Request): Promise<Response> {
 *     return this.#core.fetch(request);
 *   }
 * }
 * ```
 * @since 0.2.0
 */
export class DistributedLockObjectCore {
  readonly #state: IDurableObjectState;
  readonly #now: () => number;

  /**
   * @param state - The Durable Object's `ctx`
   * @param options - Optional seams; the defaults are the deployment path
   */
  constructor(state: IDurableObjectState, options: DistributedLockObjectCoreOptions = {}) {
    this.#state = state;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Routes one lock operation.
   *
   * @param request - The request {@linkcode DurableObjectLock} sent
   * @returns The operation's JSON result, or a 404 for an unknown path
   */
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/acquire') {
      const body = (await request.json()) as { token: string; ttlMs: number };
      return Response.json({ token: await this.#acquire(body.token, body.ttlMs) });
    }
    if (pathname === '/release') {
      const body = (await request.json()) as { token: string };
      await this.#release(body.token);
      return Response.json({ released: true });
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * Claims the lock when it is free or the current holder has expired.
   *
   * @param token - The candidate token, minted by the caller
   * @param ttlMs - How long the claim lasts
   * @returns The token when acquired, or `null` when another holder is live
   */
  async #acquire(token: string, ttlMs: number): Promise<string | null> {
    const held = await this.#state.storage.get<LockHolder>(HOLDER_KEY);
    const now = this.#now();
    // `>` not `>=`: a holder whose deadline is exactly now has expired.
    if (held !== undefined && held.expiresAt > now) {
      return null;
    }
    await this.#state.storage.put<LockHolder>(HOLDER_KEY, { token, expiresAt: now + ttlMs });
    return token;
  }

  /**
   * Releases the lock, but only for the holder that owns it.
   *
   * The token comparison is what stops a caller whose lock already expired —
   * and was since re-acquired by someone else — from releasing the new holder's
   * claim.
   *
   * @param token - The token the caller received from `acquire`
   */
  async #release(token: string): Promise<void> {
    const held = await this.#state.storage.get<LockHolder>(HOLDER_KEY);
    if (held === undefined || held.token !== token) {
      return;
    }
    await this.#state.storage.delete(HOLDER_KEY);
  }
}
