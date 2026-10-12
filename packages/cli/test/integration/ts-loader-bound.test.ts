/**
 * The project-module loader reads no `tsconfig.json` above the project (M111d
 * audit F2), through the REAL `tsx` import.
 *
 * A `tsconfig.json` decides, through `paths`, which file an import runs. One
 * planted in a directory above a project that carries none of its own — every
 * Deno scaffold — would otherwise execute in the developer's process. The control
 * in the second case puts the SAME configuration inside the project and shows it
 * is honoured, so the first case cannot pass because `paths` simply never apply.
 *
 * @module
 */
import { tempDir } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importProjectModule } from '../../src/utils/ts-loader.ts';

const PATHS = JSON.stringify({
  compilerOptions: { baseUrl: '.', paths: { 'routed-module': ['./routed.ts'] } },
});

let outer = '';
let project = '';

beforeEach(async () => {
  outer = await tempDir({ prefix: 'setu-ts-loader-bound-' });
  project = `${outer}/proj`;
  await nodeFs.mkdir(project);
  await nodeFs.writeFile(
    `${project}/setu.config.ts`,
    "import { marker } from 'routed-module';\nexport const seen = marker;\n",
  );
});

afterEach(async () => {
  await nodeFs.rm(outer, { recursive: true }).catch(() => {});
});

describe('the project module loader', () => {
  it('ignores a tsconfig planted above the project', async () => {
    await nodeFs.writeFile(`${outer}/tsconfig.json`, PATHS);
    await nodeFs.writeFile(`${outer}/routed.ts`, "export const marker = 'PLANTED';\n");
    const url = pathToFileURL(`${project}/setu.config.ts`).href;
    await expect(importProjectModule(url, project)).rejects.toThrow(/routed-module/);
  });

  it('honours the same configuration inside the project (control)', async () => {
    await nodeFs.writeFile(`${project}/tsconfig.json`, PATHS);
    await nodeFs.writeFile(`${project}/routed.ts`, "export const marker = 'OWN';\n");
    const url = pathToFileURL(`${project}/setu.config.ts`).href;
    expect((await importProjectModule(url, project)).seen).toBe('OWN');
  });
});
