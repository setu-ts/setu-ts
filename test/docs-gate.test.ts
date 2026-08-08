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
  checkAppsReadmeCoverage,
  checkDocument,
  checkExamplesCoverage,
  checkRequiredGuides,
  findSwallowedHeadings,
  scanFences,
} from '../scripts/check-docs.ts';

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
  it('reports a package missing from the catalog', async () => {
    const { checkPackageCatalog } = await import('../scripts/check-docs.ts');
    const { PUBLISHED_PACKAGES } = await import('../scripts/release-packages.ts');
    const { PACKAGE_METADATA } = await import('../scripts/jsr-metadata.ts');

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

  it('passes when all packages are in the catalog', async () => {
    const { checkPackageCatalog } = await import('../scripts/check-docs.ts');
    const { PUBLISHED_PACKAGES } = await import('../scripts/release-packages.ts');
    const { PACKAGE_METADATA } = await import('../scripts/jsr-metadata.ts');

    // Build a plugins.md with all packages
    const packageSections = PUBLISHED_PACKAGES.map((pkg) => {
      // Handle starters specially
      const match = pkg.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
      const firstSegment = match?.[1];
      const secondSegment = match?.[2];
      const name = (firstSegment === 'starters' && secondSegment)
        ? secondSegment
        : (match?.[1] ?? pkg.replace('packages/', ''));
      const pathPrefix = firstSegment === 'starters' ? 'starters/' : '';
      return `### @setu-ts/${name}\n\nContent.\n\n- [README](../packages/${pathPrefix}${name}/README.md)\n- [API Reference](./api/packages/${pathPrefix}${name}/src/index.ts.html)\n`;
    }).join('\n');

    const pluginsMd = `# Plugins\n\n${packageSections}`;
    const runtimeMd =
      '# Runtime\n\n| Deno | Node | Bun | Workers |\n|------|------|-----|---------|\n| ✅ | ✅ | ✅ | ✅ |\n';

    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      PUBLISHED_PACKAGES,
      PACKAGE_METADATA,
    );

    // Should have no findings for a complete catalog
    expect(findings.length).toBe(0);
  });
});
