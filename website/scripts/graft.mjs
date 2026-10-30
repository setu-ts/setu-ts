/**
 * Post-build graft step for the Setu-TS website.
 *
 * The Astro build produces static pages in dist/. This step grafts in the two
 * non-page content streams so the final output is fully self-contained:
 *
 * 1. `docs/api/` → `dist/api/` — the generated API reference. `docs/api/` is
 *    GENERATED, not committed (git-ignored; produced by `pnpm run docs:api`, i.e.
 *    TypeDoc HTML over the published package export targets). This script never
 *    generates anything itself: it requires a freshly generated `docs/api/` to exist,
 *    so the shipped site can never carry API docs older than the tree being built.
 *    The website build regenerates it immediately before the Astro build.
 *
 * 2. `dist/robots.txt` — points crawlers at the sitemap Astro emits.
 *
 * Brand assets (logos, favicon) are handled by astro.config.mjs's publicDir pointing
 * at ../assets, so this script only verifies they made it into the output.
 */
/* eslint-disable no-console -- a build step reports its result and its refusals on the console. */
import { access, cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rewriteHref } from '../src/lib/docs-links.ts';
import { EXAMPLE_FILES } from '../src/lib/repository.ts';

const websiteRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(websiteRoot);
const dist = path.join(websiteRoot, 'dist');
const generatedApiDocs = path.join(repoRoot, 'docs', 'api');
const apiTarget = path.join(dist, 'api');
const apiHeaderStyles = `<style id="setu-api-header-styles">
  .tsd-page-toolbar .title {
    align-items: center;
    display: inline-flex;
    flex-shrink: 0;
    gap: 0.45rem;
    white-space: nowrap;
  }

  .tsd-page-toolbar .title img {
    display: block;
    height: 1.35rem;
    width: 1.35rem;
  }

  @media (max-width: 30rem) {
    .tsd-page-toolbar .title {
      font-size: 0.85rem;
    }
  }
</style>`;

/**
 * Checks whether a file-system path is available without surfacing a missing-path error.
 *
 * @param {string} target - Absolute path to probe.
 * @returns {Promise<boolean>} Whether the path exists and can be accessed.
 */
async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gives generated API HTML the two pieces of site integration it cannot receive
 * from Astro: a real home link and an explicit Pagefind content boundary.
 */
async function integrateApiHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await integrateApiHtml(target);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;

    const source = await readFile(target, 'utf8');
    const withBrandHeader = source.replace(
      /<a href="[^"]*" class="title">Setu-TS<\/a>/,
      '<a href="/" class="title"><img src="/setu-ts-favicon-64.png" alt="" width="22" height="22"><span>Setu-TS</span></a>',
    );
    if (withBrandHeader === source) {
      throw new Error(`graft: API page ${target} has no expected TypeDoc title link.`);
    }
    const withContentBoundary = withBrandHeader.replace(
      '<div class="col-content">',
      '<div class="col-content" data-pagefind-body>',
    );

    if (withContentBoundary === withBrandHeader) {
      throw new Error(`graft: API page ${target} has no expected content container.`);
    }
    const integrated = withContentBoundary.replace('</head>', `${apiHeaderStyles}</head>`);
    if (integrated === withContentBoundary) {
      throw new Error(`graft: API page ${target} has no closing head tag.`);
    }
    await writeFile(
      target,
      integrated.replace(
        /(<(?:a|link|area)\b[^>]*\shref=")(https:\/\/github\.com\/setu-ts\/setu-ts\/[^"]*)(")/gi,
        (_match, before, href, after) => `${before}${rewriteHref(href, '', EXAMPLE_FILES)}${after}`,
      ),
    );
  }
}

if (!(await exists(path.join(dist, 'index.html')))) {
  console.error('graft: dist/index.html not found — run the Astro build first (pnpm run build).');
  process.exit(1);
}

if (!(await exists(path.join(generatedApiDocs, 'index.html')))) {
  console.error(
    'graft: docs/api/index.html not found. The API reference is generated, not committed.\n' +
      'Regenerate it from HEAD before building the site:\n' +
      '  pnpm run docs:api        (from the repository root)\n' +
      'CI does this automatically immediately before the site build.',
  );
  process.exit(1);
}

// A stale graft must never survive: remove + copy rather than merge. cp with force:true
// overwrites file contents but would keep files that no longer exist in the source.
await rm(apiTarget, { recursive: true, force: true });
await cp(generatedApiDocs, apiTarget, {
  recursive: true,
  force: true,
});
await integrateApiHtml(apiTarget);

const site = 'https://setu-ts.dev';
await writeFile(
  path.join(dist, 'robots.txt'),
  `User-agent: *\nAllow: /\n\nSitemap: ${site}/sitemap-index.xml\n`,
);

for (const asset of [
  'setu-ts-logo-light-680.webp',
  'setu-ts-logo-dark-680.webp',
  'setu-ts-favicon-64.png',
]) {
  if (!(await exists(path.join(dist, asset)))) {
    console.error(
      `graft: brand asset ${asset} is missing from dist/ — publicDir must point at ../assets.`,
    );
    process.exit(1);
  }
}

console.log(
  'graft: /api/ grafted and site-integrated from freshly generated docs/api/, robots.txt written, brand assets verified.',
);
