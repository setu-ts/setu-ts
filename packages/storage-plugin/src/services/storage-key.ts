/**
 * The one check every storage key passes before it reaches a backend.
 *
 * A key is a path inside the provider's bucket or container. A `.` or `..`
 * segment would let it name something outside that: the Azure SDK resolves
 * `..` in the blob URL before it sends or signs, so `../other/secret.txt`
 * read, wrote and signed a URL for a blob in another container. The local
 * provider has always contained such keys; this check refuses them on every
 * provider. Internal — not exported from the package barrel.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Refuses a key with a `.` or `..` path segment.
 *
 * @param path - The object key
 * @throws {Error} With a `400` status hint, when a segment is `.` or `..`
 */
export function assertStorageKey(path: string): void {
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw withHttpStatusHint(
      new Error(`storage-plugin: the key '${path}' has a '.' or '..' segment`),
      {
        status: 400,
        title: 'Bad Request',
        detail: "A storage key may not contain a '.' or '..' path segment.",
      },
    );
  }
}
