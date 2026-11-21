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
 * Returns the refusal for a key with a `.` or `..` path segment, or
 * `undefined` for a key that may be used. The message does not quote the key:
 * it is the caller's text, and a refusal is logged.
 *
 * @param path - The object key
 * @returns An `Error` with a `400` status hint, or `undefined`
 */
export function storageKeyRefusal(path: string): Error | undefined {
  if (!path.split('/').some((segment) => segment === '.' || segment === '..')) {
    return undefined;
  }
  return withHttpStatusHint(new Error("storage-plugin: a key has a '.' or '..' path segment"), {
    status: 400,
    title: 'Bad Request',
    detail: "A storage key may not contain a '.' or '..' path segment.",
  });
}

/**
 * Refuses a key with a `.` or `..` path segment.
 *
 * @param path - The object key
 * @throws {Error} With a `400` status hint, when a segment is `.` or `..`
 */
export function assertStorageKey(path: string): void {
  const refusal = storageKeyRefusal(path);
  if (refusal !== undefined) throw refusal;
}
