/**
 * Mechanical validation of documentation snippet fixtures.
 *
 * The previous version of this test read files from a git-ignored `.tmp/`
 * directory and asserted only that their text was non-empty — a no-op gate
 * that passed from a clean checkout (where `.tmp/` is absent) and proved
 * nothing about whether the snippets compile.
 *
 * This version depends ONLY on committed repository files:
 *   - Each fixture lives under `test/fixtures/snippets/` (git-tracked).
 *   - Each fixture is mechanically type-checked by invoking `deno check` via
 *     `Deno.Command` against the workspace import map, so API drift (wrong
 *     method names, wrong context shape, missing await) is caught rather than
 *     silently shipping incorrect documentation.
 *   - A clean-checkout regression asserts every fixture is git-tracked, so a
 *     fixture moved back to `.tmp/` fails the gate.
 *   - A negative control asserts the mechanical compiler REJECTS a fixture
 *     using the banned `app.get()` family, proving the gate discriminates.
 *   - A manifest maps each fixture to the guide(s) it represents, so a guide
 *     whose fixture is deleted fails the gate.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/** Each fixture mapped to the guide(s) whose examples it mechanically verifies. */
const SNIPPET_FIXTURES: ReadonlyArray<{ fixture: string; guides: readonly string[] }> = [
  { fixture: 'minimal-app.ts', guides: ['docs/getting-started.md'] },
  { fixture: 'plugin-registration.ts', guides: ['docs/custom-plugins.md'] },
  {
    fixture: 'testing-injection.ts',
    guides: ['docs/getting-started.md', 'docs/programmatic-api.md'],
  },
  { fixture: 'decorator-flow.ts', guides: ['docs/decorators.md'] },
  { fixture: 'runtime-workers.ts', guides: ['docs/runtime-deployment.md'] },
  { fixture: 'migration-nestjs.ts', guides: ['docs/migration-nestjs.md'] },
  { fixture: 'migration-fastify.ts', guides: ['docs/migration-fastify.md'] },
  { fixture: 'middleware.ts', guides: ['docs/plugin-architecture.md'] },
  { fixture: 'lifecycle-hooks.ts', guides: ['docs/plugin-architecture.md'] },
  { fixture: 'examples-guide.ts', guides: ['docs/examples.md'] },
  { fixture: 'architecture-registry.ts', guides: ['ARCHITECTURE.md'] },
];

const FIXTURE_DIR = 'test/fixtures/snippets';

/**
 * Invokes `deno check` on a fixture and returns the exit code + stderr.
 *
 * The decorator fixture requires `experimentalDecorators`, which lives in the
 * fixture directory's `deno.json`. A nested config that is not a workspace
 * member is ignored when `deno check` resolves config by file proximity from
 * the workspace root, so the decorator fixture is checked with an explicit
 * `--config` pointing at `test/fixtures/snippets/deno.json`. That config also
 * carries the import map, so resolution is identical to the other fixtures.
 */
async function denoCheck(
  fixturePath: string,
  options?: { config?: string },
): Promise<{ code: number; stderr: string }> {
  const args = ['check'];
  if (options?.config !== undefined) {
    args.push('--config', options.config);
  }
  args.push(fixturePath);
  const cmd = new Deno.Command('deno', {
    args,
    stdout: 'null',
    stderr: 'piped',
  });
  const output = await cmd.output();
  return {
    code: output.code,
    stderr: new TextDecoder().decode(output.stderr),
  };
}

