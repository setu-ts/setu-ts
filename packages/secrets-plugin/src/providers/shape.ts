/**
 * Shared structural-shape validation for injected provider clients.
 *
 * @module
 */

/**
 * Reports whether `value` is a non-null object exposing every named method as a
 * function. Used by each provider to validate an injected client so the plugin
 * never hard-depends on a cloud SDK.
 *
 * @param value - The candidate object
 * @param methods - Method names that must be present as functions
 * @returns `true` when every method exists as a function
 */
export function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  for (const method of methods) {
    if (typeof record[method] !== 'function') {
      return false;
    }
  }
  return true;
}
