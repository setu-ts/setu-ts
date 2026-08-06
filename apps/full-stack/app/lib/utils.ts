/**
 * App-specific glue. Deliberately small: anything cross-cutting belongs to a
 * plugin, not to this directory.
 */

/** Joins conditional class names. */
export function classNames(...values: readonly (string | false | null | undefined)[]): string {
  return values.filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
