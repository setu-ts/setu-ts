/**
 * Buffer utility for Web Crypto compatibility.
 *
 * @module
 */

/**
 * Copy a Uint8Array into a fresh ArrayBuffer.
 *
 * Web Crypto's `subtle` methods require `BufferSource` (`ArrayBufferView<ArrayBuffer> | ArrayBuffer`),
 * but `Uint8Array<ArrayBufferLike>` (the default inferred type) is not assignable because it may be
 * backed by a `SharedArrayBuffer`. This helper copies the bytes into a fresh `ArrayBuffer` so the
 * result satisfies `BufferSource` without any cast.
 *
 * @param bytes - The bytes to copy
 * @returns A fresh ArrayBuffer containing a copy of the bytes
 */
export function toBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
