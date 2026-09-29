/**
 * The SDK's `common` imports stay type-only (M98n §3.3, audit row O10): the
 * outbound HTTP collector is a deliberate local copy precisely so the
 * browser-portable SDK carries no `common` runtime code. Both a source scan
 * and the module graph are checked, so a value import cannot slip in either
 * way.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const SRC = new URL('../../src/', import.meta.url);

async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) {
      files.push(...await sourceFiles(child));
    } else if (entry.name.endsWith('.ts')) {
      files.push(child);
    }
  }
  return files;
}

describe('@setu-ts/sdk — common imports are type-only', () => {
  it('every import from @setu-ts/common is written `import type`', async () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of await sourceFiles(SRC)) {
      const text = await Deno.readTextFile(file);
      for (const match of text.matchAll(/^\s*(import|export)\b([^;]*?)from\s+'([^']+)'/gms)) {
        if (!match[3]!.includes('@setu-ts/common')) {
          continue;
        }
        seen++;
        if (!/^\s*(import|export)\s+type\b/.test(match[0])) {
          offenders.push(file.pathname);
        }
      }
    }
    // Positive control: the scan really sees the SDK's common imports.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });

  it('no module-graph edge into common carries runtime code', async () => {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ['info', '--json', new URL('index.ts', SRC).pathname],
      stdout: 'piped',
      stderr: 'piped',
    }).output();
    expect(output.success).toBe(true);
    const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: {
        specifier: string;
        dependencies?: { specifier: string; code?: unknown; type?: unknown }[];
      }[];
    };
    const sdkModules = graph.modules.filter((module) =>
      module.specifier.includes('/packages/sdk/src/')
    );
    let commonEdges = 0;
    const runtimeEdges: string[] = [];
    for (const module of sdkModules) {
      for (const dependency of module.dependencies ?? []) {
        if (dependency.specifier.includes('@setu-ts/common')) {
          commonEdges++;
          if (dependency.code !== undefined) {
            runtimeEdges.push(module.specifier);
          }
        }
      }
    }
    expect(commonEdges).toBeGreaterThanOrEqual(5);
    expect(runtimeEdges).toEqual([]);
  });
});
