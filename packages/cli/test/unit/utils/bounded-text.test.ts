import { describe, expect, it, vi } from 'vitest';
import {
  readExistingText,
  MAX_EXISTING_FILE_BYTES,
  type ICliFileSystem,
} from '../../../src/utils/file-writer.ts';
import { readJsonManifest } from '../../../src/utils/manifest-reader.ts';
import {
  detectTargetRuntime,
  RuntimeMarkerUnreadableError,
} from '../../../src/utils/runtime-detector.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('bounded text consumers', () => {
  it('reads the opened file through the optional capability without stat or bare readFile', async () => {
    const read = vi.fn(() => Promise.resolve(new TextEncoder().encode('\uFEFF{"ok":true}')));
    const fs: ICliFileSystem = {
      ...createFakeFs(),
      readRegularFile: read,
      stat: () => Promise.reject(new Error('path-level stat must not run')),
      readFile: () => Promise.reject(new Error('bare read must not run')),
    };
    expect(await readExistingText(fs, '/file')).toBe('\uFEFF{"ok":true}');
    expect(read).toHaveBeenCalledWith('/file', MAX_EXISTING_FILE_BYTES);
    expect((await readJsonManifest(fs, '/file')).kind).toBe('ok');
    read.mockResolvedValue(new TextEncoder().encode('{"ok":true}'));
    expect(await readJsonManifest(fs, '/file')).toEqual({
      kind: 'ok',
      value: { ok: true },
      format: 'json',
    });
  });

  it.each(['missing', 'non-regular', 'oversize', 'denied', 'invalid-utf8'])(
    'maps bounded reader %s failures without falling back',
    async (kind) => {
      const fs: ICliFileSystem = {
        ...createFakeFs(),
        readRegularFile: () => {
          if (kind === 'invalid-utf8') return Promise.resolve(new Uint8Array([255]));
          return Promise.reject(
            kind === 'missing'
              ? Object.assign(new Error('gone'), { code: 'ENOENT' })
              : new Error(
                  kind === 'denied' ? 'EACCES' : '/file: expected a regular file at most 1 MiB',
                ),
          );
        },
      };
      if (kind === 'missing') {
        expect(await readExistingText(fs, '/file')).toBeUndefined();
        expect(await readJsonManifest(fs, '/file')).toEqual({ kind: 'missing' });
      } else {
        await expect(readExistingText(fs, '/file')).rejects.toThrow();
        expect(await readJsonManifest(fs, '/file')).toMatchObject({ kind: 'unreadable' });
      }
    },
  );

  it('retains the stat-then-read fallback for filesystems without the capability', async () => {
    const fs = createFakeFs({
      '/file': '{}',
      '/large': 'x'.repeat(MAX_EXISTING_FILE_BYTES + 1),
      '/dir/child': '',
    });
    expect(await readExistingText(fs, '/file')).toBe('{}');
    expect(await readExistingText(fs, '/missing')).toBeUndefined();
    for (const path of ['/large', '/dir']) {
      await expect(readExistingText(fs, path)).rejects.toThrow(
        'expected a regular file at most 1 MiB',
      );
      expect(await readJsonManifest(fs, path)).toMatchObject({
        kind: 'unreadable',
        // The path is the caller's to print (`Cannot read <path>: <reason>`), so the
        // reader's own leading `<path>: ` is not repeated (M120 re-audit, cosmetic).
        reason: 'expected a regular file at most 1 MiB',
      });
    }
    const vanished = {
      ...fs,
      readFile: () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
    };
    expect(await readExistingText(vanished, '/file')).toBeUndefined();
    expect(await readJsonManifest(vanished, '/file')).toEqual({ kind: 'missing' });
    const denied = { ...fs, stat: () => Promise.reject('disk gone') };
    await expect(readExistingText(denied, '/file')).rejects.toBe('disk gone');
    expect(await readJsonManifest(denied, '/file')).toEqual({
      kind: 'unreadable',
      reason: 'disk gone',
    });
  });

  it.each([false, true])(
    'runtime marker presence never opens a file (capability: %s)',
    async (bounded) => {
      const bareRead = vi.fn(() => Promise.reject(new Error('must not read marker')));
      const readRegularFile = vi.fn(() => Promise.reject(new Error('must not read marker')));
      const fs: ICliFileSystem = {
        ...createFakeFs(),
        readFile: bareRead,
        ...(bounded ? { readRegularFile } : {}),
        stat: (path) => {
          if (path.endsWith('wrangler.toml'))
            return Promise.resolve({ isFile: false, isDirectory: false, size: 0 });
          return Promise.reject(new Error('unexpected stat'));
        },
      };
      expect(await detectTargetRuntime(fs, '/app')).toBe('cloudflare-workers');
      expect(bareRead).not.toHaveBeenCalled();
      expect(readRegularFile).not.toHaveBeenCalled();
      await expect(
        detectTargetRuntime({ ...fs, stat: () => Promise.reject(new Error('EACCES')) }, '/app'),
      ).rejects.toBeInstanceOf(RuntimeMarkerUnreadableError);
    },
  );
});
