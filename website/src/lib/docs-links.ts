/**
 * Link rewriting for the in-place rendered `docs/` pages.
 *
 * The canonical guides use repository-relative links (`./getting-started.md`,
 * `../README.md`, `../apps/full-stack`, …). The docs stay untouched; this module
 * rewrites those links to site routes (or GitHub fallbacks) at render time, so the
 * rendered pages navigate correctly without a single byte of `docs/` changing.
 *
 * Pure string functions — unit-tested in test/docs-links.test.ts.
 */

/** The public repository, used as the fallback target for anything outside `docs/`. */
export const GITHUB_BASE = 'https://github.com/setu-ts/setu-ts';

function stripAnchor(href: string): { path: string; anchor: string } {
  const hash = href.indexOf('#');
  if (hash === -1) {
    return { path: href, anchor: '' };
  }
  return { path: href.slice(0, hash), anchor: href.slice(hash) };
}

function withAnchor(route: string, anchor: string): string {
  return anchor ? `${route}${anchor}` : route;
}

function githubBlob(path: string, anchor: string): string {
  return withAnchor(`${GITHUB_BASE}/blob/main${path}`, anchor);
}

function githubTree(path: string): string {
  return `${GITHUB_BASE}/tree/main${path}`;
}

/**
 * Map a repository-relative `.md` target (already resolved against the repository
 * root, with a leading slash) to a site route.
 */
export function resolvedMdToRoute(resolved: string): string {
  if (resolved === '/docs/README.md' || resolved === '/docs/README') {
    return '/docs/';
  }
  if (resolved.startsWith('/docs/')) {
    return `/docs/${resolved.slice('/docs/'.length).replace(/\.md$/, '')}/`;
  }
  if (resolved === '/README.md') {
    return '/';
  }
  // Root-level docs and anything unrendered fall through to GitHub. Callers decide
  // blob-vs-tree for non-.md targets; this function is only called for .md paths.
  return resolved;
}

/**
 * Rewrite one `href` found in the rendered HTML of `docs/<sourceName>.md`.
 * Returns the input unchanged when no rewrite applies (hashes, absolute URLs,
 * site-absolute paths).
 */
export function rewriteHref(href: string, _sourceName: string): string {
  if (
    href.startsWith('#') ||
    href.startsWith('http://') ||
    href.startsWith('https://') ||
    href.startsWith('mailto:') ||
    href.startsWith('/')
  ) {
    return href;
  }

  const { path, anchor } = stripAnchor(href);
  if (path === '') {
    return href;
  }

  // The source file is always docs/<sourceName>.md (the hub is docs/README.md), so
  // every relative link resolves against the /docs directory.
  const joined = normalizeJoined('/docs', path);
  const isMd = joined.endsWith('.md') || joined.endsWith('.mdx');

  if (isMd) {
    // Root-level README renders as the landing page; guides under /docs/ get routes;
    // every other root-level doc (ARCHITECTURE, PUBLIC_API, CHANGELOG, …) is browsable
    // on GitHub and must NOT be mistaken for a site route — both forms start with '/'.
    if (joined === '/README.md') {
      return withAnchor('/', anchor);
    }
    if (joined.startsWith('/docs/')) {
      return withAnchor(
        resolvedMdToRoute(joined.replace(/\.mdx$/, '.md')),
        anchor,
      );
    }
    return githubBlob(joined, anchor);
  }

  // API reference pages are generated under docs/api/ before the build and then
  // grafted into the public /api/ subtree. They are part of this site, unlike
  // ordinary non-Markdown repository files.
  if (joined === '/docs/api' || joined.startsWith('/docs/api/')) {
    const route = joined.slice('/docs'.length);
    return withAnchor(path.endsWith('/') ? `${route}/` : route, anchor);
  }

  // Non-Markdown repository targets (examples, docker/, k8s/, fixtures, …) are
  // browsable on GitHub, which redirects blob <-> tree for directories.
  return githubTree(joined);
}

/** Rewrite every relative href in a rendered docs page. */
export function rewriteDocsHtml(html: string, sourceName: string): string {
  return html.replace(/href="([^"]*)"/g, (match, href: string) => {
    const rewritten = rewriteHref(href, sourceName);
    return rewritten === href ? match : `href="${rewritten}"`;
  });
}

/** Decode the HTML entities emitted by the Markdown renderer into metadata text. */
function decodeHtmlEntities(html: string): string {
  const namedEntities: Readonly<Record<string, string>> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    quot: '"',
  };

  return html.replace(
    /&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi,
    (entity, name: string) => {
      const normalized = name.toLowerCase();
      if (normalized in namedEntities) {
        return namedEntities[normalized];
      }

      const numeric = normalized.startsWith('#x')
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      const isScalarValue = Number.isInteger(numeric) &&
        numeric >= 0 &&
        numeric <= 0x10ffff &&
        (numeric < 0xd800 || numeric > 0xdfff);
      return isScalarValue ? String.fromCodePoint(numeric) : entity;
    },
  );
}

/** Remove HTML markup and decode the rendered text it contains. */
function extractText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ''));
}

/** Extract the text of the first `<h1>` — the title every guide carries as `# …`. */
export function extractTitle(html: string): string | undefined {
  const match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (!match) {
    return undefined;
  }
  const text = extractText(match[1]).trim();
  return text === '' ? undefined : text;
}

/** Extract a meta description: the first paragraph's plain text, clipped to 160 chars. */
export function extractDescription(html: string): string | undefined {
  const match = /<p>([\s\S]*?)<\/p>/i.exec(html);
  if (!match) {
    return undefined;
  }
  const text = extractText(match[1]).replace(/\s+/g, ' ').trim();
  if (text === '') {
    return undefined;
  }
  // The ellipsis counts toward the 160-char budget so the attribute length is exact.
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}

/** A navigable heading from a rendered documentation page. */
export interface TableOfContentsItem {
  id: string;
  level: 2 | 3;
  title: string;
}

/**
 * Extract the section headings that form the in-page navigation. Markdown headings
 * receive stable IDs from Astro's renderer, so no alternate slugging algorithm is
 * introduced here.
 */
export function extractTableOfContents(html: string): TableOfContentsItem[] {
  const items: TableOfContentsItem[] = [];
  const headingPattern = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;

  for (const match of html.matchAll(headingPattern)) {
    const id = /\bid="([^"]+)"/i.exec(match[2])?.[1];
    const title = extractText(match[3]).replace(/\s+/g, ' ').trim();
    if (!id || title === '') {
      continue;
    }
    items.push({ id, level: Number(match[1]) as 2 | 3, title });
  }

  return items;
}

/**
 * Join `rel` onto the rooted `base` and POSIX-normalize the result (collapsing `.`
 * and `..` segments), always returning a path with a leading slash. Overshooting the
 * root (`..` past the top) clamps at the root.
 */
function normalizeJoined(base: string, rel: string): string {
  const segments = `${base}/${rel}`.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
}
