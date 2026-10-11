/** Hand-built ustar fixtures independent of the reader implementation. */
export function tarEntry(name: string, body: string, type = '0', prefix = ''): Uint8Array {
  const encoder = new TextEncoder();
  const content = encoder.encode(body);
  const bytes = new Uint8Array(512 + Math.ceil(content.length / 512) * 512);
  const put = (offset: number, text: string) => bytes.set(encoder.encode(text), offset);
  put(0, name);
  put(100, '0000644\0');
  put(108, '0000000\0');
  put(116, '0000000\0');
  put(124, `${content.length.toString(8).padStart(11, '0')}\0`);
  put(136, '00000000000\0');
  put(148, '        ');
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  put(345, prefix);
  const checksum = bytes.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
  put(148, `${checksum.toString(8).padStart(6, '0')}\0 `);
  bytes.set(content, 512);
  return bytes;
}

/** Concatenates entries and the two required zero end blocks. */
export function archive(...entries: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(entries.reduce((sum, entry) => sum + entry.length, 1024));
  let offset = 0;
  for (const entry of entries) {
    bytes.set(entry, offset);
    offset += entry.length;
  }
  return bytes;
}

/** Creates a pax record using its UTF-8 byte length, including the length prefix. */
export function paxRecord(key: string, value: string): string {
  const suffix = ` ${key}=${value}\n`;
  let size = new TextEncoder().encode(suffix).length + 1;
  while (String(size).length + new TextEncoder().encode(suffix).length !== size) {
    size = String(size).length + new TextEncoder().encode(suffix).length;
  }
  return `${size}${suffix}`;
}
