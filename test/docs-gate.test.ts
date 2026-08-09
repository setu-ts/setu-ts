/**
 * Pins the documentation gate: that its checks actually discriminate, and that
 * CI runs it.
 *
 * The defect that motivated the gate — a runaway code fence in `PUBLIC_API.md`
 * that rendered two-thirds of the file as source — passed `deno fmt`, `lint`,
 * `check`, `test`, and both publish gates. A checker nothing runs would be the
 * same failure one level up, so the wiring is asserted here rather than
 * assumed (the `apps-gate.test.ts` precedent, where three deepened Redis tests
 * guarded on an environment variable no workflow set).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  anchorFor,
  buildGeneratedApiPages,
  checkAppsReadmeCoverage,
  checkDocument,
  checkExamplesCoverage,
  checkLocalLinks,
  checkPackageCatalog,
  checkRequiredGuides,
  findSwallowedHeadings,
  scanFences,
} from '../scripts/check-docs.ts';
import { collectApiEntrypoints } from '../scripts/generate-api-docs.ts';
import { PUBLISHED_PACKAGES } from '../scripts/release-packages.ts';
import { PACKAGE_METADATA } from '../scripts/jsr-metadata.ts';

describe('documentation gate — fence scanning', () => {
  it('does not treat a longer fence as closed by a shorter one', () => {
    // The exact shape of the real defect: ```` opened, ``` cannot close it.
    const lines = ['````typescript', 'code', '```', '', '## Swallowed', 'text'];
    const { unclosedAt, fenced } = scanFences(lines);

    expect(unclosedAt).toBe(1);
    // The heading is inside the runaway block, so it is not a heading.
    expect(fenced[4]).toBe(true);
  });

  it('closes a fence with an equal or longer delimiter of the same character', () => {
    expect(scanFences(['```ts', 'code', '```']).unclosedAt).toBeNull();
    expect(scanFences(['```ts', 'code', '````']).unclosedAt).toBeNull();
    // A tilde fence is not closed by backticks.
    expect(scanFences(['~~~ts', 'code', '```']).unclosedAt).toBe(1);
  });

  it('ignores a delimiter that carries an info string when closing', () => {
    // Line 3 opens a nested-looking fence rather than closing; the block runs on.
    expect(scanFences(['```ts', 'code', '```ts', 'more']).unclosedAt).toBe(1);
  });
});

describe('documentation gate — swallowed headings', () => {
  it('flags a code block whose language cannot have # comments', () => {
    const lines = ['```typescript', 'const a = 1;', '## One', '## Two', '```'];
    const { blocks } = scanFences(lines);
    const suspects = findSwallowedHeadings(lines, blocks);

    expect(suspects.length).toBe(1);
    expect(suspects[0]?.headings).toEqual(['One', 'Two']);
  });

  it('does not flag languages where # is an ordinary comment', () => {
    for (const lang of ['bash', 'sh', 'yaml', 'toml', 'python', 'markdown']) {
      const lines = [`\`\`\`${lang}`, '## One', '## Two', '```'];
      const { blocks } = scanFences(lines);
      expect(findSwallowedHeadings(lines, blocks).length).toBe(0);
    }
  });

  it('tolerates a single stray heading-like line', () => {
    const lines = ['```json', '{ "a": 1 }', '## Only one', '```'];
    const { blocks } = scanFences(lines);
    expect(findSwallowedHeadings(lines, blocks).length).toBe(0);
  });
});

describe('documentation gate — anchors', () => {
  it('derives a renderer anchor from heading text', () => {
    expect(anchorFor('API Reference: @setu-ts/common')).toBe(
      'api-reference-setu-tscommon',
    );
    expect(anchorFor('createApplication()')).toBe('createapplication');
    expect(anchorFor('Feature Flags')).toBe('feature-flags');
  });

  it('reports a link that matches no heading', () => {
    const findings = checkDocument('t.md', '# T\n\n## A\n\nSee [B](#nope).\n');
    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('matches no heading');
  });

  it('accepts a link to a heading that exists', () => {
    expect(checkDocument('t.md', '# T\n\n## A\n\nSee [A](#a).\n').length).toBe(0);
  });

  it('ignores headings and links inside code fences', () => {
    const source = '# T\n\n```typescript\n// [X](#nowhere)\n```\n';
    expect(checkDocument('t.md', source).length).toBe(0);
  });

  it('disambiguates repeated headings the way a renderer does', () => {
    const source = '# T\n\n## Dup\n\n## Dup\n\n[first](#dup) [second](#dup-1)\n';
    expect(checkDocument('t.md', source).length).toBe(0);
  });
});

describe('documentation gate — table of contents', () => {
  it('reports a section with no contents entry', () => {
    const source = '# T\n\n## Table of Contents\n\n1. [A](#a)\n\n## A\n\n## B\n';
    const findings = checkDocument('t.md', source);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('"B" has no Table of Contents entry');
  });

  it('does not require a contents entry in a file with no contents section', () => {
    expect(checkDocument('t.md', '# T\n\n## A\n\n## B\n').length).toBe(0);
  });
});

describe('documentation gate — CI wiring', () => {
  it('is registered as a task', async () => {
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };
    expect(manifest.tasks['check:docs']).toContain('scripts/check-docs.ts');
  });

  it('runs on every pull request', async () => {
    // Without this the gate is a script nobody executes, and the class of
    // defect it exists for reaches main exactly as it did before.
    const workflow = await Deno.readTextFile('.github/workflows/ci.yml');
    expect(workflow).toContain('deno task check:docs');
  });

  it('check:docs runs the aggregate gate (docs + api lint)', async () => {
    const manifest = JSON.parse(await Deno.readTextFile('deno.json')) as {
      tasks: Record<string, string>;
    };
    // check:docs should include both check-docs.ts and generate-api-docs.ts
    const checkDocs = manifest.tasks['check:docs'];
    expect(checkDocs).toContain('check-docs.ts');
    expect(checkDocs).toContain('generate-api-docs.ts');
  });
});

describe('documentation gate — required guides', () => {
  it('reports a missing required guide', () => {
    const files = [
      'README.md',
      'docs/getting-started.md',
      'docs/plugin-architecture.md',
      // Missing: docs/plugins.md, docs/programmatic-api.md, etc.
    ];

    const findings = checkRequiredGuides(files);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.message.includes('missing'))).toBe(true);
  });

  it('passes when all required guides exist', () => {
    const files = [
      'README.md',
      'docs/getting-started.md',
      'docs/plugin-architecture.md',
      'docs/plugins.md',
      'docs/programmatic-api.md',
      'docs/decorators.md',
      'docs/custom-plugins.md',
      'docs/migration-nestjs.md',
      'docs/migration-fastify.md',
      'docs/examples.md',
      'docs/runtime-deployment.md',
    ];

    const findings = checkRequiredGuides(files);

    expect(findings.length).toBe(0);
  });
});

describe('documentation gate — examples coverage', () => {
  it('reports an app not documented in examples.md', () => {
    const examplesGuide = '# Examples\n\n## REST Example\n\nSee apps/rest for more.';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkExamplesCoverage(examplesGuide, appDirs);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.message.includes('minimal'))).toBe(true);
    expect(findings.some((f) => f.message.includes('new-app'))).toBe(true);
  });

  it('passes when all apps are documented', () => {
    const examplesGuide =
      '# Examples\n\n## Minimal\n\nSee apps/minimal.\n\n## REST\n\nSee apps/rest.\n\n## New App\n\nSee apps/new-app.';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkExamplesCoverage(examplesGuide, appDirs);

    expect(findings.length).toBe(0);
  });
});

describe('documentation gate — apps README coverage', () => {
  it('reports an app not listed in apps/README.md', () => {
    const appsReadme =
      '# Apps\n\n| Name | Description |\n|------|-------------|\n| minimal | Minimal example |';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkAppsReadmeCoverage(appsReadme, appDirs);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.message.includes('rest'))).toBe(true);
    expect(findings.some((f) => f.message.includes('new-app'))).toBe(true);
  });

  it('passes when all apps are listed', () => {
    const appsReadme =
      '# Apps\n\n| Name | Description |\n|------|-------------|\n| minimal | Minimal example |\n| rest | REST example |\n| new-app | New app example |';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkAppsReadmeCoverage(appsReadme, appDirs);

    expect(findings.length).toBe(0);
  });
});

describe('documentation gate — package catalog', () => {
  it('reports a package missing from the catalog', () => {
    // Create a minimal plugins.md that omits one package
    const pluginsMd = '# Plugins\n\n## @setu-ts/common\n\nSome content.\n';
    const runtimeMd =
      '# Runtime\n\n| Deno | Node | Bun | Workers |\n|------|------|-----|---------|\n| ✅ | ✅ | ✅ | ✅ |\n';

    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      PUBLISHED_PACKAGES,
      PACKAGE_METADATA,
    );

    // Should find missing packages
    expect(findings.length).toBeGreaterThan(0);
  });

  it('rejects the exact review synthetic substring-only catalog', () => {
    // A catalog where each package is mentioned only by its @setu-ts name in a
    // single unstructured paragraph must NOT pass — the review found this did.
    const pluginsMd = PUBLISHED_PACKAGES.map((pkg) => {
      const match = pkg.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
      const firstSegment = match?.[1];
      const secondSegment = match?.[2];
      const name = (firstSegment === 'starters' && secondSegment)
        ? secondSegment
        : (match?.[1] ?? pkg.replace('packages/', ''));
      return `@setu-ts/${name}`;
    }).join(' ');
    const runtimeMd =
      '# Runtime\n\n| Deno | Node | Bun | Workers |\n|------|------|-----|---------|\n| ✅ | ✅ | ✅ | ✅ |\n';

    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      PUBLISHED_PACKAGES,
      PACKAGE_METADATA,
    );
    // The synthetic substring-only catalog must fail — it has no structured
    // sections, no README links, no API links, no runtime statuses.
    expect(findings.length).toBeGreaterThan(0);
  });

  // A helper to build one realistic structural section for a package, so
  // mutations prove the structural validator discriminates.
  function buildSection(pkg: string, opts: {
    purpose?: string;
    readmeLink?: string;
    apiLink?: string;
    runtimeCells?: string;
    caveat?: string;
  }): string {
    const purpose = opts.purpose ?? 'Test package.';
    const readme = opts.readmeLink ?? `../packages/${pkg}/README.md`;
    const api = opts.apiLink ?? `./api/${pkg}/src/index.ts/index.html`;
    const cells = opts.runtimeCells ?? '| ✅ | ✅ | ✅ | ✅ |';
    const caveatLine = opts.caveat ? `\n\n**Caveat:** ${opts.caveat}` : '';
    return `### @setu-ts/${pkg}\n\n**Purpose:** ${purpose}\n\n**Runtime Compatibility:**\n\n| Deno | Node | Bun | Workers |\n|------|------|-----|---------|\n${cells}${caveatLine}\n\n**Links:**\n\n- [README](${readme})\n- [API Reference](${api})\n`;
  }

  it('rejects a duplicate package section', () => {
    const section = buildSection('common', {});
    const pluginsMd = `# Plugins\n\n${section}\n---\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    // A duplicate section means the package appears twice structurally.
    expect(findings.some((f) => f.message.includes('common'))).toBe(true);
  });

  it('rejects an extra catalog section not in PUBLISHED_PACKAGES', () => {
    const section = buildSection('nonexistent-plugin', {});
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(pluginsMd, runtimeMd, [], PACKAGE_METADATA);
    expect(findings.some((f) => f.message.includes('Extra catalog section'))).toBe(true);
  });

  it('rejects a wrong README link', () => {
    const section = buildSection('common', { readmeLink: '../packages/wrong/README.md' });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('wrong or missing README link'))).toBe(true);
  });

  it('rejects a wrong API link', () => {
    const section = buildSection('common', { apiLink: './api/wrong/index.html' });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('wrong or missing API link'))).toBe(true);
  });

  it('rejects a missing runtime compatibility table', () => {
    const section =
      `### @setu-ts/common\n\n**Purpose:** Test.\n\n**Links:**\n\n- [README](../packages/common/README.md)\n- [API Reference](./api/common/src/index.ts/index.html)\n`;
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('no runtime compatibility table'))).toBe(true);
  });

  it('rejects a missing required provider caveat', () => {
    // mail-plugin requires a caveat mentioning "SMTP".
    const section = buildSection('mail-plugin', {});
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/mail-plugin'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('missing the required caveat'))).toBe(true);
  });

  it('accepts a section with the required caveat present', () => {
    const section = buildSection('mail-plugin', {
      caveat: 'SMTP raw-socket provider is Node/Deno/Bun only.',
    });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/mail-plugin'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('caveat'))).toBe(false);
  });

  it('rejects a missing Purpose line', () => {
    const section =
      `### @setu-ts/common\n\n**Runtime Compatibility:**\n\n| Deno | Node | Bun | Workers |\n|------|------|-----|---------|\n| ✅ | ✅ | ✅ | ✅ |\n\n**Links:**\n\n- [README](../packages/common/README.md)\n- [API Reference](./api/common/src/index.ts/index.html)\n`;
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('no **Purpose:**'))).toBe(true);
  });

  it('rejects a runtime cell that does not match PACKAGE_METADATA', () => {
    // common is UNIVERSAL (all true); a ❌ for deno must fail.
    const section = buildSection('common', { runtimeCells: '| ❌ | ✅ | ✅ | ✅ |' });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/common'],
      PACKAGE_METADATA,
    );
    expect(findings.some((f) => f.message.includes('does not match PACKAGE_METADATA'))).toBe(true);
  });
});

describe('documentation gate — local links and anchors', () => {
  it('rejects a fake generated API link while accepting a real one', async () => {
    const fs = {
      readTextFile: async (path: string) => await Deno.readTextFile(path),
      readDir: (path: string) => Deno.readDir(path),
      stat: (path: string) => Deno.stat(path),
    };
    const { targets } = await collectApiEntrypoints(fs);
    const generatedApiPages = buildGeneratedApiPages(targets);

    // A real catalog API page (common) must resolve.
    const realLink = '[API](./api/common/src/index.ts/index.html)';
    const realSource = realLink;
    const realFindings = await checkLocalLinks('docs/test.md', realSource, [], generatedApiPages);
    expect(realFindings.length).toBe(0);

    // A fake generated API link must be rejected.
    const fakeLink = '[API](./api/common/does/not/exist.html)';
    const fakeSource = fakeLink;
    const fakeFindings = await checkLocalLinks('docs/test.md', fakeSource, [], generatedApiPages);
    expect(fakeFindings.length).toBeGreaterThan(0);
    expect(
      fakeFindings.some((f) => f.message.includes('does not resolve to a known generated page')),
    )
      .toBe(true);
  });

  it('skips generated API links when the page set is null', async () => {
    // When output has not been generated, the gate skips rather than falsely rejecting.
    const link = '[API](./api/common/src/index.ts/index.html)';
    const findings = await checkLocalLinks('docs/test.md', link, [], null);
    expect(findings.length).toBe(0);
  });

  it('rejects a cross-file anchor that matches no heading in the target file', async () => {
    // Write a temp target file with one heading, then link to a missing anchor.
    const targetPath = 'test/fixtures/link-target.md';
    await Deno.writeTextFile(targetPath, '# Target\n\n## Real Heading\n');
    try {
      const source = `[bad](../test/fixtures/link-target.md#missing-heading)`;
      const findings = await checkLocalLinks('docs/test.md', source, [targetPath]);
      expect(findings.some((f) => f.message.includes('matches no heading'))).toBe(true);
    } finally {
      await Deno.remove(targetPath);
    }
  });

  it('accepts a cross-file anchor that matches a heading in the target file', async () => {
    const targetPath = 'test/fixtures/link-target.md';
    await Deno.writeTextFile(targetPath, '# Target\n\n## Real Heading\n');
    try {
      const source = `[good](../test/fixtures/link-target.md#real-heading)`;
      const findings = await checkLocalLinks('docs/test.md', source, [targetPath]);
      expect(findings.length).toBe(0);
    } finally {
      await Deno.remove(targetPath);
    }
  });

  it('rejects a same-file anchor that matches no heading', async () => {
    const source = '# T\n\n## A\n\nSee [B](#nope).\n';
    const findings = await checkLocalLinks('docs/t.md', source, ['docs/t.md']);
    expect(findings.some((f) => f.message.includes('matches no heading'))).toBe(true);
  });

  it('accepts a decoded URI-encoded path and fragment', async () => {
    const targetPath = 'test/fixtures/link target.md';
    await Deno.writeTextFile(targetPath, '# Target\n\n## Real Heading\n');
    try {
      // %20 decodes to a space; the path resolves.
      const source = `[good](../test/fixtures/link%20target.md#real-heading)`;
      const findings = await checkLocalLinks('docs/test.md', source, [targetPath]);
      expect(findings.length).toBe(0);
    } finally {
      await Deno.remove(targetPath);
    }
  });

  it('strips a query string before resolving', async () => {
    const targetPath = 'test/fixtures/query-target.md';
    await Deno.writeTextFile(targetPath, '# Target\n');
    try {
      const source = `[good](../test/fixtures/query-target.md?raw=true)`;
      const findings = await checkLocalLinks('docs/test.md', source, [targetPath]);
      expect(findings.length).toBe(0);
    } finally {
      await Deno.remove(targetPath);
    }
  });

  it('resolves a directory link via README fallback', async () => {
    // packages/common/README.md exists — a link to packages/common must resolve.
    const source = '[common](../packages/common)';
    const findings = await checkLocalLinks('docs/test.md', source, ['packages/common/README.md']);
    expect(findings.length).toBe(0);
  });

  it('accepts a non-Markdown asset link (image) without parsing it as a document', async () => {
    // deno.json is a real non-markdown file at the repo root; a link from
    // docs/ to it must resolve, and a fragment on it is not parsed as a doc.
    const source = '[manifest](../deno.json)';
    const findings = await checkLocalLinks('docs/test.md', source, ['deno.json']);
    expect(findings.length).toBe(0);
  });

  it('exercises the file:line anchor format (packages/foo.ts:79)', async () => {
    // A link to a real source file with a :line suffix must resolve.
    const source = '[source](../packages/common/src/index.ts:1)';
    const findings = await checkLocalLinks('docs/test.md', source, [
      'packages/common/src/index.ts',
    ]);
    expect(findings.length).toBe(0);
  });

  it('exercises the disk-stat fallback for a real file not in allFiles', async () => {
    // .editorconfig is a real file not passed in allFiles; the disk stat must resolve it.
    const source = '[editor](.editorconfig)';
    const findings = await checkLocalLinks('test.md', source, []);
    expect(findings.length).toBe(0);
  });

  it('rejects a link to a nonexistent file with no anchor', async () => {
    const source = '[bad](./does-not-exist.md)';
    const findings = await checkLocalLinks('docs/test.md', source, []);
    expect(findings.some((f) => f.message.includes('does not resolve'))).toBe(true);
  });

  it('exercises a fenced-line link (skipped) and external link (skipped)', async () => {
    // A link inside a code fence is skipped; an external link is skipped.
    const source = '# T\n\n```ts\n[bad](./nonexistent.md)\n```\n\n[ext](https://example.com)\n';
    const findings = await checkLocalLinks('docs/test.md', source, []);
    expect(findings.length).toBe(0);
  });

  it('rejects a same-file path+anchor where the file resolves but the anchor does not', async () => {
    // A link to the current file itself with a missing anchor must report the
    // same-file anchor mismatch (the file resolves, but the anchor does not).
    const source = '# T\n\n## A\n\nSee [B](./test.md#nope).\n';
    const findings = await checkLocalLinks('docs/test.md', source, ['docs/test.md']);
    expect(findings.some((f) => f.message.includes('matches no heading'))).toBe(true);
  });

  it('accepts a non-Markdown asset link with a fragment (fragment not validated)', async () => {
    // deno.json is a real non-markdown file; a fragment on it is not parsed.
    const source = '[manifest](../deno.json#L1)';
    const findings = await checkLocalLinks('docs/test.md', source, ['deno.json']);
    expect(findings.length).toBe(0);
  });
});

describe('documentation gate — script subprocess integration', () => {
  it('check-docs.ts main() exits 0 on a single good file', async () => {
    const cmd = new Deno.Command('deno', {
      args: ['run', '--allow-read', '--allow-run', 'scripts/check-docs.ts', 'README.md'],
      stdout: 'piped',
      stderr: 'piped',
    });
    const output = await cmd.output();
    expect(output.code).toBe(0);
  });

  it('check-docs.ts main() default scan exits 0 on the real repository', async () => {
    const cmd = new Deno.Command('deno', {
      args: ['run', '--allow-read', '--allow-run', 'scripts/check-docs.ts'],
      stdout: 'piped',
      stderr: 'piped',
    });
    const output = await cmd.output();
    expect(output.code).toBe(0);
  });

  it('check-docs.ts main() exits 1 on a file with a broken anchor', async () => {
    const tmpPath = '.tmp/broken-anchor.md';
    await Deno.mkdir('.tmp', { recursive: true });
    await Deno.writeTextFile(tmpPath, '# T\n\n## A\n\nSee [B](#nope).\n');
    try {
      const cmd = new Deno.Command('deno', {
        args: ['run', '--allow-read', 'scripts/check-docs.ts', tmpPath],
        stdout: 'piped',
        stderr: 'piped',
      });
      const output = await cmd.output();
      expect(output.code).toBe(1);
    } finally {
      await Deno.remove(tmpPath);
    }
  });
});
