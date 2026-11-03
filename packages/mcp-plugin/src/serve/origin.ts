/** Origin validation before parsing or SDK entry. @module */

/** Accepts non-browser clients and explicitly listed origins; Host supplies no trust. */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
  return origin === null || allowed.includes(origin);
}
