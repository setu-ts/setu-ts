/**
 * The release bump's own controls.
 *
 * Each site `docs/releasing.md` learned about from a real release is a fixture
 * here, and each rule the module doc states is asserted in both directions: the
 * site moves, and the thing beside it that MUST NOT move (a bare range bound,
 * a history-marked reference, a test fixture, an `@since` tag) stays.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  type BumpOptions,
  isLater,
  isTestPath,
  main,
  type MainDeps,
  minorLine,
  planBump,
  readTrackedText,
  rewriteReferences,
  workingTreeIsClean,
} from '../../scripts/bump-version.ts';

const OPTIONS: BumpOptions = {
  from: '0.8.0',
  to: '0.9.0',
  date: '2026-10-05',
  members: ['./packages/common', './packages/sdk'],
};

/** A tree carrying one of every site the bump has to touch. */
function tree(overrides: Record<string, string | undefined> = {}): Map<string, string> {
  const files = new Map<string, string>([
    ['deno.json', '{"workspace": ["./packages/common", "./packages/sdk"]}'],
    ['packages/common/deno.json', '{\n  "name": "@setu-ts/common",\n  "version": "0.8.0"\n}\n'],
    [
      'packages/sdk/deno.json',
      '{\n  "version": "0.8.0",\n  "imports": {\n    "jsr:@setu-ts/common@^0.8.0": "jsr:@setu-ts/common@0.8.0"\n  }\n}\n',
    ],
    [
      'packages/sdk/src/http/observed-fetch.ts',
      "import type { X } from 'jsr:@setu-ts/common@^0.8.0';\n/** @since 0.8.0 */\nexport const SDK_VERSION = '0.8.0';\n",
    ],
    ['packages/cli/src/version.ts', "export const SCAFFOLD = { version: '0.1.0' };\n"],
    [
      'deno.lock',
      '{\n  "@setu-ts/common@0.8": "jsr:@setu-ts/common@0.8.0",\n  "jsr:@setu-ts/kernel@0.8": {}\n}\n',
    ],
    ['apps/minimal/deno.lock', '{ "links": { "@setu-ts/common@0.8.0": {} } }\n'],
    [
      'README.md',
      [
        'Install: `deno add jsr:@setu-ts/kernel@^0.8.0`.',
        '',
        'A caret range `^0.8.0` means `>=0.8.0 <0.9.0`.',
        '',
        '<!-- version:history -->',
        'The `0.8.0` release pinned `jsr:@setu-ts/common@^0.8.0` for the first time.',
        '',
      ].join('\n'),
    ],
    ['docker/Dockerfile', "# Could not find version of '@setu-ts/common' that matches '^0.8.0'\n"],
    ['k8s/chart/Chart.yaml', "version: 0.1.0\nappVersion: '0.8.0'\n"],
    ['k8s/manifests/deployment.yaml', 'labels:\n  app.kubernetes.io/version: "0.8.0"\n'],
    ['test/docs-gate.test.ts', "doc('README.md', 'deno add jsr:@setu-ts/kernel@^0.8.0')\n"],
    [
      'CHANGELOG.md',
      '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- A thing.\n\n## [0.8.0] — 2026-10-03\n\n- Older.\n',
    ],
    ['docs/upgrading.md', '# Upgrading\n\n## Unreleased\n\nDo the thing.\n\n## 0.8.0\n\nOld.\n'],
    [
      'scripts/check-docs.ts',
      "export const POST_ALPHA_MINOR_LINES: readonly string[] = [\n  '0.7',\n  '0.8',\n];\n",
    ],
  ]);
  for (const [path, content] of Object.entries(overrides)) {
    if (content === undefined) files.delete(path);
    else files.set(path, content);
  }
  return files;
}

const edited = (files: Map<string, string>, options = OPTIONS) => {
  const plan = planBump(files, options);
  expect(plan.refusals).toEqual([]);
  return {
    plan,
    content: (path: string) => plan.edits.find((edit) => edit.path === path)?.content,
  };
};

