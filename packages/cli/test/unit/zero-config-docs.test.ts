/**
 * The documented list of zero-configuration `setu add` providers is the wiring map's
 * own list. Three documents state it; each is read here and compared with
 * `ZERO_CONFIG_WIRINGS`, so a provider added to the map fails this test until every
 * copy names it (the count had drifted to 12 and 20 while the map held 21).
 *
 * @module
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ZERO_CONFIG_WIRINGS } from '../../src/utils/plugin-wirings.ts';

const DOCUMENTS = ['docs/cli.md', 'packages/cli/README.md', 'PUBLIC_API.md'] as const;

/** The map's packages as the documents spell them: without the `-plugin` suffix. */
const EXPECTED = [...ZERO_CONFIG_WIRINGS.keys()].map((pkg) => pkg.replace(/-plugin$/, '')).sort();

/** Every run of at least ten comma-separated kebab-case names (an `and` may end it), sorted. */
function nameLists(text: string): string[][] {
  const flat = text.replace(/\s+/g, ' ');
  return [...flat.matchAll(/(?:[a-z][a-z-]*, ){9,}[a-z][a-z-]*(?:,? and [a-z][a-z-]*)?/g)].map(
    (match) =>
      match[0]
        .split(/,? and |, /)
        .map((name) => name.trim())
        .sort(),
  );
}

describe('zero-configuration provider list in the docs', () => {
  it.each(DOCUMENTS)('%s names exactly the wiring map’s providers', async (document) => {
    const text = await readFile(new URL(`../../../../${document}`, import.meta.url), 'utf8');
    const lists = nameLists(text).filter((list) => list.includes('worker-pool'));
    expect(lists, `${document} has no zero-configuration list`).toHaveLength(1);
    expect(lists[0]).toEqual(EXPECTED);
  });
  it.each(['packages/cli/README.md', 'PUBLIC_API.md'])(
    '%s states the wiring map’s count',
    async (document) => {
      const text = await readFile(new URL(`../../../../${document}`, import.meta.url), 'utf8');
      expect(text.replace(/\s+/g, ' ')).toContain(
        `${ZERO_CONFIG_WIRINGS.size} safe zero-configuration providers`,
      );
    },
  );
});
