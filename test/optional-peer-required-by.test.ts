import { glob, readFile } from 'node:fs/promises';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** Collects actual constructor calls, ignoring comments and examples. */
function requiredByValues(source: string): (string | undefined)[] {
  const values: (string | undefined)[] = [];
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'OptionalDependencyUnavailableError'
    ) {
      const options = node.arguments?.[1];
      const property =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (item) => ts.isPropertyAssignment(item) && item.name.getText(file) === 'requiredBy',
            )
          : undefined;
      values.push(
        property !== undefined &&
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.initializer)
          ? property.initializer.text
          : undefined,
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return values;
}

describe('optional peer loaders name their owning npm package', () => {
  it('detects absent, computed and incorrect names without reading examples', () => {
    expect(
      requiredByValues(`
      // new OptionalDependencyUnavailableError('example');
      new OptionalDependencyUnavailableError('x');
      new OptionalDependencyUnavailableError('x', { requiredBy: owner });
      new OptionalDependencyUnavailableError('x', { requiredBy: 'wrong' });
    `),
    ).toEqual([undefined, undefined, 'wrong']);
  });

  it('checks every source constructor against its member manifest', async () => {
    const sites: { path: string; expected: string; actual: string | undefined }[] = [];
    for await (const path of glob('packages/*/src/**/*.ts')) {
      const values = requiredByValues(await readFile(path, 'utf8'));
      if (values.length === 0) continue;
      const member = path.split('/').slice(0, 2).join('/');
      const manifest = JSON.parse(await readFile(`${member}/package.json`, 'utf8')) as {
        name: string;
      };
      for (const actual of values) sites.push({ path, expected: manifest.name, actual });
    }
    expect(sites.length).toBeGreaterThanOrEqual(49);
    for (const site of sites) expect(site.actual, site.path).toBe(site.expected);
  });
});
