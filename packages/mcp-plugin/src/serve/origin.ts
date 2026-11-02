/** Origin validation before parsing or SDK entry. @module */

/** Accepts non-browser clients, the endpoint's own origin and explicitly listed origins. */
export function originAllowed(
  url: string,
  origin: string | null,
  allowed: readonly string[],
): boolean {
  return origin === null || origin === new URL(url).origin || allowed.includes(origin);
}
