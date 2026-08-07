/**
 * Drives the DEFAULT custom-schematic loader — a real dynamic `import()` — so
 * the production path is exercised, not only the injected test seam.
 *
 * @module
 */

import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  CUSTOM_SCHEMATIC_DIR,
  importModule,
  loadCustomSchematic,
} from '../../src/schematics/custom.ts';
import { deriveNames } from '../../src/utils/names.ts';

const MODULE_SOURCE = `export function schematic(names, options) {
  return [{
    path: \`generated/\${names.kebab}.txt\`,
    contents: \`\${names.pascal}|\${options.runtime}|\${[...options.plugins].join(',')}\`,
  }];
}
`;

const DEFAULT_EXPORT_SOURCE = `export default function (names) {
  return [{ path: \`d/\${names.kebab}.txt\`, contents: names.camel }];
}
`;

const NO_EXPORT_SOURCE = `export const notASchematic = 1;\n`;

describe('custom schematic — real import()', () => {
  let root: string;

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: 'setu-custom-' });
    await Deno.mkdir(`${root}/${CUSTOM_SCHEMATIC_DIR}`, { recursive: true });
    await Deno.writeTextFile(`${root}/${CUSTOM_SCHEMATIC_DIR}/real.ts`, MODULE_SOURCE);
    await Deno.writeTextFile(`${root}/${CUSTOM_SCHEMATIC_DIR}/defaulted.ts`, DEFAULT_EXPORT_SOURCE);
    await Deno.writeTextFile(`${root}/${CUSTOM_SCHEMATIC_DIR}/empty.ts`, NO_EXPORT_SOURCE);
  });

  afterAll(async () => {
    await Deno.remove(root, { recursive: true });
  });

  it('imports a real module from disk through the default loader', async () => {
    // No loader argument: this goes through importModule's real `await import()`.
    const schematic = await loadCustomSchematic(root, 'real');
    expect(typeof schematic).toBe('function');
  });

  it('runs the imported schematic and returns its files', async () => {
    const schematic = await loadCustomSchematic(root, 'real');
    const files = schematic(deriveNames('order-item'), {
      runtime: 'bun',
      plugins: new Set(['cache-plugin']),
      now: () => 0,
    });
    expect(files).toEqual([
      { path: 'generated/order-item.txt', contents: 'OrderItem|bun|cache-plugin' },
    ]);
  });

  it('imports a module that only has a default export', async () => {
    const schematic = await loadCustomSchematic(root, 'defaulted');
    expect(schematic(deriveNames('order-item'), {
      runtime: 'deno',
      plugins: new Set(),
      now: () => 0,
    })).toEqual([{ path: 'd/order-item.txt', contents: 'orderItem' }]);
  });

  it('throws for a real file that exports no schematic', async () => {
    await expect(loadCustomSchematic(root, 'empty'))
      .rejects.toThrow("must export a 'schematic' function");
  });

  it('throws for a file that does not exist on disk', async () => {
    await expect(loadCustomSchematic(root, 'absent'))
      .rejects.toThrow('Cannot load custom schematic "absent"');
  });

  it('importModule really resolves a module, not a stub', async () => {
    const url = new URL('../../src/constants.ts', import.meta.url).href;
    const module = await importModule(url);
    expect(module['PROGRAM_NAME']).toBe('setu');
  });
});
