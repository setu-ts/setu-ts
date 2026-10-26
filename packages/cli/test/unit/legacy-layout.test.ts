import { expect, it } from 'vitest';
import { readConfigModule } from '../../src/utils/legacy-layout.ts';
import { MAX_EXISTING_FILE_BYTES } from '../../src/utils/file-writer.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';

it('reads only regular config files under the cap, treating unsafe evidence as unreadable', async () => {
  for (const seed of [
    {},
    { '/app/setu.config.ts/child': '' },
    { '/app/setu.config.ts': 'x'.repeat(MAX_EXISTING_FILE_BYTES + 1) },
  ])
    expect(await readConfigModule(createFakeFs(seed), '/app')).toBe('');
  expect(await readConfigModule(createFakeFs({ '/app/setu.config.ts': 'config;' }), '/app')).toBe(
    'config;',
  );
});
