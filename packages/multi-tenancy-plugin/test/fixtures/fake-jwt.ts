/**
 * Fake decode function for JwtResolver tests.
 */
export function createFakeJwtDecode(
  payload?: Record<string, unknown> | null,
): (token: string) => Record<string, unknown> | null {
  return (_token: string) => payload ?? null;
}
