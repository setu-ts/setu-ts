# @setu-ts/localization-plugin — translate for the request locale

**Add it:** `setu add localization` adds it and prints the registration for `setu.config.ts`.
`LocalizationPlugin` provides `CAPABILITIES.LOCALIZATION` (`ILocalizer`).

## Configure the supported languages

Put this plugin in the config's plugins array:

```ts
import { LocalizationPlugin } from '@setu-ts/localization-plugin';

export const localization = LocalizationPlugin({
  supportedLocales: ['en', 'de'],
  catalogues: {
    en: { greeting: 'Hello {name}', items: { one: '{count} item', other: '{count} items' } },
    de: { greeting: 'Hallo {name}', items: { one: '{count} Artikel', other: '{count} Artikel' } },
  },
});
```

## Translate in a module route

```ts
import type { IRouterApi } from '@setu-ts/common';
import { localizerFor } from '@setu-ts/localization-plugin';

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get('/greeting/:name', {
    handler: (ctx) => {
      const localizer = localizerFor(ctx);
      return ctx.response.json({ greeting: localizer.t('greeting', { name: ctx.params.name! }) });
    },
  });
}
```

## Behaviour the types do not show

- The first supported locale is the default; every catalogue is validated during registration.
- Resolution tries the `locale` query, the `setu_locale` cookie, Accept-Language, `tenantLocale`,
  then the default. The middleware runs at priority 45, after default tenant resolution.
- Placeholders are substituted without escaping; use an escaping renderer for HTML.
- Plural messages require numeric `count`; a missing selected category falls back to `other`.
- `onMissing` defaults to `'key'`, returning the key; `'throw'` raises `MissingMessageError`.

## Other options

- Supply `source` instead of `catalogues` to load an `IMessageSource` once at registration.
- `middleware.query: false` or `middleware.cookie: false` disables that resolution source.
- `timeZone` configures formatting; `allowPartialCatalogues` accepts missing default-locale keys.
- `exposeCatalogues: { basePath: '/i18n' }` serves catalogues; `replaceLocale` changes a request
  locale.
