/**
 * Runs every cleanup step of a fixture, even when an earlier one fails.
 *
 * A chain of awaited cleanup calls stops at the first rejection, so a failed
 * `close()` left the later sockets, pools and temporary databases behind.
 *
 * @module
 */

/**
 * Attempts each step in order and then reports what failed.
 *
 * @param steps - The cleanup steps, in the order they must run
 * @throws The only failure, or an `AggregateError` of every failure
 */
export async function cleanupAll(steps: readonly (() => unknown)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, 'Several cleanup steps failed.');
}

/**
 * Runs the cleanup after a failed setup, keeping the setup's own error.
 *
 * @param error - The setup failure, rethrown after cleanup
 * @param steps - The cleanup steps
 * @throws Always `error`: a cleanup failure must not replace the setup's cause
 */
export async function cleanupAfter(
  error: unknown,
  steps: readonly (() => unknown)[],
): Promise<never> {
  await cleanupAll(steps).catch(() => {});
  throw error;
}
