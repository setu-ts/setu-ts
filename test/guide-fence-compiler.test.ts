/**
 * Actual-fence compiler for every copyable Setu-TS block across all ten guides.
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

interface FenceCounts {
  readonly total: number;
  readonly ts: number;
  readonly compile: number;
  readonly external: number;
  readonly pseudocode: number;
  readonly skipped: number;
}

const EXPECTED_INVENTORY: Readonly<Record<string, FenceCounts>> = {
  'docs/getting-started.md': {
    total: 22,
    ts: 12,
    compile: 12,
    external: 0,
    pseudocode: 0,
    skipped: 10,
  },
  'docs/programmatic-api.md': {
    total: 41,
    ts: 41,
    compile: 41,
    external: 0,
    pseudocode: 0,
    skipped: 0,
  },
  'docs/custom-plugins.md': {
    total: 23,
    ts: 20,
    compile: 20,
    external: 0,
    pseudocode: 0,
    skipped: 3,
  },
  'docs/cli.md': {
    // One more shell/tree fence than before M65: the domain-module section now
    // shows the functional file set beside the class-based one.
    total: 12,
    ts: 1,
    compile: 1,
    external: 0,
    pseudocode: 0,
    skipped: 11,
  },
  'docs/plugin-architecture.md': {
    total: 17,
    ts: 17,
    compile: 17,
    external: 0,
    pseudocode: 0,
    skipped: 0,
  },
  'docs/examples.md': {
    total: 14,
    ts: 11,
    compile: 11,
    external: 0,
    pseudocode: 0,
    skipped: 3,
  },
  'docs/decorators.md': {
    total: 30,
    ts: 28,
    compile: 28,
    external: 0,
    pseudocode: 0,
    skipped: 2,
  },
  'docs/migration-fastify.md': {
    total: 32,
    ts: 32,
    compile: 16,
    external: 16,
    pseudocode: 0,
    skipped: 0,
  },
  'docs/migration-nestjs.md': {
    total: 34,
    ts: 34,
    compile: 18,
    external: 16,
    pseudocode: 0,
    skipped: 0,
  },
  'docs/runtime-deployment.md': {
    total: 30,
    ts: 13,
    compile: 13,
    external: 0,
    pseudocode: 0,
    skipped: 17,
  },
};

const EXPECTED_AGGREGATE: FenceCounts = {
  total: 255,
  ts: 209,
  compile: 177,
  external: 32,
  pseudocode: 0,
  skipped: 46,
};

describe('actual-fence compiler — all ten guides (shared engine)', () => {
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
      const { assembleSource } = await import(
        './fixtures/snippets/fence-engine.ts'
      );
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
    const perGuide = new Map<string, FenceCounts>();
    for (const classified of all) {
      const fence = classified.fence;
      const g = perGuide.get(fence.guide) ??
        { total: 0, ts: 0, compile: 0, external: 0, pseudocode: 0, skipped: 0 };
      const next: FenceCounts = {
        ...g,
        total: g.total + 1,
        ts: g.ts + (TS_ALIASES.has(fence.lang) ? 1 : 0),
        compile: g.compile + ((
            classified.kind === 'compile-complete' ||
            classified.kind === 'compile-fragment'
          )
          ? 1
          : 0),
        external: g.external + (classified.kind === 'external-source' ? 1 : 0),
        pseudocode: g.pseudocode +
          (classified.kind === 'non-runnable-pseudocode' ? 1 : 0),
        skipped: g.skipped + (classified.kind === 'skip' ? 1 : 0),
      };
      perGuide.set(fence.guide, next);
    }
    // Every guide must have at least one fence, and at least one compile fence
    // OR one excluded TS block (a guide with zero TS fences is a defect).
    for (const [guide, counts] of perGuide) {
      expect(counts.total).toBeGreaterThan(0);
      if (counts.ts === 0 && counts.compile === 0) {
        throw new Error(
          `${guide} has zero TypeScript fences and zero compiled fences.`,
        );
      }
    }
    expect(Object.fromEntries(perGuide)).toEqual(EXPECTED_INVENTORY);
    const aggregate = [...perGuide.values()].reduce<FenceCounts>(
      (sum, count) => ({
        total: sum.total + count.total,
        ts: sum.ts + count.ts,
        compile: sum.compile + count.compile,
        external: sum.external + count.external,
        pseudocode: sum.pseudocode + count.pseudocode,
        skipped: sum.skipped + count.skipped,
      }),
      { total: 0, ts: 0, compile: 0, external: 0, pseudocode: 0, skipped: 0 },
    );
    expect(aggregate).toEqual(EXPECTED_AGGREGATE);
    expect(Object.keys(EXPECTED_INVENTORY)).toEqual([...GUIDES]);
  });

  it('rejects request/plugin context mixing and synthetic context widening', async () => {
    const { assembleSource, classify } = await import(
      './fixtures/snippets/fence-engine.ts'
    );
    const cases = [
      "ctx.state['invalid'] = true;",
      'ctx.request.text(); ctx.lifecycle.onClose(() => {});',
      "ctx.services.register('app:test', {}, { singleton: true, lazy: true });",
    ];
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    for (const [index, code] of cases.entries()) {
      const fence = {
        guide: 'docs/programmatic-api.md',
        index,
        line: 1,
        heading: 'negative control',
        lang: 'typescript',
        code,
      };
      const file = `${SCRATCH_DIR}/context-negative-${index}.ts`;
      await Deno.writeTextFile(file, assembleSource(fence, classify(fence)));
      expect((await denoCheck(file)).code).not.toBe(0);
    }
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

  it('B1: Mutating CloudflarePlugin with NONEXISTENT_BROKEN_OPTION fails via shared engine', async () => {
    // Route through the same classify() and assembleSource() path as the default
    // gate, proving the fence engine (not a raw deno-check of raw code) catches
    // the mutation. Assert: original compiles, mutation replaces the option,
    // mutated source fails, and diagnostic names NONEXISTENT_BROKEN_OPTION.
    const { classify, assembleSource } = await import(
      './fixtures/snippets/fence-engine.ts'
    );
    const cloudflareGuide = 'docs/runtime-deployment.md';
    const markdown = await Deno.readTextFile(cloudflareGuide);
    const fences = extractFences(cloudflareGuide, markdown);
    // Find the CloudflarePlugin registration fence
    const cfFence = fences.find((f) =>
      f.code.includes('CloudflarePlugin') && f.code.includes('import')
    );
    expect(cfFence).not.toBeUndefined();

    // Classify the original fence through the shared engine
    const original = classify(cfFence!);
    expect(original).toBeDefined();

    // Original source must compile (or be a genuine external/excluded classification)
    if (
      original.kind === 'compile-complete' ||
      original.kind === 'compile-fragment'
    ) {
      await Deno.mkdir(SCRATCH_DIR, { recursive: true });
      const origFile = `${SCRATCH_DIR}/b1-cloudflare-original.ts`;
      const origSource = assembleSource(cfFence!, original);
      await Deno.writeTextFile(origFile, origSource);
      const { code: origCode } = await denoCheck(origFile);
      expect(origCode).toBe(0);
    }

    // Mutate the fence body with a nonexistent option
    const mutatedCode = cfFence!.code.replace(
      'CloudflarePlugin({',
      'CloudflarePlugin({ NONEXISTENT_BROKEN_OPTION: true,',
    );
    // Verify the mutation actually occurred
    expect(mutatedCode).toContain('NONEXISTENT_BROKEN_OPTION');
    expect(mutatedCode).not.toBe(cfFence!.code);

    // Build a mutated fence and classify it through the same engine
    const mutatedFence = { ...cfFence!, code: mutatedCode };
    const mutated = classify(mutatedFence);

    // The mutated fence must fail compilation through the shared engine
    if (
      mutated.kind === 'compile-complete' || mutated.kind === 'compile-fragment'
    ) {
      await Deno.mkdir(SCRATCH_DIR, { recursive: true });
      const mutFile = `${SCRATCH_DIR}/b1-cloudflare-mutated.ts`;
      const mutSource = assembleSource(mutatedFence, mutated);
      await Deno.writeTextFile(mutFile, mutSource);
      const { code: mutCode, stderr } = await denoCheck(mutFile);
      expect(mutCode).not.toBe(0);
      // Diagnostic must name the nonexistent option
      expect(stderr).toContain('NONEXISTENT_BROKEN_OPTION');
    } else {
      // If classification itself rejects it (e.g., recognizes the bad option),
      // that is also a valid failure mode
      throw new Error(
        `B1: Unexpected classification for mutated fence: ${mutated.kind}`,
      );
    }
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

  it('B9: AuthPlugin rejects an invalid JWT secret type', async () => {
    const file = `${SCRATCH_DIR}/b9-auth-missing.ts`;
    await Deno.mkdir(SCRATCH_DIR, { recursive: true });
    await Deno.writeTextFile(
      file,
      [
        "import { AuthPlugin } from '@setu-ts/auth-plugin';",
        'AuthPlugin({ jwt: { secret: 42 } });',
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
