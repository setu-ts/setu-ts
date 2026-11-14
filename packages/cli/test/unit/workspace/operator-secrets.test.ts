import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { mkdtemp, mkdir, rm, symlink, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { operatorSecretFiles } from '../../../src/workspace/operator-secrets.ts';
import { writeFiles } from '../../../src/utils/file-writer.ts';

describe('operator secrets', () => {
  it.each(['', '# keep\nJWT_SECRET_OLD=old', '# keep\nJWT_SECRET_OLD=old\n'])(
    'creates or appends exact keys while preserving the original text',
    async (before) => {
      const path = '/ws/k8s/secrets/api/.env';
      const fs = createFakeFs({
        '/ws/package.json': '{}',
        ...(before === '' ? {} : { [path]: before }),
      });
      const { files, appended } = await operatorSecretFiles(
        fs,
        '/ws',
        'api',
        ['JWT_SECRET', 'JWT_SECRET'],
        () => 'operator-value',
      );
      expect(appended).toEqual(['JWT_SECRET']);
      await writeFiles(fs, files, { root: '/ws' });
      expect(
        fs.read(path) ===
          `${before}${before === '' || before.endsWith('\n') ? '' : '\n'}JWT_SECRET=operator-value\n`,
      ).toBe(true);
      expect(
        await operatorSecretFiles(fs, '/ws', 'api', ['JWT_SECRET'], () => {
          throw new Error('must preserve');
        }),
      ).toEqual({ files: [], appended: [] });
    },
  );

  it('keeps empty and exported keys, appending only the newly absent key', async () => {
    const path = '/ws/k8s/secrets/api/.env';
    const before = '# comment\nexport JWT_SECRET=\nSESSION_SECRET=operator-owned\n';
    const fs = createFakeFs({ [path]: before });
    const { files, appended } = await operatorSecretFiles(
      fs,
      '/ws',
      'api',
      ['JWT_SECRET', 'SESSION_SECRET', 'NEW_SECRET'],
      () => 'independent',
    );
    expect(appended).toEqual(['NEW_SECRET']);
    // Marked so the writer creates the file owner-only (audit F2).
    expect(files[0]?.secret).toBe(true);
    expect(files[0]?.contents === `${before}NEW_SECRET=independent\n`).toBe(true);
  });

  it.each(['k8s', 'k8s/secrets', 'k8s/secrets/api', 'k8s/secrets/api/.env'])(
    'refuses a real symlink at %s before reading or writing',
    async (relative) => {
      await mkdir('.tmp', { recursive: true });
      const root = resolve(await mkdtemp('.tmp/operator-secrets-'));
      const fs = createNodeRuntimeServices().fs!;
      try {
        const file = relative.endsWith('.env');
        const target = `${root}/target`;
        if (file) await writeFile(target, '# untouched\n');
        else await mkdir(target);
        const path = `${root}/${relative}`;
        await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
        await symlink(target, path);
        await expect(operatorSecretFiles(fs, root, 'api', ['JWT_SECRET'])).rejects.toThrow(/link/);
        if (file) expect(await readFile(target, 'utf8')).toBe('# untouched\n');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
