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
  checkReadmeApiLink,
  checkRequiredGuides,
  findSwallowedHeadings,
  publicApiAnchors,
  scanFences,
} from '../scripts/check-docs.ts';
import { collectApiEntrypoints } from '../scripts/generate-api-docs.ts';
import { PUBLISHED_PACKAGES } from '../scripts/release-packages.ts';
import {
  buildKindIndex,
  diffExportsTable,
  kindLabel,
  parseExportsTable,
  renderExportsTable,
  symbolsForFile,
} from '../scripts/package-exports.ts';
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
      'docs/cli.md',
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
    const examplesGuide = '# Examples\n\n## REST Example\n\nSee [rest](../apps/rest) for more.';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkExamplesCoverage(examplesGuide, appDirs);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.message.includes('minimal'))).toBe(true);
    expect(findings.some((f) => f.message.includes('new-app'))).toBe(true);
  });

  it('passes when every app is linked in the real table format', () => {
    const examplesGuide = [
      '# Examples',
      '',
      '| [minimal](../apps/minimal) | Minimal example |',
      '| [rest](../apps/rest) | REST example |',
      '| [new-app](../apps/new-app) | New app example |',
    ].join('\n');
    const appDirs = ['minimal', 'rest', 'new-app'];

    expect(checkExamplesCoverage(examplesGuide, appDirs).length).toBe(0);
  });

  /**
   * The gate used to be `content.includes(dir)`, which any prose satisfied.
   * Deleting the `database` table row AND its `### database` section from the
   * real `docs/examples.md` left `check:docs` green, because "database" still
   * appeared in "SSR with database integration", "D1 database queries", and
   * `DatabasePlugin`. Every app named after an ordinary word was unpoliced.
   */
  it('a prose mention is NOT coverage — only a link to the directory is', () => {
    const proseOnly = [
      '# Examples',
      '',
      'The full-stack example shows SSR with database integration.',
      'It also covers D1 database queries via `DatabasePlugin`.',
    ].join('\n');

    const findings = checkExamplesCoverage(proseOnly, ['database']);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('database');
  });

  it('a longer sibling directory does not satisfy a shorter name', () => {
    const guide = '| [database-extra](../apps/database-extra) | Other |';

    expect(checkExamplesCoverage(guide, ['database']).length).toBe(1);
    expect(checkExamplesCoverage(guide, ['database-extra']).length).toBe(0);
  });

  it('accepts a link carrying an anchor or trailing slash', () => {
    const guide = '[a](../apps/minimal/) and [b](../apps/rest#setup)';

    expect(checkExamplesCoverage(guide, ['minimal', 'rest']).length).toBe(0);
  });
});

