# @setu-ts/localization-plugin — message catalogues and request locales

`setu add localization` adds the dependency and prints the registration line; add
`LocalizationPlugin(...)` to the `plugins` array in `setu.config.ts`. It registers
`CAPABILITIES.LOCALIZATION`, validates every catalogue at registration, and resolves
`ctx.request.locale` in middleware at priority 45.

```ts
import { LocalizationPlugin } from '@setu-ts/localization-plugin';

export const localization = LocalizationPlugin({
  supportedLocales: ['en', 'de'],
  catalogues: {
    en: { greeting: 'Hello {name}', items: { one: '{count} item', other: '{count} items' } },
    de: { greeting: 'Hallo {name}', items: { one: '{count} Artikel', other: '{count} Artikel' } },
  },
  timeZone: 'Europe/Berlin',
});
```

```ts
import type { IRequestContext } from '@setu-ts/common';
import { localizerFor } from '@setu-ts/localization-plugin';

export function hello(context: IRequestContext): string {
  const { t, locale } = localizerFor(context);
  return `${locale}: ${t('greeting', { name: context.params.name })}`;
}
```

- `supportedLocales` is required; the first tag is the default. Give exactly one of `catalogues` and
  `source` (an `IMessageSource` loaded once, at registration).
- A plural message is keyed by CLDR category and needs a numeric `count`; a form the message lacks
  falls back to `other`. `{name}` placeholders are substituted, never escaped.
- Resolution order: the `locale` query parameter, the `setu_locale` cookie, Accept-Language, a
  configured `tenantLocale`, then the default. `middleware.query: false` drops the first source and
  `middleware.cookie: false` the second.
- `onMissing` defaults to `'key'`: an unknown key answers itself and warns once. Set `'throw'` to
  raise `MissingMessageError` — useful in tests and CI.
- `allowPartialCatalogues: true` accepts a locale missing the default's keys. `replaceLocale` is the
  deliberate way to change `ctx.request.locale` after the middleware.
- `exposeCatalogues: { basePath: '/i18n' }` serves `GET <basePath>/:locale`; browser code imports
  the same formatter from `@setu-ts/localization-plugin/format`.