describe('minorLine / isLater', () => {
  it('reads the major.minor shorthand a lockfile writes', () => {
    expect(minorLine('0.8.0')).toBe('0.8');
    expect(minorLine('1.12.3-rc.1')).toBe('1.12');
    expect(() => minorLine('nope')).toThrow('not a version');
  });

  it('orders versions per SemVer, prereleases before their release', () => {
    expect(isLater('0.8.0', '0.9.0')).toBe(true);
    expect(isLater('0.9.0', '0.8.0')).toBe(false);
    expect(isLater('0.8.0', '0.8.0')).toBe(false);
    expect(isLater('0.8.0', '0.8.1-rc.1')).toBe(true);
    expect(isLater('0.8.1-rc.1', '0.8.1')).toBe(true);
    expect(isLater('0.8.1', '0.8.1-rc.1')).toBe(false);
    expect(isLater('0.8.1-rc.1', '0.8.1-rc.2')).toBe(true);
    expect(isLater('x', '0.9.0')).toBe(false);
  });
});

describe('isTestPath', () => {
  it('matches a test directory at the root or inside a package, and nothing else', () => {
    expect(isTestPath('test/docs-gate.test.ts')).toBe(true);
    expect(isTestPath('packages/cli/test/unit/a.test.ts')).toBe(true);
    expect(isTestPath('packages/cli/src/testing.ts')).toBe(false);
    expect(isTestPath('packages/testing/src/index.ts')).toBe(false);
  });
});

describe('rewriteReferences', () => {
  it('moves every package-named reference, caret or tilde or pinned, and nothing bare', () => {
    const { content, replacements } = rewriteReferences(
      'packages/x/deno.json',
      '"jsr:@setu-ts/common@^0.8.0": "jsr:@setu-ts/common@0.8.0", "~0.8.0", "@setu-ts/sdk@~0.8.0", version "0.8.0"',
      '0.8.0',
      '0.9.0',
    );
    expect(content).toBe(
      '"jsr:@setu-ts/common@^0.9.0": "jsr:@setu-ts/common@0.9.0", "~0.8.0", "@setu-ts/sdk@~0.9.0", version "0.8.0"',
    );
    expect(replacements).toBe(3);
  });

  it('does not move a reference whose version merely starts with the old one', () => {
    const { content, replacements } = rewriteReferences(
      'a.json',
      '"jsr:@setu-ts/common@^0.8.0-rc.1" "jsr:@setu-ts/common@0.8.01"',
      '0.8.0',
      '0.9.0',
    );
    expect(replacements).toBe(0);
    expect(content).toContain('0.8.0-rc.1');
  });

  it('moves the major.minor shorthand in a lockfile only, and only across a minor change', () => {
    const lock =
      '"@setu-ts/common@0.8": {}, "@setu-ts/common@0.8.0": {}, "@setu-ts/common@0.80": {}';
    expect(rewriteReferences('deno.lock', lock, '0.8.0', '0.9.0').content)
      .toBe('"@setu-ts/common@0.9": {}, "@setu-ts/common@0.9.0": {}, "@setu-ts/common@0.80": {}');
    // A patch bump leaves the shorthand alone — `0.8` still names 0.8.1.
    expect(rewriteReferences('deno.lock', lock, '0.8.0', '0.8.1').content)
      .toBe('"@setu-ts/common@0.8": {}, "@setu-ts/common@0.8.1": {}, "@setu-ts/common@0.80": {}');
    // Outside a lockfile the shorthand is not a reference.
    expect(rewriteReferences('x.md', '@setu-ts/common@0.8', '0.8.0', '0.9.0').replacements).toBe(0);
  });

  it('leaves a history-marked line and the line below it in source', () => {
    const src = [
      "import 'jsr:@setu-ts/a@^0.8.0';",
      '// version:history — the 0.8 line pinned this',
      "const historical = 'jsr:@setu-ts/b@^0.8.0';",
      "import 'jsr:@setu-ts/c@^0.8.0';",
    ].join('\n');
    const { content } = rewriteReferences('packages/x/src/a.ts', src, '0.8.0', '0.9.0');
    expect(content.split('\n')).toEqual([
      "import 'jsr:@setu-ts/a@^0.9.0';",
      '// version:history — the 0.8 line pinned this',
      "const historical = 'jsr:@setu-ts/b@^0.8.0';",
      "import 'jsr:@setu-ts/c@^0.9.0';",
    ]);
  });

  it('leaves a whole history-marked paragraph in Markdown, and moves the one after it', () => {
    const md = [
      'Live: `jsr:@setu-ts/a@^0.8.0`.',
      '',
      '> <!-- version:history -->',
      '> The alpha pinned `jsr:@setu-ts/b@^0.8.0`, and',
      '> this reflowed line kept `jsr:@setu-ts/c@^0.8.0`.',
      '>',
      'Back to live: `jsr:@setu-ts/d@^0.8.0`.',
    ].join('\n');
    const { content, replacements } = rewriteReferences('docs/x.md', md, '0.8.0', '0.9.0');
    expect(replacements).toBe(2);
    expect(content).toContain('`jsr:@setu-ts/a@^0.9.0`');
    expect(content).toContain('`jsr:@setu-ts/b@^0.8.0`');
    expect(content).toContain('`jsr:@setu-ts/c@^0.8.0`');
    expect(content).toContain('`jsr:@setu-ts/d@^0.9.0`');
  });
});

