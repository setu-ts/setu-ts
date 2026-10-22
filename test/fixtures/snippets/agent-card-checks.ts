/** Shared card/rule checks; all fence classification stays in fence-engine. */
import { mkdir, writeFile } from 'node:fs/promises';
import type { Worker } from 'node:worker_threads';
import { collectPackageExports } from '../../../scripts/package-export-collection.ts';
import {
  assembleSource,
  classify,
  compileFence,
  extractFences,
  fenceExtension,
  TS_ALIASES,
  writeProjectStubs,
} from './fence-engine.ts';

const GLOBAL_IDENTIFIERS = new Set([
  'Array',
  'ArrayBuffer',
  'BigInt',
  'Boolean',
  'Date',
  'Error',
  'Headers',
  'JSON',
  'Map',
  'Math',
  'Number',
  'Object',
  'Promise',
  'Record',
  'Request',
  'Response',
  'Set',
  'String',
  'Symbol',
  'URL',
  'Uint8Array',
  'WeakMap',
  'WeakSet',
  'Readonly',
  'ReadonlyArray',
  'Partial',
  'Pick',
  'Omit',
  'async',
  'await',
  'boolean',
  'const',
  'false',
  'function',
  'import',
  'interface',
  'never',
  'null',
  'number',
  'return',
  'string',
  'true',
  'type',
  'undefined',
  'unknown',
  'void',
]);

/** Build an inventory using the same compiler export walk as README tables. */
export async function exportedIdentifiers(
  packages: readonly string[],
): Promise<Map<string, ReadonlySet<string>>> {
  const exports = await collectPackageExports(packages);
  return new Map(
    [...exports].map(([pkg, groups]) => [
      pkg,
      new Set(groups.flatMap((g) => g.symbols.map((symbol) => symbol.name))),
    ]),
  );
}

/** Union own/common exports with exports of every package named by the card. */
export function allowedCardIdentifiers(
  source: string,
  ownPackage: string,
  inventory: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string> {
  const named = new Set([...source.matchAll(/@setu-ts\/([a-z0-9-]+)/g)].map((m) => m[1]));
  return new Set(
    [...inventory]
      .filter(
        ([pkg]) =>
          pkg === ownPackage || pkg === 'packages/common' || named.has(pkg.split('/').at(-1)!),
      )
      .flatMap(([, symbols]) => [...symbols]),
  );
}

/** Check inline code spans; snippets themselves are type-checked rather than tokenized. */
export function identifierProblems(
  source: string,
  allowed: ReadonlySet<string>,
): readonly string[] {
  const local = new Set(
    [...source.matchAll(/<!-- card-allow: ([\s\S]*?) -->/g)].flatMap((m) => m[1].split(/\s+/)),
  );
  const prose = source.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, '');
  const problems: string[] = [];
  for (const match of prose.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1];
    if (
      span.includes('/') ||
      span.includes(' ') ||
      /^(?:@setu-ts\/|npx|npm|bun|deno|setu)/.test(span)
    )
      continue;
    const id = /^@?([A-Z][\w$]*|[a-z][\w$]*(?=[(<]))/.exec(span)?.[1];
    if (id !== undefined && !allowed.has(id) && !GLOBAL_IDENTIFIERS.has(id) && !local.has(id))
      problems.push(id);
  }
  return problems;
}

/** Compile every TypeScript fence through the existing engine and return its count. */
/**
 * Compiles every TypeScript fence in `source` and returns how many there were.
 * Pass one `context` across a whole inventory: each context owns a compiler
 * worker thread with its cache, and a context per card leaves one live worker
 * per card (about 25 GB for the full card set). The caller terminates it.
 */
export async function checkFences(
  label: string,
  source: string,
  scratch: string,
  context: { worker?: Worker } = {},
): Promise<number> {
  await mkdir(scratch, { recursive: true });
  await writeProjectStubs(scratch);
  let count = 0;
  for (const fence of extractFences(label, source).filter((f) => TS_ALIASES.has(f.lang))) {
    const classified = classify(fence);
    if (classified.kind !== 'compile-complete' && classified.kind !== 'compile-fragment') {
      throw new Error(`${label}: fence ${fence.index} is not compilable: ${classified.kind}`);
    }
    count++;
    const path = `${scratch}/${label.replaceAll(/[^\w-]/g, '_')}-${fence.index}.${fenceExtension(fence.lang)}`;
    await writeFile(path, assembleSource(fence, classified));
    const result = await compileFence(path, context);
    if (result.code !== 0) throw new Error(`${label}: fence ${fence.index}: ${result.stderr}`);
  }
  return count;
}

/**
 * Fences that resolve a capability from an application before starting it.
 *
 * Plugins register during `start()`, so `app.services.get(...)` straight after
 * `createApplication(...)` compiles and throws at run time — the M70i documented
 * crash. Batch 2 of the M116 cards shipped it three times; the compiler cannot see it.
 * Reads inside a handler use `ctx.services` and are not affected.
 */
export function prematureResolutions(source: string): readonly number[] {
  const fences = [...source.matchAll(/^```(?:ts|typescript)\n([\s\S]*?)^```\s*$/gm)].map(
    (m) => m[1],
  );
  return fences.flatMap((code, index) => {
    const get = code.indexOf('app.services.get');
    if (get === -1) return [];
    const start = code.indexOf('app.start(');
    return start !== -1 && start < get ? [] : [index];
  });
}
