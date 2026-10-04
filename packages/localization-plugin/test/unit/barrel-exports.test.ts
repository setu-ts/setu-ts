/**
 * Pins both published surfaces — the package root and the `/format` subpath.
 *
 * Every other test imports the concrete modules, so dropping a re-export would
 * leave them green, and a re-export file is covered merely by being loaded.
 * These assertions are declared AGAINST the barrels, so a missing type export
 * fails `deno check` and a missing value export fails here (the M56 class).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as root from '../../src/index.ts';
import type {
  IMessageSource,
  LocaleMiddlewareOptions,
  LocalizationPluginOptions,
} from '../../src/index.ts';
import * as subpath from '../../src/format/index.ts';
import type { AcceptLanguage, FormatOptions, FormatValues } from '../../src/format/index.ts';

// Compile-time pins for the type exports.
const source: IMessageSource = { load: () => Promise.resolve({}) };
const middlewareOptions: LocaleMiddlewareOptions = { supportedLocales: ['en'] };
const pluginOptions: LocalizationPluginOptions = { supportedLocales: ['en'], source };
const parsed: AcceptLanguage = { preferred: [], excluded: [] };
const formatOptions: FormatOptions = { timeZone: 'UTC' };
const values: FormatValues = { name: 'Ada' };
void middlewareOptions;
void pluginOptions;
void parsed;
void formatOptions;
void values;

describe('package root surface', () => {
  it('exports exactly the documented values', () => {
    expect(Object.keys(root).sort()).toEqual([
      'LocalizationPlugin',
      'MissingMessageError',
      'MissingPluralCountError',
      'UnsupportedLocaleError',
      'localeMiddleware',
      'localizerFor',
    ]);
  });
});

describe('/format subpath surface', () => {
  it('exports exactly three functions', () => {
    expect(Object.keys(subpath).sort()).toEqual([
      'format',
      'negotiateLocale',
      'parseAcceptLanguage',
    ]);
    expect(subpath.format('Hi {name}', values, 'en')).toBe('Hi Ada');
  });

  it('shares the formatter with the root: the error class is the same object', async () => {
    const { MissingPluralCountError } = await import('../../src/format/format.ts');
    expect(root.MissingPluralCountError).toBe(MissingPluralCountError);
  });
});
