/**
 * The localizer — message lookup over validated catalogues, bound per locale.
 *
 * One state object holds the catalogues, the missing-key bookkeeping and one
 * bound localizer per supported tag, so `forLocale` on the service and
 * `localizerFor(ctx)` on a request reach the same implementation and the same
 * cached instances.
 *
 * @module
 * @since 0.9.0
 */
import type { ILocalizer, ILogger, IRequestContext, LocalizationMessage } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import type { CatalogueStore } from '../catalogue/validate.ts';
import { MissingMessageError, UnsupportedLocaleError } from '../errors.ts';
import { format, MissingPluralCountError } from '../format/format.ts';
import { negotiateLocale } from '../format/negotiate.ts';
import type { FormatOptions, FormatValues } from '../format/types.ts';

/**
 * The warned-missing-key set holds at most this many keys, so a call site
 * passing caller text to `t()` cannot grow memory without bound.
 */
const WARNED_KEY_LIMIT = 256;

/** Longest key echoed into a log line. */
const KEY_ECHO_LIMIT = 64;

/** Shared empty values, so `t(key)` allocates nothing for them. */
const NO_VALUES: FormatValues = Object.freeze({});

/** What a localizer needs beyond the catalogues. */
export interface LocalizerConfig {
  /** The validated catalogues. */
  readonly store: CatalogueStore;
  /** `t()` on a key no catalogue defines: answer the key, or throw. */
  readonly onMissing: 'key' | 'throw';
  /** The zone `Date` values format in; `undefined` is the runtime's zone. */
  readonly timeZone: string | undefined;
  /** Read at CALL time, so a logger registered later is still used. */
  readonly logger: () => ILogger | undefined;
}

/** Shared state behind every bound localizer of one plugin instance. */
class LocalizerState {
  readonly #store: CatalogueStore;
  readonly #defaultTag: string;
  readonly #onMissing: 'key' | 'throw';
  readonly #formatOptions: FormatOptions;
  readonly #logger: () => ILogger | undefined;
  readonly #bound = new Map<string, ILocalizer>();
  readonly #warned = new Set<string>();
  #capReported = false;

  constructor(config: LocalizerConfig) {
    this.#store = config.store;
    this.#defaultTag = config.store.supported[0];
    this.#onMissing = config.onMissing;
    this.#formatOptions = config.timeZone === undefined ? {} : { timeZone: config.timeZone };
    this.#logger = config.logger;
  }

  /** Returns the cached localizer bound to a supported tag. */
  forLocale(tag: string): ILocalizer {
    let canonical: string | undefined;
    try {
      canonical = Intl.getCanonicalLocales(tag)[0];
    } catch {
      canonical = undefined;
    }
    if (canonical === undefined || !this.#store.supported.includes(canonical)) {
      throw new UnsupportedLocaleError(tag, this.#store.supported);
    }
    let bound = this.#bound.get(canonical);
    if (bound === undefined) {
      bound = this.#bind(canonical);
      this.#bound.set(canonical, bound);
    }
    return bound;
  }

  #bind(tag: string): ILocalizer {
    // Arrow functions, so `t` and `forLocale` keep working when destructured
    // (`const { t } = localizerFor(ctx)`).
    return Object.freeze({
      locale: tag,
      locales: this.#store.supported,
      t: (key: string, values?: FormatValues): string =>
        this.translate(tag, key, values ?? NO_VALUES),
      forLocale: (other: string): ILocalizer => this.forLocale(other),
    });
  }

  /** Looks a key up in `tag`, then in the default locale, and formats it. */
  translate(tag: string, key: string, values: FormatValues): string {
    const message: LocalizationMessage | undefined = this.#store.messages.get(tag)?.get(key) ??
      this.#store.messages.get(this.#defaultTag)?.get(key);
    if (message === undefined) {
      return this.#missing(tag, key);
    }
    try {
      return format(message, values, tag, this.#formatOptions);
    } catch (error) {
      if (error instanceof MissingPluralCountError) {
        // The formatter does not know the key; the localizer does.
        throw new MissingPluralCountError(key, { cause: error });
      }
      throw error;
    }
  }

  #missing(tag: string, key: string): string {
    if (this.#onMissing === 'throw') {
      throw new MissingMessageError(key, tag);
    }
    if (!this.#warned.has(key)) {
      if (this.#warned.size < WARNED_KEY_LIMIT) {
        this.#warned.add(key);
        this.#logger()?.warn('localization-plugin: no catalogue defines this message key', {
          key: key.length > KEY_ECHO_LIMIT ? `${key.slice(0, KEY_ECHO_LIMIT)}…` : key,
          locale: tag,
        });
      } else if (!this.#capReported) {
        this.#capReported = true;
        this.#logger()?.warn(
          `localization-plugin: ${WARNED_KEY_LIMIT} distinct missing message keys have been ` +
            'reported; further missing keys are answered without a warning.',
        );
      }
    }
    return key;
  }

  /** How many keys have been warned about. Internal — read by tests. */
  get warnedCount(): number {
    return this.#warned.size;
  }
}

/** The state behind each localizer this module created. */
const states = new WeakMap<ILocalizer, LocalizerState>();

/**
 * Creates the service registered under `CAPABILITIES.LOCALIZATION`, bound to
 * the default locale.
 *
 * @param config - The catalogues and lookup behaviour
 * @returns The default-locale localizer
 */
export function createLocalizer(config: LocalizerConfig): ILocalizer {
  const state = new LocalizerState(config);
  const service = state.forLocale(config.store.supported[0]);
  states.set(service, state);
  return service;
}

/**
 * How many missing keys a localizer created here has warned about. Internal —
 * the test pinning the warned-key bound reads it.
 *
 * @param localizer - A localizer returned by {@linkcode createLocalizer}
 * @returns The warned-key count, or `undefined` for a foreign localizer
 */
export function warnedKeyCount(localizer: ILocalizer): number | undefined {
  return states.get(localizer)?.warnedCount;
}

/**
 * Returns the localizer for a request's resolved locale.
 *
 * Resolves the service under `CAPABILITIES.LOCALIZATION` and binds it to
 * `ctx.request.locale`. A request with no locale (a path the middleware
 * excludes, or a reader running before priority 45) gets the default locale
 * rather than an error. A locale an application installed with
 * `replaceLocale` that is not itself supported is negotiated against the
 * supported set (`de-AT` → `de`), falling back to the default — a stored
 * preference never turns into a `500`.
 *
 * @param ctx - The request context
 * @returns A localizer bound to the request's locale
 * @throws {Error} If no provider of `CAPABILITIES.LOCALIZATION` is registered
 * @example
 * ```typescript
 * app.router.get('/', (ctx) => {
 *   const { t } = localizerFor(ctx);
 *   return ctx.response.text(t('greeting', { name: 'Ada' }));
 * });
 * ```
 * @since 0.9.0
 */
export function localizerFor(ctx: IRequestContext): ILocalizer {
  const service = ctx.services.get<ILocalizer>(CAPABILITIES.LOCALIZATION);
  const locale = ctx.request.locale;
  if (locale === undefined) {
    return service;
  }
  const matched = negotiateLocale([locale], service.locales);
  return matched === undefined ? service : service.forLocale(matched);
}
