/**
 * The two-phase test partition covers the whole suite and isolates every hazard.
 *
 * `scripts/test-partition-rules.ts` derives the split on every run rather than reading
 * a committed list, so the usual drift failure cannot happen. What CAN still go
 * wrong is the rule itself: a signal dropped from
 * {@linkcode isolationReason}'s alternation would move a hazardous suite into
 * the parallel phase silently, and the result is an intermittent CI failure in
 * some unrelated suite — the outcome that got PR #339 reverted.
 *
 * So the assertions here are about the PROPERTY, not about a list of names: the
 * two phases reconcile with the tracked tree, and no file in the parallel phase
 * carries any hazard signal at all. The named cases at the end are the two
 * suites that actually flaked, kept as regression anchors.
 *
 * @module
 */

import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  discoverTestFiles,
  isolationReason,
  partitionTests,
} from '../../scripts/test-partition-rules.ts';

/** The suite that failed on CI under the reverted, narrower partition. */
const CI_FLAKE = 'packages/storage-plugin/test/integration/stream-backpressure-real.test.ts';
/** The suite that failed locally under the reverted, narrower partition. */
const LOCAL_FLAKE = 'packages/cli/test/e2e/workspace-mesh-e2e.test.ts';

describe('test partition', () => {
  it('reconciles with the discovered test tree', async () => {
    const tracked = await discoverTestFiles();
    const { isolated, hermetic } = await partitionTests();

    // Vacuity guard: an empty listing would satisfy every set assertion below.
    expect(tracked.length).toBeGreaterThan(1000);
    expect(isolated.length).toBeGreaterThan(0);
    expect(hermetic.length).toBeGreaterThan(0);

    // Every file lands in exactly one phase, and no phase invents a file.
    expect(isolated.length + hermetic.length).toBe(tracked.length);
    expect([...isolated, ...hermetic].sort()).toEqual([...tracked].sort());
    const overlap = isolated.filter((path) => hermetic.includes(path));
    expect(overlap).toEqual([]);
  });

  it('leaves no hazard signal in the parallel phase', async () => {
    // The real safety property, and it is checked against an INDEPENDENT marker
    // list rather than by re-calling `isolationReason`.
    //
    // The first version of this test did re-call it, which made it tautological:
    // the classifier trivially agrees with itself, so neutering
    // `BACKEND_VARIABLES` left this assertion green while every real-backend
    // suite moved into the parallel phase — the precise hole that got PR #339
    // reverted. Verified by doing exactly that.
    //
    // So the duplication below is deliberate and is the whole point: §11.1
    // forbids a second copy of LOGIC, and a gate that reads the same constant it
    // is verifying cannot fail. If a marker belongs here and not in the
    // classifier, this test is what says so.
    const MARKERS = [
      'REDIS_URL',
      'RABBITMQ_URL',
      'S3_ENDPOINT_URL',
      'SMTP_URL',
      'MONGODB_URI',
      'DYNAMODB_ENDPOINT',
      'BIGTABLE_EMULATOR_ENDPOINT',
      'NATS_URL',
      'KAFKA_BROKERS',
      'SQS_ENDPOINT_URL',
      'Deno.Command',
      'unusedPort',
      'Deno.listen',
      'Deno.serve',
    ];
    const { hermetic } = await partitionTests();
    const leaked: string[] = [];
    for (const path of hermetic) {
      if (path.includes('/test/e2e/') || path.endsWith('-e2e.test.ts')) {
        leaked.push(`${path} (e2e in the parallel phase)`);
        continue;
      }
      const source = await Deno.readTextFile(path);
      const marker = MARKERS.find((name) => source.includes(name));
      if (marker !== undefined) leaked.push(`${path} (${marker})`);
    }
    expect(leaked).toEqual([]);
  });

  it('records a reason for every isolated suite', async () => {
    const { isolated, reasons } = await partitionTests();
    const unexplained = isolated.filter((path) => !reasons.has(path));
    expect(unexplained).toEqual([]);
  });

  it('classifies a file the git index does not name', async () => {
    // Review of #343 found the file set came from `git ls-files`, so an UNTRACKED
    // suite — one written but not yet staged — was classified by neither phase
    // while `deno test` still enumerated it, i.e. it ran in parallel whatever it
    // touched. Reproduced before the fix. It also made this module's own claim
    // that a suite is isolated "the moment it is written" false until staged.
    const path = 'packages/kernel/test/unit/zz-partition-probe.test.ts';
    await Deno.writeTextFile(
      path,
      "import { describe, it } from '@std/testing/bdd';\n" +
        "describe('probe', () => { it('REDIS_URL', () => {}); });\n",
    );
    try {
      const { isolated, reasons } = await partitionTests();
      expect(isolated).toContain(path);
      expect(reasons.get(path)).toBe('shared backend (REDIS_URL)');
    } finally {
      await Deno.remove(path);
    }
  });

  it('never yields a path that is not on disk', async () => {
    // The other half of the same finding: `git ls-files` names a path left by an
    // unstaged `rm`, and reading it threw a bare `NotFound` — which, because this
    // runs before the suite, took `deno task test` down entirely rather than
    // simply not running that file. A walk cannot name a file that is not there,
    // which is the property this asserts: discovered, then removed, then gone.
    const path = 'packages/kernel/test/unit/zz-vanishing-probe.test.ts';
    await Deno.writeTextFile(path, "import '@std/expect';\n");
    expect(await discoverTestFiles()).toContain(path);
    await Deno.remove(path);
    expect(await discoverTestFiles()).not.toContain(path);
    // And the default path still classifies cleanly with it gone.
    const { isolated, hermetic } = await partitionTests();
    expect(isolated.length + hermetic.length).toBe((await discoverTestFiles()).length);
  });

  it("discovers Deno's other test-file shapes", async () => {
    // `deno test` runs `*_test.ts` and a bare `test.ts` as well as `*.test.ts`.
    // Matching only the last left the other two unclassified while phase 2 still
    // enumerated them, i.e. running in parallel whatever they touched.
    //
    // This drives DISCOVERY, not `isolationReason`. A first version of this test
    // asserted `isolationReason('…/a_test.ts', …)`, which passes whatever the
    // file-shape pattern is — that function classifies any path handed to it and
    // never filters by name — so it could not see the defect at all. Narrowing
    // the pattern back to `*.test.ts` left it green; it now fails.
    const directory = 'packages/kernel/test/unit';
    const shapes = [`${directory}/zz_shape_test.ts`, `${directory}/zz-shape-dir/test.ts`];
    await Deno.mkdir(`${directory}/zz-shape-dir`, { recursive: true });
    await Deno.writeTextFile(shapes[0] as string, "import '@std/expect';\n");
    await Deno.writeTextFile(shapes[1] as string, "import '@std/expect';\n");
    try {
      const discovered = await discoverTestFiles();
      for (const shape of shapes) expect(discovered).toContain(shape);
    } finally {
      await Deno.remove(shapes[0] as string);
      await Deno.remove(`${directory}/zz-shape-dir`, { recursive: true });
    }
  });

  it('isolates both suites that actually flaked', async () => {
    // These two are why the first attempt was reverted. The CI one is the
    // instructive case: it is an INTEGRATION suite against real MinIO, so a
    // partition keyed on "e2e or restarts a container" left it in parallel.
    const { reasons } = await partitionTests();
    expect(reasons.get(CI_FLAKE)).toBe('shared backend (S3_ENDPOINT_URL)');
    expect(reasons.get(LOCAL_FLAKE)).toBe('e2e');
  });

  describe('isolationReason', () => {
    it('isolates an e2e suite whatever its contents', () => {
      expect(isolationReason('packages/x/test/e2e/a.test.ts', 'const a = 1;')).toBe('e2e');
      expect(isolationReason('packages/x/test/unit/a-e2e.test.ts', 'const a = 1;')).toBe('e2e');
    });

    it('isolates a suite naming a shared backend, including in a comment', () => {
      expect(isolationReason('t/a.test.ts', '// guarded on REDIS_URL\n'))
        .toBe('shared backend (REDIS_URL)');
    });

    it('isolates a subprocess spawner', () => {
      expect(isolationReason('t/a.test.ts', 'new Deno.Command("deno")'))
        .toBe('spawns a subprocess');
    });

    it('isolates a suite that binds a port', () => {
      for (
        const source of ['unusedPort()', 'Deno.listen({})', 'Deno.serve(h)', 'app.start({ port })']
      ) {
        expect(isolationReason('t/a.test.ts', source)).toBe('binds a port');
      }
    });

    it('leaves an ordinary unit suite in the parallel phase', () => {
      expect(isolationReason('packages/x/test/unit/a.test.ts', 'expect(1).toBe(1);')).toBeNull();
    });

    it('reports the structural reason ahead of a content one', () => {
      // An e2e suite that also names a backend is reported as e2e, so the reason
      // is stable regardless of what the file happens to contain.
      expect(isolationReason('packages/x/test/e2e/a.test.ts', 'REDIS_URL')).toBe('e2e');
    });
  });
});