describe('Documentation snippet validation — mechanical type-check', () => {
  for (const { fixture, guides } of SNIPPET_FIXTURES) {
    it(`compiles ${fixture} (represents ${guides.join(', ')})`, async () => {
      const path = `${FIXTURE_DIR}/${fixture}`;
      // The fixture must exist as a committed file (clean-checkout safety).
      await Deno.stat(path);
      // The decorator fixture uses legacy decorators, which require the
      // `experimentalDecorators` compiler option. That option lives in the
      // fixture directory's deno.json, which a nested non-workspace-member
      // config does not apply by file proximity from the workspace root, so
      // pass it explicitly. The config also carries the import map, so module
      // resolution is identical to the other fixtures.
      const config = fixture === 'decorator-flow.ts' ? `${FIXTURE_DIR}/deno.json` : undefined;
      const { code, stderr } = await denoCheck(
        path,
        config !== undefined ? { config } : undefined,
      );
      if (code !== 0) {
        throw new Error(
          `deno check ${path} failed (exit ${code}). The guide snippet it represents (${
            guides.join(', ')
          }) is invalid.\n--- stderr ---\n${stderr}`,
        );
      }
      expect(code).toBe(0);
    });
  }

  it('rejects the negative control using the banned app.get() family (gate discriminates)', async () => {
    const path = `${FIXTURE_DIR}/_negative-app-get.ts`;
    await Deno.stat(path);
    const { code } = await denoCheck(path);
    // The negative control MUST fail to compile — if it passes, the gate
    // does not actually invoke the compiler and is a no-op.
    expect(code).not.toBe(0);
  });

  it('decorator-flow.ts exercises the real decorator surface (no empty-array regression)', async () => {
    // A prior regression made decorator-flow.ts compile with
    // `controllers: []` / `services: []`, which proves the plugin wiring
    // compiles but nothing about whether the guide's real decorator examples
    // compile. This invariant asserts the fixture uses a real @Injectable
    // service, a real @Controller with @Get and parameter-level @Inject, and
    // wires them through DecoratorPlugin with non-empty controllers/services
    // arrays — so it cannot silently regress to empty arrays again.
    const source = await Deno.readTextFile(`${FIXTURE_DIR}/decorator-flow.ts`);
    const requiredSymbols = [
      'Controller(',
      'Get(',
      'Injectable(',
      'Inject(',
      'Param(',
      'DecoratorPlugin(',
    ];
    for (const symbol of requiredSymbols) {
      expect(source).toContain(symbol);
    }
    // The fixture must wire real classes, not empty arrays.
    expect(source).toContain('controllers: [UserController]');
    expect(source).toContain('services: [UserService]');
    // The empty-array regression must be absent.
    expect(source).not.toContain('controllers: []');
    expect(source).not.toContain('services: []');
    // The runtime invariant in the fixture itself must also be present, so a
    // future edit that drops the symbols fails at runtime too.
    expect(source).toContain('REQUIRED_SYMBOLS');
  });

  it('every fixture is git-tracked (clean-checkout regression)', async () => {
    // A fixture living only in .tmp/ would pass a non-empty-text check from a
    // warm tree and fail from a clean checkout. Asserting git tracking makes
    // the gate depend only on committed files.
    const fixtures = [...SNIPPET_FIXTURES.map((f) => f.fixture), '_negative-app-get.ts'];
    const cmd = new Deno.Command('git', {
      args: ['ls-files', '--', FIXTURE_DIR],
      stdout: 'piped',
      stderr: 'null',
    });
    const output = await cmd.output();
    const tracked = new TextDecoder().decode(output.stdout).split('\n').filter(Boolean);
    const trackedSet = new Set(tracked);
    for (const fixture of fixtures) {
      const trackedPath = `${FIXTURE_DIR}/${fixture}`;
      expect(trackedSet.has(trackedPath)).toBe(true);
    }
    // The import map must also be tracked, or the fixtures cannot resolve.
    expect(trackedSet.has(`${FIXTURE_DIR}/deno.json`)).toBe(true);
  });

  it('every represented guide exists on disk', async () => {
    for (const { guides } of SNIPPET_FIXTURES) {
      for (const guide of guides) {
        await Deno.stat(guide);
      }
    }
  });
});

