/** Bounds-checked ustar/pax reader. Nothing extracted is written or executed. @module */

/** Decodes a null-terminated tar header field. */
function field(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/** Reads an octal number, refusing malformed and unsafe sizes. */
function octal(bytes: Uint8Array): number {
  const value = field(bytes).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error('tar: invalid octal field');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) throw new Error('tar: unsafe numeric field');
  return number;
}

/** Parses byte-counted pax records (length includes its own digits and newline). */
function pax(bytes: Uint8Array): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    if (space === -1) throw new Error('tar: malformed pax length');
    const digits = field(bytes.subarray(offset, space));
    const length = Number(digits);
    if (
      !/^\d+$/.test(digits) || !Number.isSafeInteger(length) || length <= space - offset + 1 ||
      offset + length > bytes.length
    ) {
      throw new Error('tar: invalid pax record size');
    }
    if (bytes[offset + length - 1] !== 10) throw new Error('tar: pax record lacks newline');
    const record = field(bytes.subarray(space + 1, offset + length - 1));
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('tar: malformed pax record');
    result.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return result;
}

/** Upper bound on an unpacked registry tarball. The largest member today unpacks to about
 * 3.2 MB (`cli`), so this leaves about 20× headroom while keeping a crafted gzip from
 * exhausting memory (security audit F3: 518 KiB once grew memory by about 1 GiB).
 */
export const MAX_UNPACKED_TARBALL_BYTES: number = 64 * 1024 * 1024;

/** Gunzips untrusted bytes, refusing (and cancelling the stream) past `limit` unpacked bytes.
 * @throws {Error} When the output would exceed `limit`, or the input is not valid gzip.
 */
export async function gunzipBounded(
  compressed: Uint8Array<ArrayBuffer>,
  limit: number = MAX_UNPACKED_TARBALL_BYTES,
): Promise<Uint8Array> {
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`gzip: unpacked size exceeds ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Reads regular files from a complete ustar archive, including local/global pax path overrides.
 * @throws {Error} On corrupt headers, invalid lengths or truncated payloads.
 */
export function readTar(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  let globalPax = new Map<string, string>();
  let localPax = new Map<string, string>();
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 512 > bytes.length) throw new Error('tar: truncated header');
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0)) {
        throw new Error('tar: invalid end blocks');
      }
      return files;
    }
    const checksum = octal(header.subarray(148, 156));
    const calculated = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== calculated) throw new Error('tar: corrupt header checksum');
    if (field(header.subarray(257, 263)) !== 'ustar') throw new Error('tar: unsupported header');
    const size = octal(header.subarray(124, 136));
    offset += 512;
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded) || padded > bytes.length - offset) {
      throw new Error('tar: truncated payload');
    }
    const body = bytes.subarray(offset, offset + size);
    const type = header[156];
    if (type === 120) localPax = new Map(pax(body));
    else if (type === 103) globalPax = new Map([...globalPax, ...pax(body)]);
    else {
      const prefix = field(header.subarray(345, 500));
      const name = field(header.subarray(0, 100));
      const path = localPax.get('path') ?? globalPax.get('path') ??
        (prefix === '' ? name : `${prefix}/${name}`);
      if (type === 0 || type === 48) files.set(path, body.slice());
      localPax = new Map();
    }
    offset += padded;
  }
  throw new Error('tar: missing end blocks');
}
