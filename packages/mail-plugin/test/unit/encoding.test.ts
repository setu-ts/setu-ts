import { expect, it } from 'vitest';

it('M139c base64 encodes empty, one-to-three bytes and 100 KiB across slice boundaries', async () => {
  const { toBase64 } = await import('../../src/providers/encoding.ts');
  for (const [bytes, expected] of [
    [[], ''],
    [[102], 'Zg=='],
    [[102, 111], 'Zm8='],
    [[102, 111, 111], 'Zm9v'],
    [[0, 255, 128], 'AP+A'],
  ] as const)
    expect(toBase64(new Uint8Array(bytes))).toBe(expected);
  const bytes = Uint8Array.from({ length: 100 * 1024 }, (_, i) => i % 256);
  expect(toBase64(bytes)).toBe(
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')),
  );
  expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
});
