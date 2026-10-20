import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getSchematic, listSchematics } from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('README schematic table', () => {
  it('lists every registered schematic and only paths that its modes emit', async () => {
    const readme = await readFile(new URL('../../../README.md', import.meta.url), 'utf8');
    const rows = readme.split('\n').filter((line) => /^\| `[^`]+`\s*\|/.test(line));
    for (const schematic of listSchematics()) {
      const row = rows.find((line) => line.split('|')[1]?.trim() === `\`${schematic.name}\``);
      expect(row, schematic.name).toBeDefined();
      const cells = row!.split('|');
      const plugins = [...cells[3]!.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]!);
      const emitted = new Set<string>();
      for (const mode of ['functional', 'class-based']) {
        const installed = mode === 'class-based' ? [...plugins, 'decorator-plugin'] : plugins;
        for (const file of getSchematic(schematic.name)!.factory(
          deriveNames('widget'),
          options(installed),
        )) {
          emitted.add(file.path);
        }
      }
      const paths = [...cells[2]!.matchAll(/`(src\/[^`]+)`/g)];
      expect(paths.length, schematic.name).toBeGreaterThan(0);
      for (const [, pattern] of paths) {
        const path = pattern!.replaceAll('<name>', 'widget').replaceAll('<kind>', schematic.name);
        const expression = new RegExp(
          `^${path.replaceAll('.', '\\.').replace('<timestamp>', '[0-9]{14}')}$`,
        );
        expect(
          [...emitted].some((candidate) => expression.test(candidate)),
          path,
        ).toBe(true);
      }
    }
  });
});
