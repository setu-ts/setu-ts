import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { exportsOfModule } from '../../scripts/package-export-collection.ts';

it('follows two re-exports, type-only aliases, merged declarations and namespaces', async () => {
  await mkdir('.tmp', { recursive: true });
  const dir = await mkdtemp('.tmp/export-collection-');
  try {
    await writeFile(
      `${dir}/decl.ts`,
      `export function fn(): void {}
export class Subject {}
export const value = 1;
export interface Shape {}
export type Alias = string;
export enum Choice { One }
export namespace Nested { export const item = 1; }
export interface Merged {}
export const Merged = 1;`,
    );
    await writeFile(`${dir}/middle.ts`, "export * from './decl.ts';");
    await writeFile(
      `${dir}/index.ts`,
      "export * from './middle.ts'; export type { Shape as OnlyType } from './decl.ts';",
    );
    const program = ts.createProgram([`${dir}/index.ts`], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowImportingTsExtensions: true,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const source = program.getSourceFile(`${dir}/index.ts`)!;
    const module = checker.getSymbolAtLocation(source)!;
    expect(exportsOfModule(checker, module)).toEqual([
      { name: 'fn', kind: 'function' },
      { name: 'Subject', kind: 'class' },
      { name: 'Merged', kind: 'const' },
      { name: 'value', kind: 'const' },
      { name: 'Merged', kind: 'interface' },
      { name: 'OnlyType', kind: 'interface' },
      { name: 'Shape', kind: 'interface' },
      { name: 'Alias', kind: 'type' },
      { name: 'Choice', kind: 'enum' },
      { name: 'Nested', kind: 'namespace' },
    ]);
  } finally {
    await rm(dir, { recursive: true });
  }
});