describe('planBump', () => {
  it('moves every site and leaves every trap', () => {
    const { plan, content } = edited(tree());
    const paths = plan.edits.map((edit) => edit.path).sort();
    expect(paths).toEqual([
      'CHANGELOG.md',
      'README.md',
      'apps/minimal/deno.lock',
      'deno.lock',
      'docker/Dockerfile',
      'docs/upgrading.md',
      'k8s/chart/Chart.yaml',
      'k8s/manifests/deployment.yaml',
      'packages/common/deno.json',
      'packages/sdk/deno.json',
      'packages/sdk/src/http/observed-fetch.ts',
      'scripts/check-docs.ts',
    ]);

    // Manifests: the member version AND both sides of the SDK's pinned mapping.
    expect(content('packages/common/deno.json')).toContain('"version": "0.9.0"');
    expect(content('packages/sdk/deno.json')).toBe(
      '{\n  "version": "0.9.0",\n  "imports": {\n    "jsr:@setu-ts/common@^0.9.0": "jsr:@setu-ts/common@0.9.0"\n  }\n}\n',
    );
    // The SDK source: the inline specifier and SDK_VERSION move; `@since` does not.
    expect(content('packages/sdk/src/http/observed-fetch.ts')).toBe(
      "import type { X } from 'jsr:@setu-ts/common@^0.9.0';\n/** @since 0.8.0 */\nexport const SDK_VERSION = '0.9.0';\n",
    );
    // A bare `version: '0.1.0'` the CLI stamps into scaffolds is not this project's version.
    expect(content('packages/cli/src/version.ts')).toBeUndefined();
    // Lockfiles: shorthand and full form, root and app.
    expect(content('deno.lock')).toBe(
      '{\n  "@setu-ts/common@0.9": "jsr:@setu-ts/common@0.9.0",\n  "jsr:@setu-ts/kernel@0.9": {}\n}\n',
    );
    expect(content('apps/minimal/deno.lock')).toContain('@setu-ts/common@0.9.0');
    // README: the install line moves; the worked range's bounds are bare numbers
    // and stay; the history paragraph stays whole.
    expect(content('README.md')).toContain('`deno add jsr:@setu-ts/kernel@^0.9.0`');
    expect(content('README.md')).toContain('`>=0.8.0 <0.9.0`');
    expect(content('README.md')).toContain(
      'pinned `jsr:@setu-ts/common@^0.8.0` for the first time',
    );
    // The Dockerfile's quoted error names a specifier and moves.
    expect(content('docker/Dockerfile')).toContain("'^0.9.0'");
    // Chart and rendered manifest label.
    expect(content('k8s/chart/Chart.yaml')).toBe("version: 0.1.0\nappVersion: '0.9.0'\n");
    expect(content('k8s/manifests/deployment.yaml')).toContain(
      'app.kubernetes.io/version: "0.9.0"',
    );
    // Headings: a fresh Unreleased above the renamed section; the guide renamed.
    expect(content('CHANGELOG.md')).toContain(
      '## [Unreleased]\n\n## [0.9.0] — 2026-10-05\n\n### Added',
    );
    expect(content('docs/upgrading.md')).toContain('## 0.9.0\n\nDo the thing.');
    // The new minor line is named in check-docs, and the residual step says what to assert.
    expect(content('scripts/check-docs.ts')).toContain("  '0.8',\n  '0.9',\n];");
    expect(plan.residual.some((step) => step.includes('stale-WITHIN-0.9'))).toBe(true);
    // Test fixtures are never swept.
    expect(content('test/docs-gate.test.ts')).toBeUndefined();
  });

  it('does not widen check-docs for a patch release or a prerelease, and does not report it', () => {
    const patch = edited(tree(), { ...OPTIONS, to: '0.8.1' });
    expect(patch.content('scripts/check-docs.ts')).toBeUndefined();
    expect(patch.plan.residual.some((step) => step.includes('POST_ALPHA_MINOR_LINES'))).toBe(false);
    const pre = edited(tree(), { ...OPTIONS, to: '0.9.0-rc.1' });
    expect(pre.content('scripts/check-docs.ts')).toBeUndefined();
  });

  it('leaves an already-named minor line alone', () => {
    const files = tree({
      'scripts/check-docs.ts':
        "export const POST_ALPHA_MINOR_LINES: readonly string[] = [\n  '0.8',\n  '0.9',\n];\n",
    });
    expect(edited(files).content('scripts/check-docs.ts')).toBeUndefined();
  });

  it('refuses a version that is not later, not SemVer, or a malformed date — before any edit', () => {
    expect(planBump(tree(), { ...OPTIONS, to: '0.8.0' }).refusals[0]).toBe(
      "'0.8.0' is not later than the tree's version '0.8.0'.",
    );
    expect(planBump(tree(), { ...OPTIONS, to: 'v0.9.0' }).refusals[0]).toContain('not a SemVer');
    expect(planBump(tree(), { ...OPTIONS, to: 'v0.9.0' }).edits).toEqual([]);
    expect(planBump(tree(), { ...OPTIONS, from: 'latest' }).refusals[0]).toContain(
      "tree's version",
    );
    expect(planBump(tree(), { ...OPTIONS, date: '5 Oct' }).refusals).toEqual([
      "'5 Oct' is not a YYYY-MM-DD date.",
    ]);
  });

  it('refuses a tree whose members are not all on the old version, naming each', () => {
    const files = tree({
      'packages/sdk/deno.json': '{ "version": "0.7.0" }',
      'packages/common/deno.json': undefined,
    });
    const { refusals } = planBump(files, OPTIONS);
    expect(refusals).toEqual([
      'workspace member packages/common/deno.json is not a tracked file.',
      'packages/sdk/deno.json does not carry "version": "0.8.0" — the tree is not all on 0.8.0.',
    ]);
  });

  it('refuses when a named site is absent or does not carry the old version', () => {
    expect(planBump(tree({ 'k8s/chart/Chart.yaml': "appVersion: '0.7.0'\n" }), OPTIONS).refusals)
      .toEqual(["k8s/chart/Chart.yaml does not carry appVersion: '0.8.0'."]);
    expect(
      planBump(tree({ 'packages/sdk/src/http/observed-fetch.ts': undefined }), OPTIONS).refusals[0],
    )
      .toContain('packages/sdk/src/http/observed-fetch.ts is not a tracked file');
  });

  it('refuses a changelog with no Unreleased heading, an empty one, or the version already cut', () => {
    expect(planBump(tree({ 'CHANGELOG.md': '# Changelog\n\n## [0.8.0]\n- x\n' }), OPTIONS).refusals)
      .toEqual(["CHANGELOG.md has no '## [Unreleased]' heading to rename."]);
    expect(
      planBump(tree({ 'CHANGELOG.md': '## [Unreleased]\n\n## [0.8.0]\n- x\n' }), OPTIONS)
        .refusals[0],
    )
      .toContain("'## [Unreleased]' section is empty");
    expect(
      planBump(tree({ 'CHANGELOG.md': '## [Unreleased]\n- y\n\n## [0.9.0]\n- x\n' }), OPTIONS)
        .refusals,
    )
      .toEqual(["CHANGELOG.md already carries a '## [0.9.0]' section."]);
    expect(planBump(tree({ 'CHANGELOG.md': undefined }), OPTIONS).refusals)
      .toEqual(['CHANGELOG.md is not a tracked file.']);
  });

  it('leaves an empty upgrading Unreleased heading and says what would belong under it', () => {
    const files = tree({
      'docs/upgrading.md': '# Upgrading\n\n## Unreleased\n\n## 0.8.0\n\nOld.\n',
    });
    const { plan, content } = edited(files);
    expect(content('docs/upgrading.md')).toBeUndefined();
    expect(plan.residual[0]).toContain("'## Unreleased' section is empty");
    // And a tree without the guide at all is simply not asked about.
    expect(
      edited(tree({ 'docs/upgrading.md': undefined })).plan.residual.some((step) =>
        step.includes('upgrading')
      ),
    ).toBe(false);
  });

  it('refuses when check-docs no longer has the array in the shape it rewrites', () => {
    const files = tree({ 'scripts/check-docs.ts': 'const SOMETHING_ELSE = [];\n' });
    expect(planBump(files, OPTIONS).refusals).toEqual([
      'scripts/check-docs.ts: POST_ALPHA_MINOR_LINES was not found in its expected shape.',
    ]);
  });

  it('always lists the operator steps it cannot take', () => {
    const { plan } = edited(tree());
    const steps = plan.residual.join('\n');
    for (
      const needle of ['check:docs', 'deploy:render', 'deno.lock', 'check 9', '>=0.9.0 <0.9.0']
    ) {
      expect(steps).toContain(needle);
    }
  });
});

