import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { getSchematic, listSchematics } from '../../../src/schematics/registry.ts';
import { deriveNames } from '../../../src/utils/names.ts';
import { options } from './_shared.ts';

describe('documented schematic tables', () => {
  for (const document of ['packages/cli/README.md', 'docs/cli.md', 'PUBLIC_API.md']) {
    it(`${document} lists every registered schematic and only paths that its modes emit`, async () => {
      const readme = await readFile(new URL(`../../../../../${document}`, import.meta.url), 'utf8');
      const table = readme
        .split('\n')
        .slice(readme.split('\n').findIndex((line) => line.startsWith('| Schematic')));
      const headers = table[0]!.split('|').map((cell) => cell.trim());
      const emittedColumn = headers.findIndex((cell) => /^Emit/.test(cell));
      const requiresColumn = headers.indexOf('Requires');
      const rows = table.slice(
        2,
        table.findIndex((line) => !line.startsWith('|')),
      );
      for (const schematic of listSchematics()) {
        const row = rows.find((line) => line.split('|')[1]?.trim() === `\`${schematic.name}\``);
        expect(row, schematic.name).toBeDefined();
        const cells = row!.split('|');
        const plugins =
          requiresColumn < 0
            ? [schematic.requiresPlugin, 'queue-plugin', 'react-router-plugin', 'sdk'].filter(
                (value): value is string => value !== undefined,
              )
            : [...cells[requiresColumn]!.matchAll(/`([a-z-]+)`/g)].map((match) => match[1]!);
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
        const paths = [...cells[emittedColumn]!.matchAll(/`(src\/[^`]+)`/g)];
        expect(paths.length, schematic.name).toBeGreaterThan(0);
        for (const [, pattern] of paths) {
          const path = pattern!.replaceAll('<name>', 'widget').replaceAll('<kind>', schematic.name);
          const expression = new RegExp(
            `^${path.replaceAll('.', '\\.').replace(/<(timestamp|stamp)>/, '[0-9]{14}')}${path.endsWith('/') ? '.+' : ''}$`,
          );
          expect(
            [...emitted].some((candidate) => expression.test(candidate)),
            path,
          ).toBe(true);
        }
      }
    });
  }
});
