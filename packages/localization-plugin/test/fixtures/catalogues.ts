/**
 * Shared catalogue fixtures.
 *
 * @module
 */
import type { MessageCatalogue } from '@setu-ts/common';

/** English, the default in most fixtures. */
export const EN: MessageCatalogue = {
  greeting: 'Hello {name}',
  items: { one: '{count} item', other: '{count} items' },
  title: 'Cart',
};

/** German, complete. */
export const DE: MessageCatalogue = {
  greeting: 'Hallo {name}',
  items: { one: '{count} Artikel', other: '{count} Artikel' },
  title: 'Warenkorb',
};

/** French, complete. */
export const FR: MessageCatalogue = {
  greeting: 'Bonjour {name}',
  items: { one: '{count} article', other: '{count} articles' },
  title: 'Panier',
};

/** The three, keyed by tag. */
export const CATALOGUES: Readonly<Record<string, MessageCatalogue>> = { en: EN, de: DE, fr: FR };
