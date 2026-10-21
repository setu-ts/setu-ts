import { glob, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { CAPABILITIES } from '@setu-ts/common';
import { PACKAGE_DATA, TOOLING_PACKAGES } from '../packages/cli/src/agents/package-data.ts';
import { PACKAGE_METADATA } from '../scripts/jsr-metadata.ts';
import { PUBLISHED_PACKAGES } from '../scripts/release-packages.ts';

function sourceHasToken(source: string, token: string): boolean {
  const bindings = new Set(['CAPABILITIES']);
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@setu-ts/common' ||
      statement.importClause?.isTypeOnly
    )
      continue;
    const named = statement.importClause?.namedBindings;
    if (named === undefined || !ts.isNamedImports(named)) continue;
    for (const specifier of named.elements) {
      if (
        !specifier.isTypeOnly &&
        (specifier.propertyName ?? specifier.name).text === 'CAPABILITIES'
      )
        bindings.add(specifier.name.text);
    }
  }
  return [...bindings].some((binding) => source.includes(`${binding}.${token}`));
}

describe('the shipped agent package catalogue', () => {
  it('recognizes canonical and file-local named capability imports', () => {
    expect(sourceHasToken('CAPABILITIES.CACHE', 'CACHE')).toBe(true);
    expect(
      sourceHasToken(
        "import { CAPABILITIES as CAP } from '@setu-ts/common'; CAP.GRAPHQL",
        'GRAPHQL',
      ),
    ).toBe(true);
    for (const source of [
      "import { CAPABILITIES as OTHER } from '@setu-ts/common'; CAP.GRAPHQL",
      "import { CAPABILITIES as CAP } from 'other'; CAP.GRAPHQL",
      "import type { CAPABILITIES as CAP } from '@setu-ts/common'; CAP.GRAPHQL",
      "import { type CAPABILITIES as CAP } from '@setu-ts/common'; CAP.GRAPHQL",
      'CAP.GRAPHQL',
    ])
      expect(sourceHasToken(source, 'GRAPHQL')).toBe(false);
    expect(
      sourceHasToken(
        "import { CAPABILITIES as CAP } from '@setu-ts/common'; CAP.GRAPHQL",
        'GRAPQHL',
      ),
    ).toBe(false);
  });

  it('covers exactly the published library members with their npm descriptions', () => {
    const all = PUBLISHED_PACKAGES.map((p) => p.split('/').pop()!);
    const names = all.filter((name) => !TOOLING_PACKAGES.has(name));
    expect([...TOOLING_PACKAGES].every((name) => all.includes(name))).toBe(true);
    expect([...TOOLING_PACKAGES].sort()).toEqual(['cli', 'create']);
    expect([...PACKAGE_DATA.keys()].sort()).toEqual(names.sort());
    for (const [pkg, data] of PACKAGE_DATA)
      expect(data.description, pkg).toBe(PACKAGE_METADATA[pkg].description);
  });

  it('names existing capability keys that occur in the providing source', async () => {
    for (const member of PUBLISHED_PACKAGES) {
      const pkg = member.split('/').pop()!;
      const data = PACKAGE_DATA.get(pkg);
      if (data === undefined) continue;
      const sources: string[] = [];
      for await (const path of glob(`${member}/src/**/*.ts`))
        sources.push(await readFile(path, 'utf8'));
      for (const token of data.tokens) {
        expect(Object.hasOwn(CAPABILITIES, token), `${pkg}: ${token}`).toBe(true);
        expect(
          sources.some((source) => sourceHasToken(source, token)),
          `${pkg}: CAPABILITIES.${token}`,
        ).toBe(true);
      }
    }
  });
});