describe('documentation gate — apps README coverage', () => {
  it('reports an app not listed in apps/README.md', () => {
    const appsReadme = '# Apps\n\n| [minimal](./minimal) | Minimal example |';
    const appDirs = ['minimal', 'rest', 'new-app'];

    const findings = checkAppsReadmeCoverage(appsReadme, appDirs);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.message.includes('rest'))).toBe(true);
    expect(findings.some((f) => f.message.includes('new-app'))).toBe(true);
  });

  it('passes when every app is linked in the real `./dir` format', () => {
    const appsReadme = [
      '# Apps',
      '',
      '| [minimal](./minimal) | Minimal example |',
      '| [rest](./rest) | REST example |',
      '| [new-app](./new-app) | New app example |',
    ].join('\n');
    const appDirs = ['minimal', 'rest', 'new-app'];

    expect(checkAppsReadmeCoverage(appsReadme, appDirs).length).toBe(0);
  });

  it('a bare table cell naming the app is NOT a listing', () => {
    // The previous implementation accepted this, so a row could lose its link
    // (and with it its navigability) without the gate noticing.
    const appsReadme = '# Apps\n\n| Name | Description |\n| minimal | Minimal example |';

    expect(checkAppsReadmeCoverage(appsReadme, ['minimal']).length).toBe(1);
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

  it('rejects a fictional ✅ (...) override with no source-grounded entry', () => {
    // messaging-plugin is NO_EDGE (workerd: false). A `✅ (HTTP brokers)` cell
    // was the review's fictional override — no HTTP broker exists in the
    // package, and no CATALOG_OVERRIDES entry names it. The hardened gate must
    // reject it (the old arbitrary-parenthetical exemption let it pass).
    const section = buildSection('messaging-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ✅ (HTTP brokers) |',
      caveat: 'Redis Streams broker',
    });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/messaging-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) =>
        f.message.includes('no source-grounded override') &&
        f.message.includes('messaging-plugin')
      ),
    ).toBe(true);
  });

  it('rejects a ✅ cell disagreeing with metadata even with a non-enumerated provider', () => {
    // queue-plugin is NO_EDGE. `✅ (fictional)` is not in CATALOG_OVERRIDES.
    const section = buildSection('queue-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ✅ (fictional) |',
      caveat: 'Redis queue adapter',
    });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/queue-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) =>
        f.message.includes('no source-grounded override') &&
        f.message.includes('queue-plugin')
      ),
    ).toBe(true);
  });

  it('rejects queue-plugin cross-attributing Workers Queues to itself', () => {
    // Workers Queues belong to cloudflare-plugin, not queue-plugin. A section
    // that LISTS "Workers Queues" as a queue-plugin adapter (a `- ` list item)
    // is a cross-package attribution the gate must flag. A blockquote that
    // mentions the provider to point at the owner is NOT flagged.
    const base = buildSection('queue-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ❌ |',
      caveat: 'Redis queue adapter',
    });
    // Append an Adapters list that includes the forbidden provider.
    const section = base +
      '\n**Adapters:**\n\n- Memory\n- Redis\n- RabbitMQ\n- SQS\n- Workers Queues\n';
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/queue-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) =>
        f.message.includes('attributes "Workers Queues"') &&
        f.message.includes('cloudflare-plugin')
      ),
    ).toBe(true);
  });

  it('rejects static-plugin cross-attributing R2 to itself', () => {
    // R2 belongs to cloudflare-plugin. A static-plugin section that LISTS R2 as
    // its own provider (a `- ` list item) is a cross-attribution.
    const base = buildSection('static-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ❌ |',
      caveat: 'Static files',
    });
    const section = base + '\n**Providers:**\n\n- Local filesystem\n- R2\n';
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/static-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) =>
        f.message.includes('attributes "R2"') &&
        f.message.includes('cloudflare-plugin')
      ),
    ).toBe(true);
  });

  it('rejects realtime-backplane-plugin cross-attributing Durable Objects', () => {
    // Durable Objects belong to cloudflare-plugin. A backplane section that
    // LISTS "Durable Objects" as its own transport (a `- ` list item) is a
    // cross-attribution.
    const base = buildSection('realtime-backplane-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ✅ |',
      caveat: 'redis transport',
    });
    const section = base +
      '\n**Transports:**\n\n- Memory\n- Messaging\n- Redis\n- Durable Objects\n';
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/realtime-backplane-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) =>
        f.message.includes('attributes "Durable Objects"') &&
        f.message.includes('cloudflare-plugin')
      ),
    ).toBe(true);
  });

  it('does NOT flag a blockquote that mentions a provider to point at the owner', () => {
    // A `>` blockquote saying "Workers Queues belong to cloudflare-plugin" is a
    // legitimate cross-reference, not a list-item attribution. The gate must
    // not flag it.
    const base = buildSection('queue-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ❌ |',
      caveat: 'Redis queue adapter',
    });
    const section = base +
      '\n> Workers Queues belong to @setu-ts/cloudflare-plugin, not this package.\n';
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/queue-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) => f.message.includes('attributes "Workers Queues"')),
    ).toBe(false);
  });

  it('accepts an enumerated valid override (storage-plugin Workers R2)', () => {
    // storage-plugin is PORTABLE (workerd: true), so `✅ (R2)` matches metadata
    // and needs no override. This test confirms the gate does NOT false-flag a
    // legitimate provider caveat on a package whose metadata already says ✅.
    const section = buildSection('storage-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ✅ (R2) |',
      caveat: 'S3 storage provider',
    });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/storage-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) => f.message.includes('no source-grounded override')),
    ).toBe(false);
  });

  it('accepts an enumerated valid override (service-discovery Workers HTTP)', () => {
    // service-discovery-plugin is NO_EDGE (workerd: false), but the HTTP
    // providers (Consul/Kubernetes) are Workers-portable. CATALOG_OVERRIDES
    // enumerates this package/runtime/provider, so `✅ (HTTP)` is accepted.
    const section = buildSection('service-discovery-plugin', {
      runtimeCells: '| ✅ | ✅ | ✅ | ✅ (HTTP) |',
      caveat: 'Consul service discovery',
    });
    const pluginsMd = `# Plugins\n\n${section}`;
    const runtimeMd = '# Runtime\n\nDeno Node Bun Workers\n';
    const findings = checkPackageCatalog(
      pluginsMd,
      runtimeMd,
      ['packages/service-discovery-plugin'],
      PACKAGE_METADATA,
    );
    expect(
      findings.some((f) => f.message.includes('no source-grounded override')),
    ).toBe(false);
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

  it('includes the top-level generated docs/api/index.html in the page set', async () => {
    // `deno doc --html` always emits a top-level site index at
    // docs/api/index.html. buildGeneratedApiPages must include it so a doc
    // linking to the bare top-level index resolves instead of false-positiving.
    const fs = {
      readTextFile: async (path: string) => await Deno.readTextFile(path),
      readDir: (path: string) => Deno.readDir(path),
      stat: (path: string) => Deno.stat(path),
    };
    const { targets } = await collectApiEntrypoints(fs);
    const generatedApiPages = buildGeneratedApiPages(targets);
    expect(generatedApiPages.has('docs/api/index.html')).toBe(true);
    // A link to the top-level index from a docs/ file must resolve.
    const indexLink = '[Index](./api/index.html)';
    const findings = await checkLocalLinks('docs/test.md', indexLink, [], generatedApiPages);
    expect(findings.length).toBe(0);
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

describe('documentation gate — package README navigation', () => {
  const anchors = new Set(['storage-setu-tsstorage-plugin', 'api-reference-setu-tscommon']);
  const BASE = 'https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md';

  it('accepts an absolute link carrying an anchor that exists', () => {
    const readme = `# x\n\nSee [PUBLIC_API.md](${BASE}#storage-setu-tsstorage-plugin).\n`;

    expect(checkReadmeApiLink('packages/storage-plugin/README.md', readme, anchors)).toEqual([]);
  });

  it('rejects a bare link, which lands at the top of an 8,000-line document', () => {
    const readme = `# x\n\nSee [PUBLIC_API.md](${BASE}).\n`;

    const findings = checkReadmeApiLink('packages/storage-plugin/README.md', readme, anchors);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('carries no anchor');
  });

  it('rejects an anchor that matches no heading', () => {
    const readme = `# x\n\nSee [PUBLIC_API.md](${BASE}#storage-renamed).\n`;

    const findings = checkReadmeApiLink('packages/storage-plugin/README.md', readme, anchors);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('matches no heading');
  });

  /**
   * JSR resolves a README's relative links against `jsr.io/@setu-ts/`, so this
   * form returns a 400 on the package page. `sdk` and `static-plugin` both
   * shipped it, and the local-link checker cannot see the class at all because
   * these links are absolute `https://` URLs it skips as external.
   */
  it('rejects a relative link to a repository document', () => {
    const readme = '# x\n\nSee [Public API](../../PUBLIC_API.md#storage-setu-tsstorage-plugin).\n';

    const findings = checkReadmeApiLink('packages/sdk/README.md', readme, anchors);

    expect(findings.some((f) => f.message.includes('400 on the package page'))).toBe(true);
  });

  it('rejects a README with no link at all', () => {
    const findings = checkReadmeApiLink('packages/x/README.md', '# x\n\nNothing.\n', anchors);

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('No link to PUBLIC_API.md');
  });

  it('collects anchors at every heading depth, ignoring fenced text', () => {
    const source = [
      '## Storage (`@setu-ts/storage-plugin`)',
      '',
      '### Starter exports and option arms',
      '',
      '```markdown',
      '## Not A Real Heading',
      '```',
    ].join('\n');

    const found = publicApiAnchors(source);

    expect(found.has('storage-setu-tsstorage-plugin')).toBe(true);
    expect(found.has('starter-exports-and-option-arms')).toBe(true);
    expect(found.has('not-a-real-heading')).toBe(false);
  });
});

describe('package exports table', () => {
  const payload = {
    nodes: {
      'file:///repo/packages/cache-plugin/src/index.ts': {
        symbols: [
          {
            name: 'CachePlugin',
            declarations: [{ kind: 'function', declarationKind: 'export' }],
          },
          // Re-exported from common: `deno doc` reports `reference` here.
          {
            name: 'ICacheStore',
            declarations: [{ kind: 'reference', declarationKind: 'export' }],
          },
          // Private declarations must not reach the table.
          {
            name: 'internalHelper',
            declarations: [{ kind: 'function', declarationKind: 'private' }],
          },
        ],
      },
      'file:///repo/packages/common/src/index.ts': {
        symbols: [
          {
            name: 'ICacheStore',
            declarations: [{ kind: 'interface', declarationKind: 'export' }],
          },
        ],
      },
    },
  };

  it('maps deno doc kinds to the words the table uses', () => {
    expect(kindLabel('typeAlias')).toBe('type');
    expect(kindLabel('variable')).toBe('const');
    // An unknown kind passes through rather than being silently dropped.
    expect(kindLabel('somethingNew')).toBe('somethingNew');
  });

  /**
   * `deno doc` reports a re-export as `reference` even when the declaring file
   * is in the same batch, which put "`ICacheStore` | reference" — a word from
   * the tool's internals — into 132 README rows.
   */
  it('resolves a re-exported symbol to its declaring kind, never `reference`', () => {
    const index = buildKindIndex(payload);
    const symbols = symbolsForFile(
      payload,
      'file:///repo/packages/cache-plugin/src/index.ts',
      index,
    );

    expect(index.get('ICacheStore')).toBe('interface');
    expect(symbols.find((s) => s.name === 'ICacheStore')?.kind).toBe('interface');
    expect(symbols.some((s) => s.kind === 'reference')).toBe(false);
  });

  it('without the index the unresolved kind survives, so the index is load-bearing', () => {
    const symbols = symbolsForFile(payload, 'file:///repo/packages/cache-plugin/src/index.ts');

    expect(symbols.find((s) => s.name === 'ICacheStore')?.kind).toBe('reference');
  });

  it('omits non-exported declarations and unknown files', () => {
    const symbols = symbolsForFile(payload, 'file:///repo/packages/cache-plugin/src/index.ts');

    expect(symbols.some((s) => s.name === 'internalHelper')).toBe(false);
    expect(symbolsForFile(payload, 'file:///repo/nope.ts')).toEqual([]);
  });

  it('renders one table per entrypoint, heading each only when there are several', () => {
    const single = renderExportsTable([
      { specifier: '@setu-ts/kernel', symbols: [{ name: 'createApplication', kind: 'function' }] },
    ]);
    expect(single).toContain('| `createApplication` | function |');
    expect(single).not.toContain('### `@setu-ts/kernel`');

    const multi = renderExportsTable([
      { specifier: '@setu-ts/runtime', symbols: [{ name: 'RuntimePlugin', kind: 'function' }] },
      {
        specifier: '@setu-ts/runtime/worker',
        symbols: [{ name: 'defineWorkerTask', kind: 'function' }],
      },
    ]);
    expect(multi).toContain('### `@setu-ts/runtime/worker`');
  });

  it('round-trips: a rendered table parses back to what it claimed', () => {
    const groups = [
      {
        specifier: '@setu-ts/cache-plugin',
        symbols: [
          { name: 'CachePlugin', kind: 'function' },
          { name: 'ICacheStore', kind: 'interface' },
        ],
      },
    ];
    const readme = `# x\n\n${renderExportsTable(groups)}\n\n## Full API\n\nlink\n`;

    expect(parseExportsTable(readme)).toEqual(
      new Set(['CachePlugin function', 'ICacheStore interface']),
    );
    expect(diffExportsTable(readme, groups)).toEqual([]);
  });

  it('reports an omitted export, a fabricated one, and a missing section', () => {
    const groups = [
      { specifier: '@setu-ts/cache-plugin', symbols: [{ name: 'CachePlugin', kind: 'function' }] },
    ];

    const omitted = '# x\n\n## Exports\n\n| Export | Kind |\n| --- | --- |\n\n## Full API\n';
    expect(diffExportsTable(omitted, groups)[0]).toContain('omits 1: CachePlugin (function)');

    const fabricated = '# x\n\n## Exports\n\n| Export | Kind |\n| --- | --- |\n' +
      '| `CachePlugin` | function |\n| `Ghost` | class |\n\n## Full API\n';
    expect(diffExportsTable(fabricated, groups)[0]).toContain('do not exist: Ghost (class)');

    expect(diffExportsTable('# x\n\nNo table.\n', groups)).toEqual([
      'has no `## Exports` section',
    ]);
  });
});

describe('package exports table — malformed payload branches', () => {
  /**
   * `deno doc --json` is an external contract, so the extractor must survive
   * shapes it does not expect rather than throwing mid-gate. Each case here is
   * a field the payload can legitimately omit.
   */
  it('skips a symbol with no name, no declarations, or an untyped declaration', () => {
    const payload = {
      nodes: {
        'file:///repo/a.ts': {
          symbols: [
            { declarations: [{ kind: 'function', declarationKind: 'export' }] }, // no name
            { name: 'NoDecls' }, // no declarations
            { name: 'NoKind', declarations: [{ declarationKind: 'export' }] }, // no kind
            { name: 'Real', declarations: [{ kind: 'function', declarationKind: 'export' }] },
          ],
        },
      },
    };

    expect(symbolsForFile(payload, 'file:///repo/a.ts')).toEqual([
      { name: 'Real', kind: 'function' },
    ]);
    expect([...buildKindIndex(payload).keys()]).toEqual(['Real']);
  });

  it('tolerates an empty payload and a node with no symbols', () => {
    expect([...buildKindIndex({}).keys()]).toEqual([]);
    expect([...buildKindIndex({ nodes: { 'file:///repo/a.ts': {} } }).keys()]).toEqual([]);
  });

  it('keeps the first resolved kind when a name appears in several files', () => {
    const payload = {
      nodes: {
        'file:///repo/a.ts': {
          symbols: [{ name: 'Dup', declarations: [{ kind: 'interface' }] }],
        },
        'file:///repo/b.ts': {
          symbols: [{ name: 'Dup', declarations: [{ kind: 'class' }] }],
        },
      },
    };

    expect(buildKindIndex(payload).get('Dup')).toBe('interface');
  });

  it('parses a table that runs to end of file with no following heading', () => {
    const readme = '# x\n\n## Exports\n\n| Export | Kind |\n| --- | --- |\n| `A` | function |\n';

    expect(parseExportsTable(readme)).toEqual(new Set(['A function']));
  });
});

describe('documentation gate — generated API tree links', () => {
  /**
   * `docs/api/` is generated and gitignored, so it is ABSENT on every clean
   * checkout and present on any machine that has run `deno task docs:api`.
   *
   * The bare site-root link `[Generated API Documentation](./api/)` in
   * `docs/README.md` normalises to `docs/api` — no trailing slash — which the
   * generated-tree guard tested with `startsWith('docs/api/')` did not match.
   * The link fell through to ordinary directory resolution and failed on any
   * tree where the output had not been generated. Locally it always passed;
   * CI failed on the first clean checkout. These cases pin both states.
   */
  const generatedPages = new Set([
    'docs/api/index.html',
    'docs/api/kernel/src/index.ts/index.html',
  ]);

  it('resolves the bare site root to the generated index, tree absent or not', async () => {
    const source = '# Docs\n\n- [Generated API Documentation](./api/)\n';

    // `allFiles` deliberately contains no docs/api entry: the CI condition.
    const findings = await checkLocalLinks(
      'docs/README.md',
      source,
      ['docs/README.md'],
      generatedPages,
    );

    expect(findings).toEqual([]);
  });

  /**
   * The discriminating case, and the only one that can be.
   *
   * `checkLocalLinks` falls back to a disk stat, and `docs/api/` exists on any
   * machine that has run `deno task docs:api` — so a test asserting the bare
   * root RESOLVES passes with or without the fix locally, for the wrong reason.
   * That is the same warm-state trap the bug itself came from.
   *
   * Routing the bare root through the generated-page set inverts it: given a
   * page set that does NOT contain the index, the fixed guard REJECTS the link,
   * while the old `startsWith('docs/api/')` guard misses it, falls through to
   * the disk, finds the real directory, and reports nothing. So this fails
   * without the fix on a machine where the tree EXISTS — precisely where the
   * original defect was invisible.
   */
  it('validates the bare site root against the page set, not the filesystem', async () => {
    const source = '# Docs\n\n- [Generated API Documentation](./api/)\n';
    const withoutIndex = new Set(['docs/api/kernel/src/index.ts/index.html']);

    const findings = await checkLocalLinks(
      'docs/README.md',
      source,
      ['docs/README.md'],
      withoutIndex,
    );

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('does not resolve to a known generated page');
  });

  it('accepts the site root written without a trailing slash', async () => {
    const source = '# Docs\n\n- [API](./api)\n';

    expect(await checkLocalLinks('docs/README.md', source, ['docs/README.md'], generatedPages))
      .toEqual([]);
  });

  it('still rejects a generated page that the manifest cannot produce', async () => {
    const source = '# Docs\n\n- [Ghost](./api/no-such-package/src/index.ts/index.html)\n';

    const findings = await checkLocalLinks(
      'docs/README.md',
      source,
      ['docs/README.md'],
      generatedPages,
    );

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('does not resolve to a known generated page');
  });

  it('does not extend the exemption to any other missing directory', async () => {
    const source = '# Docs\n\n- [Nope](./nonexistent-dir/)\n';

    const findings = await checkLocalLinks(
      'docs/README.md',
      source,
      ['docs/README.md'],
      generatedPages,
    );

    expect(findings.length).toBe(1);
    expect(findings[0]?.message).toContain('does not resolve to an existing file or directory');
  });

  it('skips generated links entirely when the page set is unavailable', async () => {
    const source = '# Docs\n\n- [API](./api/)\n- [Ghost](./api/ghost/index.html)\n';

    expect(await checkLocalLinks('docs/README.md', source, ['docs/README.md'], null)).toEqual([]);
  });
});
