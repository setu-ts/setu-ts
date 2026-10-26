import { expect, it } from 'vitest';
import { diagnoseBarrels, readBarrel } from '../../src/diagnostics/barrel-drift.ts';
import { scanSeamSpecs } from '../../src/seams/registry.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { MAX_EXISTING_FILE_BYTES } from '../../src/utils/file-writer.ts';

const specs = scanSeamSpecs(new Set());
const barrel = '/app/src/controllers/index.ts';
it('compares declaration name sets across formatting, reordering and quote styles', async () => {
  const fs = createFakeFs({
    [barrel]: `// import { bad } from './bad.controller.ts';
import {
  registerTwoRoutes,
} from "./two.routes.ts";
export { registerOneRoutes } from './one.controller.ts';
const text = "; import { x } from './fake.controller.ts';";`,
  });
  expect(await diagnoseBarrels(fs, '/app', specs, { controller: ['one'], route: ['two'] })).toEqual(
    [],
  );
});

it('reads default, namespace and re-export declarations across line breaks', async () => {
  const fs = createFakeFs({
    [barrel]: `import Default, *\n as one from './one.controller.ts';
import *\n as two from './two.controller.ts';
export *\n from './three.controller.ts';
export * as four from './four.controller.ts';
import Five from './five.controller.ts';`,
  });
  expect(
    await diagnoseBarrels(fs, '/app', specs, {
      controller: ['one', 'two', 'three', 'four', 'five'],
    }),
  ).toEqual([]);
});

it('reports unlisted and stale files once for a shared barrel', async () => {
  const fs = createFakeFs({
    '/app/src/cqrs/index.ts':
      "import { old } from './old.command-handler.ts';\nimport { q } from './gone.query-handler.ts';",
  });
  const findings = await diagnoseBarrels(fs, '/app', specs, {
    'command-handler': ['new'],
    'query-handler': ['fresh'],
  });
  expect(findings).toEqual([
    {
      kind: 'barrel-drift',
      barrel: 'src/cqrs/index.ts',
      unlisted: ['src/cqrs/fresh.query-handler.ts', 'src/cqrs/new.command-handler.ts'],
      stale: ['src/cqrs/gone.query-handler.ts', 'src/cqrs/old.command-handler.ts'],
    },
  ]);
});

it('reports absent nonempty barrels and ignores absent empty and functional service barrels', async () => {
  const fs = createFakeFs();
  expect(await diagnoseBarrels(fs, '/app', specs, {})).toEqual([]);
  expect(await diagnoseBarrels(fs, '/app', specs, { service: ['pricing'] })).toEqual([]);
  expect(await diagnoseBarrels(fs, '/app', specs, { controller: ['users'] })).toEqual([
    {
      kind: 'barrel-drift',
      barrel: 'src/controllers/index.ts',
      unlisted: ['src/controllers/users.controller.ts'],
      stale: [],
    },
  ]);
});

it('reports each unreadable reason without opening non-regular or oversized files', async () => {
  for (const [seed, reason] of [
    [{ [`${barrel}/child`]: '' }, 'not-a-file'],
    [{ [barrel]: ' '.repeat(MAX_EXISTING_FILE_BYTES + 1) }, 'too-large'],
    [{ [barrel]: 'const x = `template`;' }, 'unclassifiable'],
  ] as const) {
    const fs = createFakeFs(seed);
    expect(await diagnoseBarrels(fs, '/app', specs, {})).toEqual([
      { kind: 'barrel-unreadable', barrel: 'src/controllers/index.ts', reason },
    ]);
  }
  const fs = createFakeFs();
  expect(
    await readBarrel({ ...fs, stat: () => Promise.reject(new Error('permission denied')) }, barrel),
  ).toEqual({ kind: 'unreadable', reason: 'unclassifiable' });
});
