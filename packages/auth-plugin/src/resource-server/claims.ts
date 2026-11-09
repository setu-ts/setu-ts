/**
 * Claim parsing for the resource-server surface: OAuth scopes and the RFC 8693
 * `act` (actor) claim. Internal: the strategies and `requireScopes` consume it,
 * and it is not exported from the package barrel.
 *
 * @module
 */

import type { IPrincipalActor } from '@setu-ts/common';

/**
 * The RFC 6749 §3.3 `scope-token` grammar:
 * `1*( %x21 / %x23-5B / %x5D-7E )` — one or more printable ASCII characters
 * excluding space, `"` and `\`.
 *
 * @param value - Candidate scope token
 * @returns `true` when the value is exactly one scope-token
 */
export function isScopeToken(value: string): boolean {
  return /^[\u0021\u0023-\u005b\u005d-\u007e]+$/.test(value);
}

/** Splits a space-delimited scope string, dropping empty entries. */
function splitScopeString(value: string): readonly string[] {
  return value.split(' ').filter((scope) => scope.length > 0);
}

/** Removes duplicates while keeping the first occurrence's position. */
function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

/**
 * Reads OAuth 2.0 scopes from verified claims.
 *
 * `scope` wins when present: it alone is read, as a space-delimited string
 * (RFC 9068 §2.2.3), and `scp` is ignored. Otherwise `scp` is read as a string
 * split the same way, or as an array of strings. A present but malformed claim
 * yields `[]`: a non-string `scope`, or an `scp` that is neither a string nor an
 * all-string array, grants no scopes and keeps the token confined. `undefined`
 * is reserved for claims with neither a `scope` key nor an `scp` key. No partial
 * list is returned for a malformed array.
 *
 * @param claims - Verified token claims
 * @returns The scopes, deduplicated and in claim order; `[]` for a present but
 *   malformed claim, or `undefined` only when both scope claims are absent
 */
export function parseScopeClaim(
  claims: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  if ('scope' in claims) {
    const scope = claims.scope;
    return typeof scope === 'string' ? unique(splitScopeString(scope)) : [];
  }
  if (!('scp' in claims)) {
    return undefined;
  }
  const scp = claims.scp;
  if (typeof scp === 'string') {
    return unique(splitScopeString(scp));
  }
  if (Array.isArray(scp) && scp.every((entry): entry is string => typeof entry === 'string')) {
    return unique(scp);
  }
  return [];
}

/** The `act` parse outcome: absent, malformed, or a usable actor. */
export type ActClaimOutcome =
  { readonly ok: true; readonly actor: IPrincipalActor | undefined } | { readonly ok: false };

/** The malformed/absent outcome, shared and frozen. */
const NO_ACTOR: ActClaimOutcome = Object.freeze({ ok: true, actor: undefined });
const MALFORMED_ACT: ActClaimOutcome = Object.freeze({ ok: false });

/**
 * Reads the CURRENT actor from the outermost RFC 8693 `act` claim.
 *
 * The actor's id is the claim's non-empty `sub`, falling back to a non-empty
 * `client_id`. Its `claims` are the claim's own members except `act`, so a
 * nested `act` is never read and never exposed (RFC 8693 §4.1). A present but
 * malformed `act` is a refusal, not an absence: a token whose delegation cannot
 * be identified must not pass as a direct user token.
 *
 * @param claims - Verified token claims
 * @returns The actor outcome: `ok: true` with an actor, `ok: true` without one
 *   when `act` is absent, or `ok: false` when `act` is malformed
 */
export function parseActClaim(claims: Readonly<Record<string, unknown>>): ActClaimOutcome {
  if (!('act' in claims) || claims.act === undefined) {
    return NO_ACTOR;
  }
  const act = claims.act;
  if (typeof act !== 'object' || act === null || Array.isArray(act)) {
    return MALFORMED_ACT;
  }
  const record = act as Readonly<Record<string, unknown>>;
  const subject = record.sub;
  const clientId = record.client_id;
  const id =
    typeof subject === 'string' && subject.length > 0
      ? subject
      : typeof clientId === 'string' && clientId.length > 0
        ? clientId
        : undefined;
  if (id === undefined) {
    return MALFORMED_ACT;
  }
  const { act: _nested, ...actorClaims } = record;
  return { ok: true, actor: { id, claims: actorClaims } };
}
