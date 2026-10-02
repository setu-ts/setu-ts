/**
 * The decidable half of the publication hold: which listed holds apply to a
 * release, and the message that refuses it. `scripts/publish-packages.ts`
 * refuses with it; `scripts/verify-release.ts` reports with it.
 *
 * @module
 */
import type { PublicationHold } from './release-packages.ts';

/**
 * The holds that block a release of `published`, in listed order. A hold
 * naming a package outside the release cannot block it.
 *
 * @param holds - The listed holds
 * @param published - The packages the release would publish
 * @returns The holds that apply
 */
export function activeHolds(
  holds: readonly PublicationHold[],
  published: readonly string[],
): readonly PublicationHold[] {
  const release = new Set(published);
  return holds.filter((hold) => release.has(hold.packageDir));
}

/**
 * The refusal a publish prints when any hold applies, or `null` when none
 * does. Every hold blocks the WHOLE release, not only its own package.
 *
 * @param holds - The listed holds
 * @param published - The packages the release would publish
 * @returns The refusal text, or `null` when the release may proceed
 */
export function publicationHoldRefusal(
  holds: readonly PublicationHold[],
  published: readonly string[],
): string | null {
  const active = activeHolds(holds, published);
  if (active.length === 0) return null;
  const lines = active.map((hold) => `  - ${hold.packageDir}: ${hold.reason}`);
  return [
    `Refusing to publish: ${active.length} package(s) are on publication hold, ` +
    'which blocks the whole release.',
    ...lines,
    'Lift a hold by finishing the work it names, or remove it on purpose from ' +
    'PUBLICATION_HOLDS in scripts/release-packages.ts.',
  ].join('\n');
}
