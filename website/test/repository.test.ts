import { describe, expect, it } from 'vitest';
import { dirname } from 'node:path';
import {
  EXAMPLE_FILES,
  PACKAGES,
  APPS,
  readSource,
  TRACKED_FILES,
  exampleFiles,
  publicApiSections,
} from '../src/lib/repository.ts';
import { rewriteHref, fileAnchor } from '../src/lib/docs-links.ts';
import { markdownLinks } from '../src/lib/link-gate.ts';

/** Source-only targets are deliberate GitHub fallbacks, never substitutes for rendered reading. */
const ALLOWED_GITHUB_KINDS = [
  { kind: 'package source', path: /^packages\/.+\.(?:ts|json)$/ },
  {
    kind: 'package source documents',
    path: /^packages\/.+\/(?!(?:README|AGENT_CARD)\.md$)[^/]+\.md$/,
  },
  { kind: 'example source', path: /^apps\/.+\.(?:ts|tsx|json|toml)$/ },
  { kind: 'infrastructure', path: /^(?:docker|k8s)(?:\/|$)/ },
  { kind: 'repository tooling', path: /^(?:scripts|test)(?:\/|$)/ },
  {
    kind: 'repository policy',
    path: /^(?:plans\/|ROADMAP\.md$|AI_GUIDELINES\.md$|CLAUDE\.md$|CONTRIBUTING\.md$|LICENSE$)/,
  },
];

describe('repository reading routes', () => {
  it('covers the release allowlist and all app READMEs', () => {
    expect(PACKAGES).toHaveLength(52);
    expect(APPS).toHaveLength(17);
    expect(PACKAGES.filter((pkg) => pkg.card)).toHaveLength(50);
    for (const [app, files] of Object.entries(EXAMPLE_FILES)) {
      expect(files, app).toContain('smoke.ts');
      for (const file of files) expect(TRACKED_FILES).toContain(`apps/${app}/${file}`);
    }
  });
  it('keeps multi-package API sections and excludes similarly named packages and absent surfaces', () => {
    const markdown =
      '## Both (`@setu-ts/common` + `@setu-ts/kernel`)\nshared\n## Longer (`@setu-ts/kernel-extra`)\nother\n';
    expect(publicApiSections(markdown, '@setu-ts/kernel')).toContain('shared');
    expect(publicApiSections(markdown, '@setu-ts/kernel')).not.toContain('other');
    expect(publicApiSections(markdown, '@setu-ts/create')).toBe('');
    expect(
      publicApiSections(
        '<h2 id="x">Both <code>@setu-ts/kernel</code></h2><p>yes</p><h2>Other</h2><p>no</p>',
        '@setu-ts/kernel',
      ),
    ).toContain('<p>yes</p>');
  });
  it('expands reading directories in order, deduplicates smoke, and uses stable file anchors', () => {
    expect(
      exampleFiles(
        '### demo\n**Read, in order:**\n- [src](../apps/demo/src/)\n- [smoke](../apps/demo/smoke.ts)',
        'demo',
        ['apps/demo/src/z.ts', 'apps/demo/src/a.ts', 'apps/demo/smoke.ts'],
      ),
    ).toEqual(['src/a.ts', 'src/z.ts', 'smoke.ts']);
    expect(exampleFiles('', 'missing', [])).toEqual([]);
    expect(fileAnchor('src/modules/notes/notes.service.ts')).toBe(
      'file-src-modules-notes-notes-service-ts',
    );
  });
  it('rewrites package and app-relative and absolute repository links', () => {
    const cases = [
      ['../../PUBLIC_API.md#cli', 'packages/cli', '/public-api/#cli'],
      ['../kernel', 'packages/cli', '/packages/kernel/'],
      ['./AGENT_CARD.md', 'packages/kernel', '/packages/kernel/agent-card/'],
      ['../starters/rest-starter/README.md', 'packages/cli', '/packages/rest-starter/'],
      [
        'src/modules/todos/',
        'apps/rest-api',
        `/examples/rest-api/#${fileAnchor(EXAMPLE_FILES['rest-api'][0])}`,
      ],
      [
        'https://github.com/setu-ts/setu-ts/blob/main/packages/kernel/README.md#usage',
        '',
        '/packages/kernel/#usage',
      ],
      ['https://github.com/setu-ts/setu-ts/tree/main/apps/minimal', '', '/examples/minimal/'],
    ];
    for (const [href, directory, expected] of cases)
      expect(rewriteHref(href, directory, EXAMPLE_FILES)).toBe(expected);
    expect(rewriteHref('./other.md', 'packages/kernel')).toContain(
      '/blob/main/packages/kernel/other.md',
    );
  });
  it('enumerates every reading link and permits only named source/policy fallbacks', () => {
    const inputs = [
      ...TRACKED_FILES.filter((file) => /^docs\/[^/]+\.md$/.test(file)),
      ...PACKAGES.flatMap((pkg) => [
        `${pkg.directory}/README.md`,
        ...(pkg.card ? [`${pkg.directory}/AGENT_CARD.md`] : []),
      ]),
      ...APPS.map((app) => `apps/${app}/README.md`),
    ];
    const counts: Record<string, number> = Object.fromEntries(
      ALLOWED_GITHUB_KINDS.map(({ kind }) => [kind, 0]),
    );
    const failures: string[] = [];
    let total = 0;
    for (const input of inputs)
      for (const href of markdownLinks(readSource(input))) {
        total++;
        const out = rewriteHref(href, dirname(input), EXAMPLE_FILES);
        const github =
          /^https:\/\/github\.com\/setu-ts\/setu-ts\/(?:blob|tree)\/main\/(.*?)(?:#.*)?$/.exec(out);
        if (!github) {
          if (out.startsWith('https://github.com/setu-ts/setu-ts'))
            counts['repository navigation'] = (counts['repository navigation'] ?? 0) + 1;
          else if (out.startsWith('https://github.com/'))
            counts['upstream project'] = (counts['upstream project'] ?? 0) + 1;
          continue;
        }
        const kind = ALLOWED_GITHUB_KINDS.find((candidate) => candidate.path.test(github[1]));
        if (!kind) failures.push(`${input}: ${href} => ${out}`);
        else counts[kind.kind] = (counts[kind.kind] ?? 0) + 1;
      }
    process.stdout.write(`A4: ${total} links checked; GitHub by kind: ${JSON.stringify(counts)}\n`);
    expect(failures).toEqual([]);
  });
});
