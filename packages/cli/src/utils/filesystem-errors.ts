/** Missing-path classification for the runtime filesystem adapters. @module */

/**
 * Recognizes absence without treating an access or I/O failure as an empty path.
 *
 * Deno preserves NotFound, Node preserves errno, and Bun's adapter emits an
 * explicit ENOENT message. Unknown errors fail closed at the caller.
 *
 * @param cause - The filesystem failure
 * @returns Whether the adapter positively reports a missing path
 */
export function isMissingPath(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.name === 'NotFound' ||
    ('code' in cause && cause.code === 'ENOENT') ||
    cause.message.startsWith('ENOENT: no such file or directory, ');
}
