/**
 * Bounded-concurrency iteration.
 *
 * `ProcessOptions.concurrency` is a committed option ("jobs processed
 * concurrently by this worker"), and a Cloudflare batch arrives as an array of
 * messages for the same handler — so honouring it means running at most N of
 * that batch's messages at a time. Storing the option without applying it is
 * the dead-option defect, and running the whole batch at once ignores a limit
 * an application set for a reason (a rate-limited upstream, an R2 write budget).
 *
 * @module
 */

/**
 * Runs `fn` over every item, never more than `limit` at a time.
 *
 * **Every item runs even when an earlier one rejects.** A queue batch is a set
 * of independent messages, and abandoning the rest would leave them neither
 * acked nor retried — so a rejection is held back and rethrown once everything
 * has settled, rather than short-circuiting the way `Promise.all` does. The
 * first rejection is the one rethrown.
 *
 * @typeParam T - The item type
 * @param items - The items to process
 * @param limit - Maximum simultaneous calls; values below 1 are treated as 1
 * @param fn - Invoked per item
 * @returns Resolves once every item has settled
 * @throws The first error thrown by any call, after every item has run
 * @internal
 */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.floor(limit));

  // A shared cursor rather than fixed slices: a slow item must not idle a lane
  // while another lane still has work queued behind it.
  let cursor = 0;
  let failure: { readonly error: unknown } | undefined;

  const lane = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        await fn(items[index] as T);
      } catch (error: unknown) {
        failure ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(width, items.length) }, () => lane()));

  if (failure !== undefined) throw failure.error;
}