describe('Documentation snippet validation — guide content invariants', () => {
  const ROUTE_GUIDES = [
    'docs/getting-started.md',
    'docs/programmatic-api.md',
    'docs/custom-plugins.md',
    'docs/plugin-architecture.md',
    'docs/examples.md',
    'docs/decorators.md',
    'docs/runtime-deployment.md',
  ];

  it('verifies no app.get() calls in Setu-TS guides (must use app.router.get)', async () => {
    for (const guide of ROUTE_GUIDES) {
      const content = await Deno.readTextFile(guide);
      // Match app.get/post/put/patch/delete but NOT app.router.get etc.
      const badMatches = [...content.matchAll(/app\.(get|post|put|patch|delete|head|options)\(/g)]
        .filter((m) => !m[0].startsWith('app.router.'));
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies no ctx.json() calls in Setu-TS guides (must use ctx.response.json)', async () => {
    for (const guide of ROUTE_GUIDES) {
      const content = await Deno.readTextFile(guide);
      const badMatches = [...content.matchAll(/ctx\.json\(/g)]
        .filter((m) => !m[0].startsWith('ctx.response.json'));
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies response uses statusCode not status', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/examples.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      // `response.status(code)` is the real IResponse chaining API (returns
      // IResponse for `.json()` chaining), and `response.statusCode` is a
      // valid property access in test assertions. Reject only a bare
      // `response.status` NOT followed by a letter or `(` — that catches the
      // nonexistent `response.status =` / `response.status,` patterns the gate
      // was originally written to catch.
      const badMatches = [...content.matchAll(/response\.status(?![a-zA-Z(])/g)];
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies createTestApp is awaited in code blocks', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/programmatic-api.md',
      'docs/custom-plugins.md',
      'docs/examples.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      const lines = content.split('\n');
      let inCodeBlock = false;
      for (const line of lines) {
        if (line.trim().startsWith('```')) {
          inCodeBlock = !inCodeBlock;
          continue;
        }
        if (!inCodeBlock) continue;
        if (line.trim().startsWith('import ')) continue;
        const matches = [...line.matchAll(/createTestApp\(/g)];
        for (const match of matches) {
          const idx = match.index!;
          const preceding = line.slice(0, idx);
          expect(preceding.includes('await')).toBe(true);
        }
      }
    }
  });

  it('verifies plugin factories are invoked', async () => {
    const guides = [
      'docs/getting-started.md',
      'docs/custom-plugins.md',
      'docs/plugin-architecture.md',
      'docs/examples.md',
      'docs/runtime-deployment.md',
    ];
    for (const guide of guides) {
      const content = await Deno.readTextFile(guide);
      const badMatches = [...content.matchAll(/app\.register\((?!.*\(\))\w+Plugin\)/g)];
      expect(badMatches.length).toBe(0);
    }
  });

  it('verifies architecture testing claim matches real CI (Deno full, Node/Bun compat)', async () => {
    const content = await Deno.readTextFile('ARCHITECTURE.md');
    const start = content.indexOf('### Runtime Compatibility Tests');
    const end = content.indexOf('### Contract Tests');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = content.slice(start, end);
    // The stale claim that the full suite runs on all three runtimes must be gone.
    expect(section).not.toMatch(/full test suite on all three runtimes/);
    expect(section).not.toMatch(/All tests must pass on Node\.js, Deno, and Bun/);
    // The corrected claim: Deno runs the full suite; Node/Bun run compat.
    expect(section).toMatch(/Deno runs the full workspace test suite/);
    expect(section).toMatch(/Node and Bun run the published-artifact compatibility suite/);
  });

  it('verifies architecture registry examples use CAPABILITIES constants, not raw standard tokens', async () => {
    const content = await Deno.readTextFile('ARCHITECTURE.md');
    // The §6 Service Registry section is between "## 6. Service Registry" and "## 7. Runtime Layer".
    const start = content.indexOf('## 6. Service Registry');
    const end = content.indexOf('## 7. Runtime Layer');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = content.slice(start, end);
    // Standard tokens registered/looked up must use CAPABILITIES.* — a raw
    // quoted standard token in a register/get/has/getAll call is a defect.
    const standardTokens = [
      'database',
      'cache',
      'logger',
      'config',
      'notifier',
      'notification',
      'messaging',
    ];
    for (const token of standardTokens) {
      const bad = section.match(
        new RegExp(`ctx\\.services\\.(register|get|has|getAll|registerFactory)\\('${token}'`, 'g'),
      );
      expect(bad).toBeNull();
    }
    // The nonexistent `lazy` option must not appear in RegisterOptions examples.
    expect(section).not.toMatch(/lazy:\s*(true|false)/);
  });

  it('RuntimePlatform in docs/programmatic-api.md matches the exact exported source union (no unknown)', async () => {
    // The source union is `'node' | 'deno' | 'bun' | 'cloudflare-workers'` —
    // there is NO `'unknown'` arm. A doc that lists `'unknown'` is a defect
    // that drifted from source; this assertion pins the exact union so it
    // cannot drift again.
    const sourceTypes = await Deno.readTextFile('packages/common/src/types.ts');
    const sourceMatch = sourceTypes.match(
      /export type RuntimePlatform = ([^;]+);/,
    );
    expect(sourceMatch).not.toBeNull();
    const sourceUnion = sourceMatch![1].trim();
    // Source must NOT contain 'unknown'.
    expect(sourceUnion).not.toContain("'unknown'");
    // The exact four arms, in source order.
    expect(sourceUnion).toBe("'node' | 'deno' | 'bun' | 'cloudflare-workers'");

    const doc = await Deno.readTextFile('docs/programmatic-api.md');
    // The doc's RuntimePlatform block must match the source union exactly.
    const docMatch = doc.match(/type RuntimePlatform = ([^\n;]+)/);
    expect(docMatch).not.toBeNull();
    const docUnion = docMatch![1].trim();
    expect(docUnion).toBe("'deno' | 'node' | 'bun' | 'cloudflare-workers'");
    // The doc must NOT list 'unknown'.
    expect(docUnion).not.toContain("'unknown'");
  });

  it('PLUGIN_PRIORITY.NORMAL is 500 and plugin-architecture.md default priority matches', async () => {
    // The source constant is PLUGIN_PRIORITY.NORMAL = 500. A doc that claims
    // the default is 50 is a defect; this assertion pins the source value and
    // the doc's claim so they cannot drift apart.
    const sourceTypes = await Deno.readTextFile('packages/common/src/types.ts');
    const normalMatch = sourceTypes.match(/NORMAL:\s*(\d+)/);
    expect(normalMatch).not.toBeNull();
    expect(normalMatch![1]).toBe('500');

    const doc = await Deno.readTextFile('docs/plugin-architecture.md');
    // The default-priority claim must be 500, not 50.
    const defaultMatch = doc.match(/\*\*Default priority:\*\*\s*`(\d+)`/);
    expect(defaultMatch).not.toBeNull();
    expect(defaultMatch![1]).toBe('500');
    // The stale claim of 50 must be gone.
    expect(doc).not.toMatch(/\*\*Default priority:\*\*\s*`50`/);
  });
});
