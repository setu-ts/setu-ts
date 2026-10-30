/**
 * Which top-bar entry a page belongs to, so the header can mark where the reader is.
 *
 * The examples guide lives under `/docs/` but belongs to Examples, so it is checked
 * before the general docs prefix.
 */

export type SiteSection = 'docs' | 'api' | 'examples';

/** Docs-like pages outside `/docs/`: package pages and the rendered repository references. */
const DOCS_PREFIXES = ['/docs', '/packages', '/architecture', '/public-api', '/changelog'];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function siteSection(pathname: string): SiteSection | undefined {
  if (under(pathname, '/docs/examples') || under(pathname, '/examples')) return 'examples';
  if (under(pathname, '/api')) return 'api';
  if (DOCS_PREFIXES.some((prefix) => under(pathname, prefix))) return 'docs';
  return undefined;
}
