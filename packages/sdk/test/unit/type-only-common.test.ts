import { denoBinary, run as runProcess } from '../../../../test/node-helpers.ts';
import * as nodeFs from 'node:fs/promises';
/**
 * The SDK's `common` imports stay type-only (M98n §3.3, audit row O10), with
 * one allowed exception: value imports from `@setu-ts/common/breaker-window`,
 * the dependency-free module holding the circuit-breaker trip rule both
 * breakers share. The outbound HTTP collector is a deliberate local copy
 * precisely so the browser-portable SDK carries no other `common` runtime
 * code. Both a source scan and the module graph are checked, so a value import
 * cannot slip in either way.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

const SRC = new URL('../../src/', import.meta.url);
/** The one `common` specifier the SDK may import values from. */
const ALLOWED_VALUE_SPECIFIER = '@setu-ts/common/breaker-window';
/** Maps `@setu-ts/*` and the subpath to source, so `deno info` sees `src`, not unbuilt `dist`. */
const LANE_CONFIG = new URL('../../../../test/deno-lane/lane.config.json', import.meta.url);

async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for await (const entry of await nodeFs.opendir(dir)) {
    const child = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(child)));
    } else if (entry.name.endsWith('.ts')) {
      files.push(child);
    }
  }
  return files;
}

describe('@setu-ts/sdk — common imports are type-only except the breaker window', () => {
  it('every import from @setu-ts/common is `import type`, except the breaker window', async () => {
    const offenders: string[] = [];
    let seen = 0;
    let allowed = 0;
    for (const file of await sourceFiles(SRC)) {
      const text = await nodeFs.readFile(file, 'utf8');
      for (const match of text.matchAll(/^\s*(import|export)\b([^;]*?)from\s+'([^']+)'/gms)) {
        const specifier = match[3]!;
        if (!specifier.includes('@setu-ts/common')) {
          continue;
        }
        seen++;
        if (/^\s*(import|export)\s+type\b/.test(match[0])) {
          continue;
        }
        if (specifier === ALLOWED_VALUE_SPECIFIER) {
          allowed++;
          continue;
        }
        offenders.push(`${file.pathname}: ${specifier}`);
      }
    }
    // Positive controls: the scan really sees the SDK's common imports, and the
    // allowed value import is really there.
    expect(seen).toBeGreaterThanOrEqual(5);
    expect(allowed).toBeGreaterThanOrEqual(1);
    expect(offenders).toEqual([]);
  });

  it('the only module-graph edge into common carrying runtime code is the breaker window, a leaf', async () => {
    const output = await runProcess(denoBinary(), {
      args: [
        'info',
        '--json',
        '--no-lock',
        '--config',
        LANE_CONFIG.pathname,
        new URL('index.ts', SRC).pathname,
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    expect(output.success).toBe(true);
    const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
      modules: {
        specifier: string;
        dependencies?: {
          specifier: string;
          code?: { specifier?: string };
          type?: unknown;
        }[];
      }[];
    };
    const sdkModules = graph.modules.filter((module) =>
      module.specifier.includes('/packages/sdk/src/'),
    );
    let commonEdges = 0;
    const runtimeEdges: string[] = [];
    const resolvedRuntime = new Set<string>();
    for (const module of sdkModules) {
      for (const dependency of module.dependencies ?? []) {
        if (dependency.specifier.includes('@setu-ts/common')) {
          commonEdges++;
          if (dependency.code !== undefined) {
            runtimeEdges.push(dependency.specifier);
            resolvedRuntime.add(dependency.code.specifier ?? '');
          }
        }
      }
    }
    expect(commonEdges).toBeGreaterThanOrEqual(5);
    // Positive control: the breaker's value import is seen as a runtime edge.
    expect(runtimeEdges.length).toBeGreaterThanOrEqual(1);
    expect(new Set(runtimeEdges)).toEqual(new Set([ALLOWED_VALUE_SPECIFIER]));
    expect([...resolvedRuntime]).toHaveLength(1);
    const leaf = [...resolvedRuntime][0]!;
    expect(leaf.endsWith('/packages/common/src/services/breaker-window.ts')).toBe(true);
    const leafModule = graph.modules.find((module) => module.specifier === leaf);
    expect(leafModule).toBeDefined();
    const leafRuntimeDeps = (leafModule!.dependencies ?? []).filter(
      (dependency) => dependency.code !== undefined,
    );
    expect(leafRuntimeDeps).toEqual([]);
  });
});
