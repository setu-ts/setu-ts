import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  extractDescription,
  extractTitle,
  resolvedMdToRoute,
  rewriteDocsHtml,
  rewriteHref,
} from '../src/lib/docs-links.ts';

describe('rewriteHref', () => {
  it('maps a sibling guide link from the hub to its route', () => {
    expect(rewriteHref('./getting-started.md', 'README')).toBe(
      '/docs/getting-started/',
    );
  });

  it('maps the hub link from a guide back to /docs/', () => {
    expect(rewriteHref('./README.md', 'getting-started')).toBe('/docs/');
  });

  it('maps the hub link without the ./ prefix too', () => {
    expect(rewriteHref('README.md', 'cli')).toBe('/docs/');
  });

  it('maps a root-level README link to the landing page', () => {
    expect(rewriteHref('../README.md', 'getting-started')).toBe('/');
  });

  it('preserves anchors on site routes', () => {
    expect(rewriteHref('./cli.md#scaffolding-projects', 'README')).toBe(
      '/docs/cli/#scaffolding-projects',
    );
  });

  it('falls back to GitHub blobs for root-level docs', () => {
    expect(rewriteHref('../ARCHITECTURE.md', 'plugin-architecture')).toBe(
      'https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md',
    );
    expect(rewriteHref('../CHANGELOG.md#v060', 'upgrading')).toBe(
      'https://github.com/setu-ts/setu-ts/blob/main/CHANGELOG.md#v060',
    );
  });

  it('falls back to GitHub trees for non-Markdown repository paths', () => {
    expect(rewriteHref('../apps/full-stack', 'examples')).toBe(
      'https://github.com/setu-ts/setu-ts/tree/main/apps/full-stack',
    );
  });

  it('routes grafted API reference links to the public API tree', () => {
    expect(rewriteHref('./api/', 'README')).toBe('/api/');
    expect(
      rewriteHref('./api/common/src/index.ts/index.html#IPlugin', 'plugins'),
    ).toBe(
      '/api/common/src/index.ts/index.html#IPlugin',
    );
  });

  it('leaves hashes, absolute URLs, and site-absolute paths untouched', () => {
    expect(rewriteHref('#section', 'cli')).toBe('#section');
    expect(rewriteHref('https://jsr.io/@setu-ts', 'cli')).toBe(
      'https://jsr.io/@setu-ts',
    );
    expect(rewriteHref('http://localhost:3000', 'cli')).toBe(
      'http://localhost:3000',
    );
    expect(rewriteHref('mailto:x@example.com', 'cli')).toBe(
      'mailto:x@example.com',
    );
    expect(rewriteHref('/docs/cli/', 'cli')).toBe('/docs/cli/');
  });
});

describe('resolvedMdToRoute', () => {
  it('routes the hub specially', () => {
    expect(resolvedMdToRoute('/docs/README.md')).toBe('/docs/');
  });

  it('routes guides under /docs/<name>/', () => {
    expect(resolvedMdToRoute('/docs/getting-started.md')).toBe(
      '/docs/getting-started/',
    );
  });

  it('routes the root README to the landing page', () => {
    expect(resolvedMdToRoute('/README.md')).toBe('/');
  });

  it('returns the resolved path unchanged for unrendered root docs', () => {
    expect(resolvedMdToRoute('/ARCHITECTURE.md')).toBe('/ARCHITECTURE.md');
  });
});

describe('rewriteDocsHtml', () => {
  it('rewrites doc links and leaves everything else alone', () => {
    const html =
      '<p>Read <a href="./cli.md">the CLI guide</a> and <a href="https://jsr.io">jsr.io</a>.</p>';
    const out = rewriteDocsHtml(html, 'README');
    expect(out).toBe(
      '<p>Read <a href="/docs/cli/">the CLI guide</a> and <a href="https://jsr.io">jsr.io</a>.</p>',
    );
  });
});

describe('extractTitle', () => {
  it('extracts the first h1 text', () => {
    expect(extractTitle('<h1 id="x">Getting Started</h1><p>rest</p>')).toBe(
      'Getting Started',
    );
  });

  it('decodes entities in the title', () => {
    expect(extractTitle('<h1>CQRS &amp; events</h1>')).toBe('CQRS & events');
  });

  it('returns undefined without an h1', () => {
    expect(extractTitle('<p>no heading</p>')).toBeUndefined();
  });
});

describe('extractDescription', () => {
  it('extracts and clips the first paragraph', () => {
    const long = 'x'.repeat(200);
    const out = extractDescription(`<p>${long}</p>`);
    expect(out).toBeDefined();
    expect(out?.length).toBe(160);
  });

  it('returns undefined without a paragraph', () => {
    expect(extractDescription('<h1>only</h1>')).toBeUndefined();
  });
});
