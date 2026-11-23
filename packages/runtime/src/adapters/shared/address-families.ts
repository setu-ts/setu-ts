/**
 * The `A`/`AAAA` combination rule shared by every `resolveHost`: one family
 * answering is enough, and when both fail the error's cause is an
 * `AggregateError` holding the `A` failure, then the `AAAA` failure.
 *
 * @module
 */

/** Combines A then AAAA, preserving every failure when neither family answered. */
export function combineAddressFamilies(
  results: readonly PromiseSettledResult<string[]>[],
  hostname: string,
): readonly string[] {
  const addresses: string[] = [];
  const failures: unknown[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') addresses.push(...result.value);
    else failures.push(result.reason);
  }
  if (failures.length === results.length) {
    throw new Error(`DNS lookup failed for ${hostname}`, {
      cause: new AggregateError(failures, `Every address lookup failed for ${hostname}`),
    });
  }
  return addresses;
}