describe('main (the command path, over injected I/O)', () => {
  /** Fakes around a given tree, recording writes and output. */
  function harness(files: Map<string, string>, clean = true) {
    const writes = new Map<string, string>();
    const out: string[] = [];
    const err: string[] = [];
    const deps: MainDeps = {
      readTracked: () => Promise.resolve(new Map(files)),
      isClean: () => Promise.resolve(clean),
      write: (path, content) => {
        writes.set(path, content);
        return Promise.resolve();
      },
      today: () => '2026-10-05',
      log: (line) => out.push(line),
      error: (line) => err.push(line),
    };
    return { deps, writes, out, err };
  }

  /** The real tree's shape: a kernel manifest the version is read from. */
  function realShape(): Map<string, string> {
    const files = tree();
    files.set(
      'deno.json',
      '{"workspace": ["./packages/common", "./packages/sdk", "./packages/kernel"]}',
    );
    files.set('packages/kernel/deno.json', '{\n  "version": "0.8.0"\n}\n');
    return files;
  }

  it('prints usage and fails without a version', async () => {
    const h = harness(realShape());
    expect(await main([], h.deps)).toBe(false);
    expect(h.err[0]).toContain('usage: release:bump');
  });

  it('refuses a dirty tree unless told not to, and never on a dry run', async () => {
    const dirty = harness(realShape(), false);
    expect(await main(['0.9.0'], dirty.deps)).toBe(false);
    expect(dirty.err[0]).toContain('working tree is dirty');
    expect(dirty.writes.size).toBe(0);
    const dry = harness(realShape(), false);
    expect(await main(['0.9.0', '--dry-run'], dry.deps)).toBe(true);
    const allowed = harness(realShape(), false);
    expect(await main(['0.9.0', '--allow-dirty'], allowed.deps)).toBe(true);
    expect(allowed.writes.size).toBeGreaterThan(0);
  });

  it('reports every refusal and writes nothing', async () => {
    const h = harness(realShape());
    expect(await main(['0.8.0'], h.deps)).toBe(false);
    expect(h.err[0]).toContain('release:bump refused 0.8.0 → 0.8.0');
    expect(h.err.some((line) => line.includes('is not later'))).toBe(true);
    expect(h.writes.size).toBe(0);
  });

  it('dry-run prints the plan and writes nothing; a real run writes every edit', async () => {
    const dry = harness(realShape());
    expect(await main(['0.9.0', '--dry-run', '--date', '2026-10-05'], dry.deps)).toBe(true);
    expect(dry.writes.size).toBe(0);
    expect(dry.out.some((line) => line.startsWith('would rewrite packages/common/deno.json'))).toBe(
      true,
    );
    expect(dry.out.some((line) => line.includes('0.8.0 → 0.9.0'))).toBe(true);
    expect(dry.out.some((line) => line.includes('Residual steps'))).toBe(true);

    const real = harness(realShape());
    expect(await main(['0.9.0'], real.deps)).toBe(true);
    expect(real.writes.get('packages/kernel/deno.json')).toContain('"version": "0.9.0"');
    expect(real.writes.get('CHANGELOG.md')).toContain('## [0.9.0] — 2026-10-05');
    expect(real.out.some((line) => line.startsWith('rewrote packages/sdk/deno.json'))).toBe(true);
  });

  it('fails on a residual reference the rewrite could not reach, naming it', async () => {
    // A history-marked specifier in a swept path is exempt from the rewrite but
    // is still a reference to the old version, which the re-sweep reports —
    // unless the marker is on the same line, which the sweep honours too. So
    // the residual must come from a form the rewriter does not understand:
    // a pinned specifier whose version the rewrite's lookahead refuses.
    const files = realShape();
    files.set(
      'packages/sdk/src/x.ts',
      "// version:history\nimport 'jsr:@setu-ts/common@0.8.0';\nimport 'jsr:@setu-ts/common@0.7.0';\n",
    );
    const h = harness(files);
    expect(await main(['0.9.0', '--dry-run'], h.deps)).toBe(false);
    expect(
      h.err.some((line) => line.includes('residual packages/sdk/src/x.ts:3 @setu-ts/common@0.7.0')),
    )
      .toBe(true);
    expect(h.err.some((line) => line.includes('residual reference(s)'))).toBe(true);
  });

  it('fails when the re-sweep sees no references at all, so a broken reader cannot pass', async () => {
    const files = realShape();
    for (const path of [...files.keys()]) {
      if (path.endsWith('deno.lock') || path.includes('/src/')) files.delete(path);
    }
    files.set('packages/sdk/src/http/observed-fetch.ts', "export const SDK_VERSION = '0.8.0';\n");
    const h = harness(files);
    expect(await main(['0.9.0', '--dry-run'], h.deps)).toBe(false);
    expect(h.err.at(-1)).toContain('saw no @setu-ts references at all');
  });
});

describe('the real seams', () => {
  it('reads tracked text files and skips binaries', async () => {
    const files = await readTrackedText();
    expect(files.has('deno.json')).toBe(true);
    expect(files.has('scripts/verify-release.ts')).toBe(true);
    for (const path of files.keys()) expect(path.endsWith('.png')).toBe(false);
  });

  it('reports the working tree state as a boolean', async () => {
    expect(typeof await workingTreeIsClean()).toBe('boolean');
  });
});
