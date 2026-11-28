/**
 * The value-free label a log line gives a thrown value: its class name.
 * @module
 */

/**
 * Names a thrown value for a log line without carrying its content.
 *
 * The value may be application code's own (a model or middleware error), so
 * `name` is read once, inside a `try`: a getter that throws, or returns a
 * different value on a second read, cannot put anything but a string into the
 * log or escape the caller's error path.
 *
 * @param error - The thrown value
 * @returns The error's string `name`, otherwise its `typeof`
 * @internal
 */
export function errorLabel(error: unknown): string {
  try {
    // `instanceof` runs a Proxy's `getPrototypeOf` trap, so it is inside too.
    if (!(error instanceof Error)) return typeof error;
    const name: unknown = error.name;
    return typeof name === 'string' ? name : typeof name;
  } catch {
    return 'object';
  }
}
