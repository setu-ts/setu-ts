import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { PUBLISHED_PACKAGES } from '../../scripts/release-packages.ts';

/**
 * The canonical documentation, rendered IN PLACE.
 *
 * The loader reads `../docs/*.md` directly — no copying step, no second content tree —
 * so every build renders the canonical files as they exist at build time and the
 * no-duplication rule holds mechanically. `docs/` must stay byte-identical after a
 * build (it is a read-only input here).
 *
 * The curated guides carry `# Heading` titles rather than YAML frontmatter, and the
 * website toolchain must not add frontmatter to tracked docs, so the schema keeps
 * everything optional and titles are derived from the first H1 at render time
 * (see src/lib/docs-links.ts).
 */
const docs = defineCollection({
  // `releasing.md` is the maintainers' release runbook — kept in the repository for
  // the release process, never published on the site.
  loader: glob({ pattern: ['*.md', '!releasing.md'], base: '../docs' }),
  schema: z.object({
    title: z.string().optional(),
  }),
});

const repository = defineCollection({
  loader: glob({
    base: '..',
    pattern: [
      ...PUBLISHED_PACKAGES.flatMap((directory) => [
        `${directory}/README.md`,
        `${directory}/AGENT_CARD.md`,
      ]),
      'apps/*/README.md',
      'CHANGELOG.md',
      'ARCHITECTURE.md',
      'PUBLIC_API.md',
    ],
    generateId: ({ entry }) => entry,
  }),
  schema: z.object({ title: z.string().optional() }),
});

export const collections = { docs, repository };
