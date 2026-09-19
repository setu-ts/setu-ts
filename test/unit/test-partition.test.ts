/**
 * The test suite runs in two phases, and this pins the partition between them.
 *
 * Phase 1 (`test:isolated`) runs ALONE and sequentially: every end-to-end suite,
 * and every suite that drives `docker` into a different state. Phase 2
 * (`test:bulk`) is everything else, in parallel.
 *
 * **Both exclusions were established by measurement, not by caution.** A first
 * cut isolated only the ten container-mutating suites and left the e2e ones in
 * parallel. It passed twice and failed on the THIRD run —
 * `workspace-mesh-e2e`'s "one service call BOTH its peers over HTTP", which
 * boots three services on real ports. Two green runs were not evidence; the
 * wider set has since run clean three times over.
 *
 * Measured at `DENO_JOBS=4`, approximating a GitHub runner: 323s sequential
 * becomes 175s isolated + 51s parallel. The narrower split was faster (168s)
 * and is the one that flakes, which is the trade this file records.
 *
 * The danger a split introduces is a file landing in NEITHER phase, or a new
 * e2e/container suite landing in the parallel one, where it breaks unrelated
 * tests intermittently — the worst kind of failure to debug. Both are checked.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { walk } from 'jsr:@std/fs@^1.0.19';

/** This file's own path, which its detector below would otherwise match. */
const SELF = 'test/unit/test-partition.test.ts';

const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
  readonly tasks: Record<string, string>;
};

/** The `--ignore=` list a task carries, as paths. */
function ignored(task: string): readonly string[] {
  const match = /--ignore=(\S+)/.exec(task);
  return match?.[1]?.split(',').filter((path) => path !== '') ?? [];
}

/** The bare test paths a task passes, excluding flags. */
function explicitFiles(task: string): readonly string[] {
  // `--ignore=a.test.ts,…` also ends in `.test.ts`, so flags go first —
  // otherwise the whole ignore list arrives as a single "file".
  return task.split(/\s+/).filter((token) => !token.startsWith('-') && token.endsWith('.test.ts'));
}

/** Every test file the suite picks up. */
async function allTestFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const root of ['packages', 'test']) {
    for await (const entry of walk(root, { exts: ['.ts'], includeDirs: false })) {
      if (entry.path.endsWith('.test.ts')) found.push(entry.path.replaceAll('\\', '/'));
    }
  }
  return found.sort();
}

/** Suites that must not run beside anything else. */
async function mustIsolate(): Promise<readonly string[]> {
  const required: string[] = [];
  for (const file of await allTestFiles()) {
    if (file === SELF) continue;
    // Every e2e suite: they bind real ports and boot servers, which is what
    // made `workspace-mesh-e2e` flake in parallel.
    if (file.includes('/e2e/')) {
      required.push(file);
      continue;
    }
    const source = await Deno.readTextFile(file);
    if (!/\bdocker\b/.test(source)) continue;
    // A suite that merely TALKS to a backend is safe in parallel; one that
    // stops it is not — it breaks every other suite mid-flight.
    if (/'(?:stop|start|pause|unpause|restart)'|docker (?:stop|start|pause|restart)/.test(source)) {
      required.push(file);
    }
  }
  return required;
}

describe('the two-phase test partition', () => {
  it('runs the isolated phase before the parallel one', () => {
    expect(manifest.tasks['test']).toBe('deno task test:isolated && deno task test:bulk');
  });

  it('gives both phases the same isolate list, so they cannot drift', () => {
    // The list appears as explicit paths in `test:isolated` and as `--ignore`
    // in `test:bulk`; `test:coverage` inlines both. A file dropped from one and
    // not the other would either run twice or not at all.
    const isolated = [...explicitFiles(manifest.tasks['test:isolated'] ?? '')].sort();
    expect(isolated.length).toBeGreaterThan(0);
    expect([...ignored(manifest.tasks['test:bulk'] ?? '')].sort()).toEqual(isolated);

    const coverage = manifest.tasks['test:coverage'] ?? '';
    expect([...explicitFiles(coverage)].sort()).toEqual(isolated);
    expect([...ignored(coverage)].sort()).toEqual(isolated);
  });

  it('isolates every e2e suite and every container-mutating one', async () => {
    const isolated = new Set(explicitFiles(manifest.tasks['test:isolated'] ?? ''));
    const missing = (await mustIsolate()).filter((file) => !isolated.has(file));
    expect(missing).toEqual([]);
  });

  it('names only files that exist, so a rename cannot silently drop one', async () => {
    const all = new Set(await allTestFiles());
    for (const file of explicitFiles(manifest.tasks['test:isolated'] ?? '')) {
      expect(all.has(file), `${file} is isolated but does not exist`).toBe(true);
    }
  });
});
