import { describe, expect, it } from 'vitest';
import { gunzipBounded, MAX_UNPACKED_TARBALL_BYTES, readTar } from '../../scripts/tar-read.ts';
import { archive, paxRecord, tarEntry } from '../fixtures/tar-fixture.ts';

describe('ustar/pax reader', () => {
  it('reads multiple files, prefix paths, padding and empty entries', () => {
    const bytes = archive(
      tarEntry('first', 'x'.repeat(513)),
      tarEntry('second', '', '0', 'package/src'),
      tarEntry('ignored', '', '5'),
    );
    const files = readTar(bytes);
    expect([...files.keys()]).toEqual(['first', 'package/src/second']);
    expect(files.get('first')!.length).toBe(513);
    expect(files.get('package/src/second')!.length).toBe(0);
    expect(readTar(archive()).size).toBe(0);
    expect(readTar(archive(tarEntry('null-type', 'x', '\0'))).has('null-type')).toBe(true);
  });
  it('applies local and global pax path records with local taking precedence', () => {
    const long = `package/src/${'long/'.repeat(30)}file.ts`;
    const files = readTar(
      archive(
        tarEntry('pax', paxRecord('path', 'global'), 'g'),
        tarEntry('pax', paxRecord('path', long), 'x'),
        tarEntry('short', 'one'),
        tarEntry('other', 'two'),
      ),
    );
    expect(new TextDecoder().decode(files.get(long))).toBe('one');
    expect(new TextDecoder().decode(files.get('global'))).toBe('two');
  });
  it('rejects truncation, invalid end blocks, corruption and malformed pax', () => {
    for (const bytes of [
      new Uint8Array(1),
      tarEntry('file', 'x'),
      archive(tarEntry('file', 'x')).subarray(0, 520),
      archive().subarray(0, 512),
    ])
      expect(() => readTar(bytes)).toThrow();
    const corrupt = archive(tarEntry('file', 'x'));
    corrupt[0]++;
    expect(() => readTar(corrupt)).toThrow('checksum');
    for (const body of ['abc', 'x path=x\n', '999 path=x\n', '1 x\n', '9 path=x!', '5 ab\n']) {
      expect(() => readTar(archive(tarEntry('pax', body, 'x')))).toThrow();
    }
  });

  it('gunzips within the bound and refuses output past it', async () => {
    const gzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
      new Uint8Array(
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      );
    const small = new TextEncoder().encode('hello tar');
    expect(await gunzipBounded(await gzip(small))).toEqual(small);
    // 2 MiB of zeros compresses to a few KiB: the shape of a decompression bomb.
    const bomb = await gzip(new Uint8Array(2 * 1024 * 1024));
    expect(bomb.length).toBeLessThan(64 * 1024);
    await expect(gunzipBounded(bomb, 1024 * 1024)).rejects.toThrow('exceeds 1048576 bytes');
    expect((await gunzipBounded(bomb, 2 * 1024 * 1024)).length).toBe(2 * 1024 * 1024);
    await expect(gunzipBounded(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    expect(MAX_UNPACKED_TARBALL_BYTES).toBe(64 * 1024 * 1024);
  });
});
