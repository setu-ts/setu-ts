// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Isolation boundary (see README.md in this directory):
// - `publicDir` points at the repository's single brand-asset source (../assets), so the
//   logos and favicon are copied verbatim into the build output without a second copy of
//   the files living in the repo.
// - Docs content is read IN PLACE from ../docs via the glob loader in
//   src/content.config.ts — the site never duplicates or mutates the canonical tree.
// - `site` is the intended production origin (open decision in .tmp/website-discovery.md;
//   setu-ts.dev already appears in shipped RFC 9457 problem-type URIs).
export default defineConfig({
  site: 'https://setu-ts.dev',
  publicDir: '../assets',
  integrations: [sitemap()],
});
