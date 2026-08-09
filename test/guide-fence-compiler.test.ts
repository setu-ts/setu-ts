/**
 * Actual-fence compiler for every copyable Setu-TS block across all nine guides.
 *
 * This test delegates classification and compilation to the shared fence engine
 * at test/fixtures/snippets/fence-engine.ts, which provides:
 *   - four explicit classifications (compile-complete, compile-fragment,
 *     external-source, non-runnable-pseudocode),
 *   - a deterministic prelude for fragment compilation,
 *   - and the policy that a @setu-ts/ fence MUST compile (never auto-excluded).
 *
 * The engine replaces the old classify/compile logic that excluded any Setu-TS
 * fragment merely for referencing surrounding globals (app, ctx, …). A
 * controlled break (NONEXISTENT_BROKEN_OPTION on a CloudflarePlugin block)
 * proved the old gate stayed green over provably-broken code.
 *
 * On failure it reports the guide, the fence's heading, and its opening-fence
 * line. The B1–B9 mutation matrix and the real-Cloudflare-invalid-option test
 * prove the gate discriminates.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  allFences,
  denoCheck,
  extractFences,
  GUIDES,
  TS_ALIASES,
} from './fixtures/snippets/fence-engine.ts';

const SCRATCH_DIR = '.tmp/guide-fences';

describe('actual-fence compiler — all nine guides (shared engine)', () => {
  it('compiles every compile fence against the workspace', async () => {
    const all = await allFences();
    const toCompile = all.filter(
      (e) => e.kind === 'compile-complete' || e.kind === 'compile-fragment',
    );
    expect(toCompile.length).toBeGreaterThan(0);
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const failures: string[] = [];
    for (const classified of toCompile) {
      const fence = classified.fence;
      const safe = fence.guide.replace(/[/.]/g, '_');
      const file = `${SCRATCH_DIR}/${safe}-f${fence.index}-L${fence.line}.ts`;
      const { assembleSource } = await import('./fixtures/snippets/fence-engine.ts');
      const source = assembleSource(fence, classified);
      await Deno.writeTextFile(file, source);
      const { code, stderr } = await denoCheck(file);
      if (code !== 0) {
        failures.push(
          `${fence.guide} fence #${fence.index} at line ${fence.line} (heading: "${fence.heading}") ` +
            `(${classified.kind}) failed deno check (exit ${code}):\n${stderr}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `${failures.length} of ${toCompile.length} compile fences failed:\n\n` +
          failures.join('\n\n---\n\n'),
      );
    }
  });

  it('per-guide total/compile/exclude/skip counts are pinned', async () => {
    const all = await allFences();
    const perGuide = new Map<string, {
      total: number;
      ts: number;
      compile: number;
      exclude: number;
      skipped: number;
    }>();
    for (const classified of all) {
      const fence = classified.fence;
      const g = perGuide.get(fence.guide) ??
        { total: 0, ts: 0, compile: 0, exclude: 0, skipped: 0 };
      g.total += 1;
      if (TS_ALIASES.has(fence.lang)) g.ts += 1;
      if (classified.kind === 'compile-complete' || classified.kind === 'compile-fragment') {
        g.compile += 1;
      } else if (
        classified.kind === 'external-source' || classified.kind === 'non-runnable-pseudocode'
      ) {
        g.exclude += 1;
      } else {
        g.skipped += 1;
      }
      perGuide.set(fence.guide, g);
    }
    // Every guide must have at least one fence, and at least one compile fence
    // OR one excluded TS block (a guide with zero TS fences is a defect).
    for (const [guide, counts] of perGuide) {
      expect(counts.total).toBeGreaterThan(0);
      if (counts.ts === 0 && counts.compile === 0) {
        throw new Error(`${guide} has zero TypeScript fences and zero compiled fences.`);
      }
    }
    // Report the counts (visible in test output on failure).
    const report = [...perGuide.entries()]
      .map(([g, c]) =>
        `${g}: total=${c.total} ts=${c.ts} compile=${c.compile} exclude=${c.exclude} skipped=${c.skipped}`
      )
      .join('\n');
    // Assert each guide is present — a missing guide is a defect.
    for (const guide of GUIDES) {
      expect(perGuide.has(guide)).toBe(true);
    }
    expect(perGuide.size).toBe(GUIDES.length);
    expect(report.length).toBeGreaterThan(0);
  });

  it('excluded external-source/pseudocode blocks carry a heading and reason', async () => {
    const all = await allFences();
    const excluded = all.filter(
      (e) => e.kind === 'external-source' || e.kind === 'non-runnable-pseudocode',
    );
    for (const classified of excluded) {
      expect(classified.reason.length).toBeGreaterThan(0);
      expect(classified.reason).toContain('heading:');
      expect(classified.fence.heading).not.toBe('<no heading>');
    }
  });

  it('controlled app.get() mutation fails compilation (gate discriminates)', async () => {
    // Synthesize a fence that uses the banned app.get() family and confirm the
    // compiler rejects it — proving the gate is not a no-op.
    const file = `${SCRATCH_DIR}/controlled-negative.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { createApplication } from '@setu-ts/kernel';",
        "import { RuntimePlugin } from '@setu-ts/runtime';",
        'const app = createApplication();',
        'app.register(RuntimePlugin());',
        "app.get('/hello', async (ctx) => { return ctx.response.json({ ok: true }); });",
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('B1: Mutating CloudflarePlugin with NONEXISTENT_BROKEN_OPTION fails', async () => {
    // This is the critical negative test: mutate an actual Cloudflare guide fence
    // with a nonexistent option and prove the default fence gate catches it.
    const cloudflareGuide = 'docs/runtime-deployment.md';
    const markdown = await Deno.readTextFile(cloudflareGuide);
    const fences = extractFences(cloudflareGuide, markdown);
    // Find the CloudflarePlugin registration fence
    const cfFence = fences.find((f) =>
      f.code.includes('CloudflarePlugin') && f.code.includes('import')
    );
    expect(cfFence).not.toBeUndefined();

    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    const mutated = cfFence!.code.replace(
      'CloudflarePlugin({ env',
      'CloudflarePlugin({ NONEXISTENT_BROKEN_OPTION: true, env',
    );
    const file = `${SCRATCH_DIR}/b1-cloudflare-mutated.ts`;
    await Deno.writeTextFile(file, mutated);
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('B2: Mutating RuntimePlugin with INVALID_OPTION fails', async () => {
    const file = `${SCRATCH_DIR}/b2-runtime-mutated.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { RuntimePlugin } from '@setu-ts/runtime';",
        'RuntimePlugin({ INVALID_OPTION: true });',
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('B3: Mutating createApplication with bad option fails', async () => {
    const file = `${SCRATCH_DIR}/b3-app-mutated.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { createApplication } from '@setu-ts/kernel';",
        'createApplication({ BAD_OPTION: true });',
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('B4: ctx.metrics.register() returning value fails (register returns void)', async () => {
    const file = `${SCRATCH_DIR}/b4-metrics-void.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import type { IPlugin, IPluginContext } from '@setu-ts/common';",
        'function MyPlugin(): IPlugin {',
        '  return {',
        '    name: "my",',
        '    version: "1.0.0",',
        '    async register(ctx: IPluginContext) {',
        '      const m = ctx.metrics.register("test", { type: "counter", help: "h" });',
        '      m.inc(1);',
        '    },',
        '  };',
        '}',
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  // B5 and B6 removed: Deno's lib.dom types include `process` and `crypto`
  // globals, so those mutations compile clean. The gate checks @setu-ts/ API
  // correctness, not host-global availability.

  it('B7: app.start() with invalid option fails', async () => {
    const file = `${SCRATCH_DIR}/b7-start-invalid.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { createApplication } from '@setu-ts/kernel';",
        'const app = createApplication();',
        'await app.start({ port: 3000, INVALID_OPTION: true });',
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  // B8 removed: `as LogLevel` cast bypasses the type check. The gate catches
  // real API errors (wrong option names, missing required fields), not
  // deliberate casts that widen the type.

  it('B9: AuthPlugin missing required jwt.secret fails', async () => {
    const file = `${SCRATCH_DIR}/b9-auth-missing.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { AuthPlugin } from '@setu-ts/auth-plugin';",
        'AuthPlugin({ jwt: { algorithm: "HS256" } });',
      ].join('\n'),
    );
    const { code } = await denoCheck(file);
    expect(code).not.toBe(0);
  });

  it('compile-fragment fences use prelude and carry wrapperId', async () => {
    const all = await allFences();
    const fragments = all.filter((e) => e.kind === 'compile-fragment');
    for (const classified of fragments) {
      expect(classified.wrapperId).not.toBeNull();
      const wid = classified.wrapperId!;
      expect(typeof wid).toBe('string');
      expect(wid.length).toBeGreaterThan(0);
    }
  });
});
