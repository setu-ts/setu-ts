/**
 * Information architecture for the docs section, one entry per rendered guide.
 *
 * Slugs are the `docs/<name>.md` file names (the glob loader's ids). Display titles are
 * fixed here so the sidebar is stable even where a guide's H1 is long; the page itself
 * still renders the guide's own H1 from the canonical file.
 */

export interface DocsNavItem {
  slug: string;
  label: string;
}

export interface DocsNavGroup {
  label: string;
  items: DocsNavItem[];
}

export const DOCS_NAV: DocsNavGroup[] = [
  {
    label: 'Getting started',
    items: [{ slug: 'getting-started', label: 'Installation & first app' }],
  },
  {
    label: 'Core concepts',
    items: [
      { slug: 'plugin-architecture', label: 'Plugin architecture' },
      { slug: 'programmatic-api', label: 'Programmatic API' },
      { slug: 'decorators', label: 'Decorators' },
      { slug: 'mvc', label: 'MVC pattern' },
    ],
  },
  {
    label: 'Tooling',
    items: [{ slug: 'cli', label: 'CLI — setu' }],
  },
  {
    label: 'Plugin reference',
    items: [
      { slug: 'plugins', label: 'Plugin catalog' },
      { slug: 'custom-plugins', label: 'Custom plugins' },
      { slug: 'health-indicators', label: 'Health indicators' },
    ],
  },
  {
    label: 'Migrating',
    items: [
      { slug: 'migration-nestjs', label: 'From NestJS' },
      { slug: 'migration-fastify', label: 'From Fastify' },
      { slug: 'upgrading', label: 'Upgrading Setu-TS' },
    ],
  },
  {
    label: 'Examples',
    items: [{ slug: 'examples', label: 'Runnable examples' }],
  },
  {
    label: 'Deploying',
    items: [
      { slug: 'runtime-deployment', label: 'Runtime deployment' },
      { slug: 'deployment', label: 'Docker & Kubernetes' },
      { slug: 'telemetry-collector-fanout', label: 'Telemetry fan-out' },
      { slug: 'messaging-emulators', label: 'Messaging emulators' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { slug: 'releasing', label: 'Release runbook' },
      { slug: 'code-review-audit', label: 'Code review audit' },
      { slug: 'react-router-dev', label: 'React Router dev' },
    ],
  },
];

/** Docs that must exist for the nav to be honest — validated by the docs page. */
export const NAV_SLUGS: ReadonlySet<string> = new Set(
  DOCS_NAV.flatMap((group) => group.items.map((item) => item.slug)),
);
