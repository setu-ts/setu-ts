/**
 * Startup-time validation of the supported locales and the catalogues.
 *
 * Every refusal here fails `register()` (or construction) with a message that
 * names what is wrong, so a translation gap is a deployment-time fact rather
 * than something a request discovers.
 *
 * @module
 * @since 0.9.0
 */
import type { LocalizationMessage, MessageCatalogue, PluralForms } from '@setu-ts/common';

/** Prefix on every refusal, so the plugin is named in a startup failure. */
const PREFIX = 'localization-plugin:';

/** The CLDR plural categories a plural record may use. */
const PLURAL_CATEGORIES: ReadonlySet<string> = new Set([
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
]);

/** How many missing keys a refusal names. */
const MISSING_KEYS_NAMED = 10;

/** Validated catalogues: one message map per supported (canonical) tag. */
export interface CatalogueStore {
  /** The supported tags, canonical, default first. */
  readonly supported: readonly string[];
  /**
   * Messages per tag. A `Map`, never the caller's object, so a key such as
   * `constructor` or `__proto__` is an ordinary key and never reaches
   * `Object.prototype`.
   */
  readonly messages: ReadonlyMap<string, ReadonlyMap<string, LocalizationMessage>>;
}

/** Canonicalizes a configured tag, refusing one `Intl` cannot read. */
function canonicalConfiguredTag(tag: unknown): string {
  if (typeof tag !== 'string') {
    throw new TypeError(`${PREFIX} every supportedLocales entry must be a string.`);
  }
  let canonical: string | undefined;
  try {
    canonical = Intl.getCanonicalLocales(tag)[0];
  } catch {
    canonical = undefined;
  }
  if (canonical === undefined) {
    throw new RangeError(`${PREFIX} supportedLocales entry "${tag}" is not a valid BCP 47 tag.`);
  }
  // An unknown tag makes `Intl` silently fall back to the runtime default, so
  // every message would format in the server's own locale with no error.
  if (Intl.PluralRules.supportedLocalesOf([canonical]).length === 0) {
    throw new RangeError(
      `${PREFIX} supportedLocales entry "${tag}" has no locale data in this runtime's Intl ` +
        '(a thin ICU build can lack it), so its plurals and numbers would silently use the ' +
        "runtime's default locale.",
    );
  }
  return canonical;
}

/**
 * Validates and canonicalizes the supported locales.
 *
 * @param supported - The configured tags, default first
 * @returns The canonical tags, in configured order
 * @throws {TypeError | RangeError} If the list is empty, holds a non-string,
 *   a malformed tag, a tag the runtime's `Intl` lacks, or a duplicate
 */
export function validateSupportedLocales(supported: unknown): readonly string[] {
  if (!Array.isArray(supported) || supported.length === 0) {
    throw new TypeError(
      `${PREFIX} supportedLocales must be a non-empty array; its first entry is the default.`,
    );
  }
  const canonical = supported.map(canonicalConfiguredTag);
  const seen = new Set<string>();
  for (const tag of canonical) {
    if (seen.has(tag)) {
      throw new RangeError(`${PREFIX} supportedLocales lists "${tag}" twice.`);
    }
    seen.add(tag);
  }
  return Object.freeze(canonical);
}

/** Whether a value is a plain record (not null, not an array). */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates one message value, naming the key on refusal. */
function validateMessage(tag: string, key: string, value: unknown): LocalizationMessage {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    const categories = Object.keys(value);
    const valid = categories.every((category) =>
      PLURAL_CATEGORIES.has(category) && typeof value[category] === 'string'
    );
    if (valid && typeof value.other === 'string') {
      // Every own key is a category and every value a string, `other` among
      // them — so the record IS a `PluralForms`; the copy detaches it.
      const forms: PluralForms = {
        ...(value as Readonly<Record<string, string>>),
        other: value.other,
      };
      return Object.freeze(forms);
    }
  }
  throw new TypeError(
    `${PREFIX} message "${key}" in locale ${tag} must be a string or a plural record of ` +
      'strings keyed by zero/one/two/few/many/other, with "other" required.',
  );
}

/**
 * Validates every catalogue against the supported set.
 *
 * Refuses: a catalogue for an unsupported tag; a default locale with no
 * catalogue; a malformed message; and — unless `allowPartial` — a supported
 * locale missing keys the default locale defines. With `allowPartial` each
 * incomplete locale is warned once instead.
 *
 * @param supported - The canonical supported tags, default first
 * @param raw - The catalogues, keyed by tag
 * @param allowPartial - Accept incomplete non-default catalogues
 * @param warn - Receives one warning per incomplete locale
 * @returns The validated store
 */
export function validateCatalogues(
  supported: readonly string[],
  raw: unknown,
  allowPartial: boolean,
  warn: (message: string) => void,
): CatalogueStore {
  if (!isRecord(raw)) {
    throw new TypeError(`${PREFIX} catalogues must be an object keyed by locale tag.`);
  }
  const messages = new Map<string, Map<string, LocalizationMessage>>();
  for (const [rawTag, catalogue] of Object.entries(raw)) {
    let tag: string | undefined;
    try {
      tag = Intl.getCanonicalLocales(rawTag)[0];
    } catch {
      tag = undefined;
    }
    if (tag === undefined || !supported.includes(tag)) {
      throw new RangeError(
        `${PREFIX} a catalogue is supplied for "${rawTag}", which is not in supportedLocales.`,
      );
    }
    if (messages.has(tag)) {
      throw new RangeError(`${PREFIX} two catalogues canonicalize to "${tag}".`);
    }
    if (!isRecord(catalogue)) {
      throw new TypeError(`${PREFIX} the catalogue for ${tag} must be an object.`);
    }
    const entries = new Map<string, LocalizationMessage>();
    for (const [key, value] of Object.entries(catalogue as MessageCatalogue)) {
      entries.set(key, validateMessage(tag, key, value));
    }
    messages.set(tag, entries);
  }
  const defaultTag = supported[0];
  const defaults = messages.get(defaultTag);
  if (defaults === undefined) {
    throw new RangeError(`${PREFIX} the default locale ${defaultTag} has no catalogue.`);
  }
  for (const tag of supported.slice(1)) {
    const own = messages.get(tag);
    const missing = [...defaults.keys()].filter((key) => own?.has(key) !== true);
    if (missing.length === 0) {
      continue;
    }
    const named = missing.slice(0, MISSING_KEYS_NAMED).join(', ');
    const more = missing.length > MISSING_KEYS_NAMED
      ? ` and ${missing.length - MISSING_KEYS_NAMED} more`
      : '';
    const description = `locale ${tag} lacks ${missing.length} key(s) the default locale ` +
      `${defaultTag} defines: ${named}${more}`;
    if (!allowPartial) {
      throw new RangeError(
        `${PREFIX} ${description}. Add them, or set allowPartialCatalogues: true to serve ` +
          'the default locale for them.',
      );
    }
    warn(`${PREFIX} ${description}; the default locale's messages are served for them.`);
    if (own === undefined) {
      messages.set(tag, new Map());
    }
  }
  return { supported, messages };
}
