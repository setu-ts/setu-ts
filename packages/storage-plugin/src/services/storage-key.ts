/**
 * The one check every storage key passes before it reaches a backend.
 *
 * A key is a path inside the provider's bucket or container. A `.` or `..`
 * segment would let it name something outside that: the Azure SDK resolves
 * `..` in the blob URL before it sends or signs, so `../other/secret.txt`
 * read, wrote and signed a URL for a blob in another container. The local
 * provider has always contained such keys; `StorageService` refuses them for
 * every provider, and the S3, B2, GCS and Azure providers used directly do
 * too. Internal — not exported from the package barrel.
 *
 * @module
 */
import { withHttpStatusHint } from '@setu-ts/common';

/**
 * Returns the refusal for a key that is empty, is not a string or has a `.`
 * or `..` path segment, or `undefined` for a key that may be used. A `String` object
 * is refused: an SDK reads it as its value, so it would carry `..` past a
 * check that only looked at primitives. The message does not quote the key:
 * it is the caller's text, and a refusal is logged.
 *
 * @param path - The object key
 * @returns An `Error` with a `400` status hint, or `undefined`
 */
export function storageKeyRefusal(path: unknown): Error | undefined {
  // Returned, never thrown: a provider method hands it back as a rejection.
  if (typeof path !== 'string') {
    return withHttpStatusHint(new Error('storage-plugin: a key is not a string'), {
      status: 400,
      title: 'Bad Request',
      detail: 'A storage key must be a string.',
    });
  }
  // An empty key names the bucket or container itself: on S3 `get('')` is
  // `GET /<bucket>/`, a listing of every key.
  if (path === '') {
    return withHttpStatusHint(new Error('storage-plugin: a key is empty'), {
      status: 400,
      title: 'Bad Request',
      detail: 'A storage key may not be empty.',
    });
  }
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
 * Refuses a key that is empty, is not a string or has a `.` or `..` path
 * segment.
 *
 * @param path - The object key
 * @throws {Error} With a `400` status hint, when the key is empty or not a
 *   string, or a segment is `.` or `..`
 */
export function assertStorageKey(path: string): void {
  const refusal = storageKeyRefusal(path);
  if (refusal !== undefined) throw refusal;
}
