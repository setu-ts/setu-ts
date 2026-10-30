/**
 * Resolves canonical repository links against each source file's directory.
 * Rendered reading stays on the site; unrendered source retains its GitHub target.
 */

/** The public repository used for source links. */
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

/** Stable anchor for a file displayed on an example page. */
export function fileAnchor(path: string): string {
  return `file-${path
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/-$/, '')
    .toLowerCase()}`;
}

/** Rewrites repository links relative to the source files directory. */
export function rewriteHref(
  href: string,
  sourceDirectory: string,
  exampleFiles: Readonly<Record<string, readonly string[]>> = {},
): string {
  let target = href;
  const github = /^https:\/\/github\.com\/setu-ts\/setu-ts\/(?:blob|tree)\/main\/(.*)$/.exec(href);
  if (github) target = github[1];
  else if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href;
  const { path, anchor } = stripAnchor(target);
  if (path === '') return href;
  const joined = normalizeJoined(github ? '' : sourceDirectory, path);
  if (joined === '/README.md') return withAnchor('/', anchor);
  if (joined === '/apps' || joined === '/apps/README.md')
    return withAnchor('/docs/examples/', anchor);
  const rootRoutes: Readonly<Record<string, string>> = {
    '/CHANGELOG.md': '/changelog/',
    '/ARCHITECTURE.md': '/architecture/',
    '/PUBLIC_API.md': '/public-api/',
  };
  if (Object.hasOwn(rootRoutes, joined)) return withAnchor(rootRoutes[joined], anchor);
  if (joined === '/docs/api' || joined.startsWith('/docs/api/'))
    return withAnchor(joined.slice(5) + (path.endsWith('/') ? '/' : ''), anchor);
  if (/^\/docs\/[^/]+\.mdx?$/.test(joined)) return withAnchor(resolvedMdToRoute(joined), anchor);
  if (joined === '/packages' || joined === '/packages/starters') return '/packages/';
  const pkg = /^\/packages\/(?:starters\/)?([^/]+)(?:\/(README\.md|AGENT_CARD\.md))?$/.exec(joined);
  if (pkg)
    return withAnchor(
      `/packages/${pkg[1]}/${pkg[2] === 'AGENT_CARD.md' ? 'agent-card/' : ''}`,
      anchor,
    );
  const app = /^\/apps\/([^/]+)(?:\/(.*))?$/.exec(joined);
  if (app) {
    if (!app[2] || app[2] === 'README.md') return withAnchor(`/examples/${app[1]}/`, anchor);
    const shown = exampleFiles[app[1]]?.find(
      (file) => file === app[2] || file.startsWith(`${app[2]}/`),
    );
    if (shown) return `/examples/${app[1]}/#${fileAnchor(shown)}`;
  }
  return /\.[a-z0-9]+$/i.test(joined)
    ? githubBlob(joined, anchor)
    : withAnchor(githubTree(joined), anchor);
}

/** Maps a resolved guide Markdown path to its site route. */
export function resolvedMdToRoute(resolved: string): string {
  if (/^\/docs\/README(?:\.md)?$/i.test(resolved)) return '/docs/';
  if (resolved.startsWith('/docs/')) return `/docs/${resolved.slice(6).replace(/\.mdx?$/, '')}/`;
  if (resolved === '/README.md') return '/';
  const roots: Readonly<Record<string, string>> = {
    '/ARCHITECTURE.md': '/architecture/',
    '/PUBLIC_API.md': '/public-api/',
    '/CHANGELOG.md': '/changelog/',
  };
  return roots[resolved] ?? resolved;
}

/** Rewrites rendered Markdown without changing its canonical source. */
export function rewriteDocsHtml(
  html: string,
  sourceDirectory: string,
  exampleFiles: Readonly<Record<string, readonly string[]>> = {},
): string {
  return html.replace(
    /(<(?:a|link|area)\b[^>]*\shref=)(["'])(.*?)\2/gi,
    (match, before: string, quote: string, href: string) => {
      const rewritten = rewriteHref(href, sourceDirectory, exampleFiles);
      return rewritten === href ? match : `${before}${quote}${rewritten}${quote}`;
    },
  );
}

/**
 * Sends an in-page `#fragment` link to `route` when the page has no element with that id.
 * A page assembled from part of a document (a package page's slice of PUBLIC_API.md) keeps
 * links to sections it does not include; those sections live on the full document's route.
 */
export function retargetMissingFragments(html: string, route: string): string {
  const ids = new Set([...html.matchAll(/\sid=(["'])(.*?)\1/g)].map((match) => match[2]));
  return html.replace(
    /(<a\b[^>]*\shref=)(["'])#(.*?)\2/gi,
    (match, before: string, quote: string, fragment: string) =>
      ids.has(decodeURIComponent(fragment))
        ? match
        : `${before}${quote}${route}#${fragment}${quote}`,
  );
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

  return html.replace(/&(#x[0-9a-f]+|#\d+|amp|apos|gt|lt|quot);/gi, (entity, name: string) => {
    const normalized = name.toLowerCase();
    if (normalized in namedEntities) {
      return namedEntities[normalized];
    }

    const numeric = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    const isScalarValue =
      Number.isInteger(numeric) &&
      numeric >= 0 &&
      numeric <= 0x10ffff &&
      (numeric < 0xd800 || numeric > 0xdfff);
    return isScalarValue ? String.fromCodePoint(numeric) : entity;
  });
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
