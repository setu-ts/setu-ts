import { describe, expect, it } from 'vitest';
import { siteSection } from '../src/lib/site-section.ts';
import { exampleStart, insertAfterTitle, tryItHtml } from '../src/lib/example-start.ts';
import { APPS, EXAMPLE_NAVIGATION, PACKAGES, PACKAGE_NAVIGATION } from '../src/lib/repository.ts';
import { EXAMPLES_REPOSITORY_ROUTE } from '../src/lib/docs-links.ts';
import { EXAMPLES, EXCLUDED_EXAMPLES } from '../../packages/cli/src/examples/catalog.ts';

describe('siteSection', () => {
  it.each([
    ['/docs/examples', 'examples'],
    ['/docs/examples/', 'examples'],
    ['/examples/cqrs/', 'examples'],
    ['/docs/getting-started/', 'docs'],
    ['/docs/', 'docs'],
    ['/packages/kernel/', 'docs'],
    ['/changelog/', 'docs'],
    ['/api/', 'api'],
    ['/', undefined],
    // A prefix only matches a whole path segment.
    ['/docs-old/', undefined],
    ['/examplesx/', undefined],
  ] as const)('%s → %s', (pathname, expected) => {
    expect(siteSection(pathname)).toBe(expected);
  });
});

describe('exampleStart', () => {
  it('covers every rendered example page, so none opens without a Try it box', () => {
    expect(APPS.length).toBeGreaterThan(0);
    for (const app of APPS) expect(() => exampleStart(app)).not.toThrow();
  });

  it('offers --example exactly for the CLI catalog, never for an excluded example', () => {
    for (const app of EXAMPLES) {
      expect(exampleStart(app)).toEqual({
        kind: 'example',
        command: `npm create @setu-ts my-app -- --example ${app}`,
      });
    }
    for (const app of Object.keys(EXCLUDED_EXAMPLES)) {
      expect(exampleStart(app).kind).toBe('repository');
    }
  });

  it.each([
    ['full-stack', 'npm create @setu-ts my-app -- --template full-stack'],
    ['compiled-binary', 'npm create @setu-ts my-app -- --template rest'],
    ['cloudflare', 'npm create @setu-ts my-app -- --runtime cloudflare-workers'],
    ['realtime-clients', 'npm create @setu-ts my-app -- --template rest'],
    ['plugin-development', 'npm create @setu-ts my-app -- --template rest'],
  ])('maps the repository-only %s to the CLI recommendation', (app, command) => {
    expect(exampleStart(app)).toEqual({ kind: 'repository', command });
  });

  it('refuses an example the catalog does not know', () => {
    expect(() => exampleStart('nope')).toThrow(/neither offered nor excluded/);
  });
});

describe('tryItHtml', () => {
  it('runs an --example project with npm start', () => {
    const html = tryItHtml('cqrs');
    expect(html).toContain('Start your own copy of this example:');
    expect(html).toContain(
      '<pre><code>npm create @setu-ts my-app -- --example cqrs\ncd my-app &amp;&amp; npm install\nnpm start</code></pre>',
    );
  });

  it('runs a Workers scaffold with Wrangler and other scaffolds with start:dev', () => {
    expect(tryItHtml('cloudflare')).toContain('&amp;&amp; npm install\nnpx wrangler dev</code>');
    expect(tryItHtml('full-stack')).toContain('npm install\nnpm run start:dev</code>');
    expect(tryItHtml('full-stack')).toContain('runs inside the Setu-TS repository');
  });

  it('carries no paragraph, so the README stays the meta description', () => {
    for (const app of APPS) expect(tryItHtml(app)).not.toMatch(/<p[\s>]/);
  });
});

describe('insertAfterTitle', () => {
  it('places the fragment straight after the first h1', () => {
    expect(insertAfterTitle('<h1 id="x">T</h1><p>a</p><h1>U</h1>', '[box]')).toBe(
      '<h1 id="x">T</h1>[box]<p>a</p><h1>U</h1>',
    );
  });

  it('places the fragment first when the page has no h1', () => {
    expect(insertAfterTitle('<p>a</p>', '[box]')).toBe('[box]<p>a</p>');
  });
});

describe('PACKAGE_NAVIGATION', () => {
  it('lists every published package exactly once', () => {
    const hrefs = PACKAGE_NAVIGATION.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs.sort()).toEqual(PACKAGES.map((pkg) => `/packages/${pkg.slug}/`).sort());
  });
});

describe('EXAMPLE_NAVIGATION', () => {
  it('lists the guide, the repository page and every example once', () => {
    const hrefs = EXAMPLE_NAVIGATION.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs).toEqual([
      '/docs/examples/',
      EXAMPLES_REPOSITORY_ROUTE,
      ...APPS.map((app) => `/examples/${app}/`),
    ]);
  });

  it('keeps the repository page route free of any example', () => {
    expect(EXAMPLES_REPOSITORY_ROUTE).toBe('/examples/repository/');
    expect(APPS).not.toContain('repository');
  });
});
