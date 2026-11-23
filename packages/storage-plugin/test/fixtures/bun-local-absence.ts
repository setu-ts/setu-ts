import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { createBunRuntimeServices } from '../../../runtime/src/adapters/bun/bun-runtime.ts';
import { LocalStorageProvider } from '../../src/providers/local-provider.ts';

const root = await mkdtemp(new URL('../../../../.tmp/bun-local-', import.meta.url).pathname);
try {
  const runtime = createBunRuntimeServices();
  const provider = new LocalStorageProvider(runtime.fs, { rootDir: root }, () =>
    runtime.platform(),
  );
  await provider.connect();
  assert.equal(await provider.get('absent'), null);
  assert.equal(await provider.exists('absent'), false);
  assert.equal(await provider.delete('absent'), false);
  for (const method of ['readFile', 'stat', 'rm'] as const) {
    await assert.rejects(runtime.fs![method](`${root}/absent`), { code: 'ENOENT' });
  }
  await provider.disconnect();
} finally {
  await rm(root, { recursive: true, force: true });
}
