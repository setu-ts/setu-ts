import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VERSION } from '../../src/constants.ts';

const workspace = fileURLToPath(new URL('../../../../', import.meta.url));
const bins = ['cli', 'create'] as const;
let root = '';
let capture = 0;

/**
 * Captures actual child output in files without requiring child pipe permissions.
 * @param args - Node arguments and the executable under test
 * @param timeout - Maximum child execution time
 * @param cwd - Child working directory
 * @returns The child status and complete stdout/stderr
 */
async function runNode(
  args: readonly string[],
  timeout = 30_000,
  cwd = root,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const prefix = `${root}/capture-${capture++}`;
  const stdout = await open(`${prefix}.stdout`, 'w');
  const stderr = await open(`${prefix}.stderr`, 'w');
  try {
    const result = spawnSync(process.execPath, [...args], {
      cwd,
      timeout,
      stdio: ['ignore', stdout.fd, stderr.fd],
    });
    expect(result.error).toBeUndefined();
    return {
      status: result.status,
      stdout: await readFile(`${prefix}.stdout`, 'utf8'),
      stderr: await readFile(`${prefix}.stderr`, 'utf8'),
    };
  } finally {
    await Promise.all([stdout.close(), stderr.close()]);
  }
}

beforeAll(async () => {
  await mkdir(`${workspace}.tmp`, { recursive: true });
  root = await mkdtemp(`${workspace}.tmp/node-floor-`);
  const result = await runNode(
    [createRequire(import.meta.url).resolve('typescript/bin/tsc'), '-b', 'packages/create'],
    120_000,
    workspace,
  );
  expect(result.status, result.stdout + result.stderr).toBe(0);
  for (const path of ['dist/utils/node-version.js', 'dist/utils/node-version.d.ts']) {
    expect(await readFile(`${workspace}packages/cli/${path}`, 'utf8')).toContain(
      'nodeFloorRefusal',
    );
  }
}, 150_000);

afterAll(async () => {
  if (root !== '') await rm(root, { recursive: true });
});

describe.each(bins)('the built %s Node floor', (name) => {
  it('imports only process and the dependency-free version helper statically', async () => {
    const source = await readFile(`${workspace}packages/${name}/src/bin.ts`, 'utf8');
    const parsed = ts.createSourceFile('bin.ts', source, ts.ScriptTarget.Latest, true);
    const declarations = parsed.statements.filter(ts.isImportDeclaration);
    const imports = declarations.map((entry) => {
      expect(ts.isStringLiteral(entry.moduleSpecifier)).toBe(true);
      return (entry.moduleSpecifier as ts.StringLiteral).text;
    });
    expect(imports).toHaveLength(2);
    expect(imports[0]).toBe('node:process');
    expect(imports[1]).toMatch(/(?:\/|^)node-version(?:\.ts)?$/);
    const bindings = declarations[1]?.importClause?.namedBindings;
    expect(
      bindings !== undefined && ts.isNamedImports(bindings)
        ? bindings.elements.map((entry) => entry.name.text)
        : [],
    ).toEqual(['nodeFloorRefusal']);
  });

  it.each(['18.20.8', '20.20.2', '21.7.3', '22.8.0'])(
    'refuses Node %s before loading the command modules',
    async (version) => {
      const preload = `${root}/${name}-${version}.mjs`;
      await writeFile(
        preload,
        `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`,
      );
      const result = await runNode([
        '--import',
        preload,
        `${workspace}packages/${name}/dist/bin.js`,
        '--version',
      ]);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        `setu needs Node 22.9.0 or newer; this is Node ${version}. Supported: ^22.23.4 || ^24.22.1 || >=26.12.1.\n`,
      );
    },
  );

  it.each(['22.9.0', '22.12.0'])(
    'warns and continues for Node %s in the soft band',
    async (version) => {
      const preload = `${root}/${name}-${version}.mjs`;
      await writeFile(
        preload,
        `Object.defineProperty(process.versions, 'node', { value: '${version}' });\n`,
      );
      const result = await runNode([
        '--import',
        preload,
        `${workspace}packages/${name}/dist/bin.js`,
        '--version',
      ]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(`setu ${VERSION}`);
      expect(result.stderr).toBe(
        `setu supports Node ^22.23.4 || ^24.22.1 || >=26.12.1; this is Node ${version}. Commands may fail; upgrade Node.\n`,
      );
    },
  );
});
