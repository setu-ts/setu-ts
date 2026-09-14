import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

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
  loader: glob({ pattern: '*.md', base: '../docs' }),
  schema: z.object({
    title: z.string().optional(),
  }),
});

export const collections = { docs };
