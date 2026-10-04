/**
 * Locale negotiation — `Accept-Language` parsing and matching a client's
 * preferences against the application's supported set.
 *
 * Pure and import-free, so the server middleware and a browser (over
 * `navigator.languages`) negotiate with the same rules. Every candidate is
 * matched against the SUPPORTED set only: client text never selects a locale
 * the application did not configure, and a malformed tag is "no match", never
 * a thrown error.
 *
 * @module
 * @since 0.9.0
 */
import type { AcceptLanguage } from './types.ts';

/**
 * The header is sliced to this many characters BEFORE it is split, so an
 * oversized header costs one slice rather than one parse per range — a bound
 * applied after the split would already have paid the cost it exists to
 * prevent.
 */
const MAX_HEADER_LENGTH = 1024;

/** At most this many ranges are considered; any real browser sends fewer. */
const MAX_RANGES = 16;

/** BCP 47's practical maximum for a well-formed tag; longer ranges are dropped. */
const MAX_RANGE_LENGTH = 35;

/** RFC 9110 §12.4.2 qvalue: `0`–`1` with at most three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/** An empty parse, shared so a missing header allocates nothing. */
const EMPTY: AcceptLanguage = Object.freeze({
  preferred: Object.freeze([]),
  excluded: Object.freeze([]),
});

/**
 * Reads one range's `q` parameter. A missing or malformed value counts as
 * `1`: a client that wrote an unparseable weight still sent the range.
 */
function qualityOf(params: readonly string[]): number {
  for (const raw of params) {
    const param = raw.trim();
    if (param.length > 2 && (param[0] === 'q' || param[0] === 'Q') && param[1] === '=') {
      const value = param.slice(2);
      return QVALUE.test(value) ? Number(value) : 1;
    }
  }
  return 1;
}

/**
 * Parses an `Accept-Language` header under a bound.
 *
 * The value is sliced to 1024 characters before splitting, at most 16 ranges
 * are read, and a range longer than 35 characters is dropped. Ranges with
 * `q=0` are returned in `excluded`; the rest in `preferred`, ordered by `q`
 * descending and stable on ties.
 *
 * @param value - The raw header value (`null` or empty when absent)
 * @returns The ordered preferences and the explicit exclusions
 * @example
 * ```typescript
 * parseAcceptLanguage('fr;q=0.5, de, en;q=0');
 * // { preferred: ['de', 'fr'], excluded: ['en'] }
 * ```
 * @since 0.9.0
 */
export function parseAcceptLanguage(value: string | null | undefined): AcceptLanguage {
  if (value === null || value === undefined || value.length === 0) {
    return EMPTY;
  }
  const parts = value.slice(0, MAX_HEADER_LENGTH).split(',', MAX_RANGES);
  const ranked: { readonly tag: string; readonly q: number }[] = [];
  const excluded: string[] = [];
  for (const part of parts) {
    const segments = part.split(';');
    // `split` always yields at least one element, so `segments[0]` is a string.
    const tag = segments[0].trim();
    if (tag.length === 0 || tag.length > MAX_RANGE_LENGTH) {
      continue;
    }
    const q = qualityOf(segments.slice(1));
    if (q === 0) {
      excluded.push(tag);
    } else {
      ranked.push({ tag, q });
    }
  }
  // Array.prototype.sort is stable, so equal weights keep header order.
  ranked.sort((a, b) => b.q - a.q);
  return { preferred: ranked.map((entry) => entry.tag), excluded };
}

/**
 * Canonicalizes a tag, answering `undefined` instead of throwing.
 *
 * `Intl.getCanonicalLocales` throws `RangeError` on a malformed tag (`en_US`,
 * an empty string, an over-long subtag), and the input is client-controlled,
 * so the throw is caught here and means "no match".
 */
function canonical(tag: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/**
 * The canonical form of each supported tag, computed once per supported
 * array. The middleware hands the same array on every request, so this is
 * registration-time work after the first call.
 */
const canonicalSupported = new WeakMap<readonly string[], readonly (string | undefined)[]>();

function canonicalOf(supported: readonly string[]): readonly (string | undefined)[] {
  let entry = canonicalSupported.get(supported);
  if (entry === undefined) {
    entry = supported.map(canonical);
    canonicalSupported.set(supported, entry);
  }
  return entry;
}

/** Whether an excluded range covers a supported tag — exactly or as a prefix. */
function excludes(range: string, tag: string): boolean {
  if (range === '*') {
    return true;
  }
  const r = range.toLowerCase();
  const t = tag.toLowerCase();
  return t === r || t.startsWith(`${r}-`);
}

/**
 * Picks the first supported locale a client's candidates select.
 *
 * Each candidate is canonicalized (a malformed one is skipped), matched
 * exactly, then with subtags stripped right-to-left (`de-Latn-AT` →
 * `de-Latn` → `de`). `Intl.Locale.minimize` is deliberately not used: it
 * leaves `de-AT` as `de-AT`. A `*` candidate selects the first supported
 * locale that no `excluded` range covers; exclusion applies to `*` only.
 *
 * @param candidates - Client preferences, highest first
 * @param supported - The application's supported tags, default first
 * @param excluded - Ranges the client marked `q=0`
 * @returns The matched supported tag, or `undefined` when nothing matched
 * @example
 * ```typescript
 * negotiateLocale(['de-AT', 'en'], ['en', 'de']); // 'de'
 * negotiateLocale(['*'], ['en', 'fr'], ['en']);   // 'fr'
 * ```
 * @since 0.9.0
 */
export function negotiateLocale(
  candidates: readonly string[],
  supported: readonly string[],
  excluded: readonly string[] = [],
): string | undefined {
  const canonicalTags = canonicalOf(supported);
  for (const candidate of candidates) {
    if (candidate === '*') {
      const index = supported.findIndex((tag) => !excluded.some((range) => excludes(range, tag)));
      if (index >= 0) {
        return supported[index];
      }
      continue;
    }
    let tag = canonical(candidate);
    while (tag !== undefined && tag.length > 0) {
      const index = canonicalTags.indexOf(tag);
      if (index >= 0) {
        return supported[index];
      }
      const cut = tag.lastIndexOf('-');
      tag = cut > 0 ? tag.slice(0, cut) : undefined;
    }
  }
  return undefined;
}
