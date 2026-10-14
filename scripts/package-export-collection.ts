import { readFile } from 'node:fs/promises';
/**
 * Resolve every published barrel through one TypeScript program. Re-exports
 * follow their declaring symbols before the pure README table renderer reads them.
 * @module
 */

import type { PackageExports } from './package-exports.ts';
import ts from 'typescript';
import { resolve } from 'node:path';

export * from './package-exports.ts';

/**
 * Expands a package manifest's `exports` map into local barrel targets.
 *
 * @param pkgPath - Workspace-relative package directory
 * @returns Import specifier and workspace-relative target for each entrypoint
 */
export async function entrypointsFor(
  pkgPath: string,
): Promise<{ specifier: string; target: string }[]> {
  const manifest = JSON.parse(await readFile(`${pkgPath}/deno.json`, 'utf8')) as {
    name?: string;
    exports?: string | Record<string, string>;
  };
  const name = manifest.name ?? `@setu-ts/${pkgPath.split('/').pop()}`;
  const exports = manifest.exports;
  if (exports === undefined) return [];

  const strip = (target: string): string => `${pkgPath}/${target.replace(/^\.\//, '')}`;

  if (typeof exports === 'string') {
    return [{ specifier: name, target: strip(exports) }];
  }
  return Object.entries(exports).map(([key, target]) => ({
    specifier: key === '.' ? name : `${name}${key.replace(/^\./, '')}`,
    target: strip(target),
  }));
}

/**
 * Collects the exported symbols of every given package.
 *
 * One compiler program covers every barrel so aliases resolve against one source graph.
 *
 * @param packages - Workspace-relative package directories
 * @returns Exports grouped by package path, in manifest order
 * @throws {Error} If the configuration or an export cannot be resolved
 */
export async function collectPackageExports(
  packages: readonly string[],
): Promise<Map<string, PackageExports[]>> {
  const perPackage = new Map<string, { specifier: string; target: string }[]>();
  const allTargets: string[] = [];
  for (const pkgPath of packages) {
    const entrypoints = await entrypointsFor(pkgPath);
    perPackage.set(pkgPath, entrypoints);
    for (const entry of entrypoints) allTargets.push(entry.target);
  }

  const config = ts.readConfigFile('tsconfig.docs.json', ts.sys.readFile);
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, '.');
  const program = ts.createProgram(allTargets, parsed.options);
  const checker = program.getTypeChecker();
  const result = new Map<string, PackageExports[]>();
  for (const [pkgPath, entrypoints] of perPackage) {
    const groups: PackageExports[] = [];
    for (const entry of entrypoints) {
      const source =
        program.getSourceFile(resolve(entry.target)) ?? program.getSourceFile(entry.target);
      const module = source && checker.getSymbolAtLocation(source);
      if (!module) throw new Error(`No module symbol for ${entry.target}`);
      groups.push({ specifier: entry.specifier, symbols: exportsOfModule(checker, module) });
    }
    result.set(pkgPath, groups);
  }
  return result;
}

/** Follow re-exports to their declaration and retain merged declaration kinds. */
export function exportsOfModule(
  checker: ts.TypeChecker,
  module: ts.Symbol,
): import('./package-exports.ts').ExportedSymbol[] {
  const result: import('./package-exports.ts').ExportedSymbol[] = [];
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol =
      exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const kinds = new Set<string>();
    for (const declaration of symbol.declarations ?? []) {
      const flags = ts.isFunctionDeclaration(declaration)
        ? ts.SymbolFlags.Function
        : ts.isClassDeclaration(declaration)
          ? ts.SymbolFlags.Class
          : ts.isInterfaceDeclaration(declaration)
            ? ts.SymbolFlags.Interface
            : ts.isTypeAliasDeclaration(declaration)
              ? ts.SymbolFlags.TypeAlias
              : ts.isEnumDeclaration(declaration)
                ? ts.SymbolFlags.RegularEnum
                : ts.isModuleDeclaration(declaration)
                  ? ts.SymbolFlags.NamespaceModule
                  : ts.isVariableDeclaration(declaration)
                    ? ts.SymbolFlags.BlockScopedVariable
                    : symbol.flags;
      kinds.add(symbolKind(flags));
    }
    if (!kinds.size) throw new Error(`Unresolved export ${exported.name}`);
    for (const kind of kinds) result.push({ name: exported.name, kind });
  }
  const order = ['function', 'class', 'const', 'interface', 'type', 'enum', 'namespace', 'module'];
  return result.sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

/** Compiler symbol flags mapped to the existing README vocabulary. */
export function symbolKind(flags: ts.SymbolFlags): string {
  if (flags & ts.SymbolFlags.Function) return 'function';
  if (flags & ts.SymbolFlags.Class) return 'class';
  if (flags & ts.SymbolFlags.Variable) return 'const';
  if (flags & ts.SymbolFlags.Interface) return 'interface';
  if (flags & ts.SymbolFlags.TypeAlias) return 'type';
  if (flags & ts.SymbolFlags.Enum) return 'enum';
  if (flags & ts.SymbolFlags.Namespace) return 'namespace';
  throw new Error(`Unsupported export flags ${flags}`);
}
