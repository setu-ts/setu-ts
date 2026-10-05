# @setu-ts/localization-plugin

Message catalogues per locale, request locale resolution, and one formatter shared by the server and
the browser.

## Overview

- `LocalizationPlugin` registers an `ILocalizer` under `CAPABILITIES.LOCALIZATION` and validates
  every catalogue at startup, so a missing translation fails `register()` rather than a request.
- A middleware at priority 45 resolves each request's locale — query parameter, cookie,
  `Accept-Language`, a tenant default, then the default — and writes it to `ctx.request.locale`.
  Every candidate is matched against your supported locales only.
- `localizerFor(ctx)` returns the localizer for that locale. Other plugins resolve the same contract
  without importing this package.
- The formatter and locale negotiation also ship as the import-free subpath
  `@setu-ts/localization-plugin/format`, so a hydrated component or an SDK client formats with the
  same code the server used. A browser imports that subpath only; the package root is the server
  plugin.

Zero npm dependencies: plurals, numbers and dates come from the platform's `Intl`.

## Installation

```bash
deno add jsr:@setu-ts/localization-plugin
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LocalizationPlugin, localizerFor } from '@setu-ts/localization-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    LocalizationPlugin({
      supportedLocales: ['en', 'de'], // the first entry is the default
      catalogues: {
        en: { greeting: 'Hello {name}', items: { one: '{count} item', other: '{count} items' } },
        de: {
          greeting: 'Hallo {name}',
          items: { one: '{count} Artikel', other: '{count} Artikel' },
        },
      },
    }),
  ],
});

app.router.get('/hello/:name', (ctx) => {
  const { t } = localizerFor(ctx);
  return ctx.response.text(
    `${t('greeting', { name: ctx.params.name })} — ${t('items', { count: 3 })}`,
  );
});

await app.start({ port: 3000 });
```

`curl -H 'accept-language: de-AT' localhost:3000/hello/Ada` answers `Hallo Ada — 3 Artikel`, with
`Content-Language: de`.

## Catalogues

A catalogue maps a flat key to a message. A message is a string with `{name}` placeholders, or a
plural record keyed by CLDR category (`zero`, `one`, `two`, `few`, `many`, `other`) with `other`
required. The form is chosen with `Intl.PluralRules(locale).select(count)`, so a plural message
needs a numeric `count`:

- `zero` is selected only where the locale's rules produce it (Arabic, Latvian, …). In English,
  `count: 0` selects `other` — write `{ one: '{count} item', other: '{count} items' }`, not a `zero`
  form, unless you special-case zero yourself.
- A form the message lacks falls back to `other`.

Validation at `register()` refuses, by name: a malformed or unknown locale tag (`Intl` would
otherwise silently format it in the runtime's default locale), a catalogue for a locale you did not
list, a default locale with no catalogue, a malformed message, and a supported locale missing keys
the default locale defines. Set `allowPartialCatalogues: true` to accept the last one with a single
warning per locale; the default locale's message is then served for the missing keys — formatted in
the REQUEST's locale, so its numbers and dates follow the reader's conventions, exactly as a browser
formatting the served catalogue does.

Catalogues kept outside the code load once through a source, still validated the same way:

```typescript
import { LocalizationPlugin } from '@setu-ts/localization-plugin';
import type { IMessageSource } from '@setu-ts/localization-plugin';

declare const kv: { get(key: string): Promise<string | null> };

const source: IMessageSource = {
  name: 'kv',
  load: async () => JSON.parse((await kv.get('catalogues')) ?? '{}'),
};

LocalizationPlugin({ supportedLocales: ['en', 'de'], source });
```

## How the locale is resolved

The middleware tries, in order, the first source that selects a supported locale:

1. the `locale` query parameter (`middleware.query`, `false` disables it);
2. the `setu_locale` cookie (`middleware.cookie`, `false` disables it);
3. `Accept-Language` — q-values honoured, `de-AT` falling back to `de`, and a `*` range selecting
   the first supported locale the client did not exclude with `q=0` (so `en;q=0, *` never selects
   `en`). When every locale is excluded the chain continues: the plugin never answers `406`;
4. `tenantLocale(tenant)`, when configured and a tenant is resolved — the tenancy middleware runs at
   40, before this one at 45;
5. the default locale.

A signed-in user's saved preference is not a source here, because session (260) and authentication
(300) run later. Apply it with `replaceLocale(ctx.request, tag)` once you know the user;
`Content-Language` follows, because it is written after the handler returns.

The `Accept-Language` parse is bounded before any work: the value is cut to 1024 characters before
it is split, at most 16 ranges are read, and a range longer than 35 characters is dropped. The same
35-character cap applies to the query parameter and the cookie, and a configured locale longer than
that is refused at startup, since no client could select it. A malformed tag is "no match", never an
error. Client text never selects a locale you did not configure, and it never reaches a response
header.

The operational paths `/live`, `/ready`, `/health`, `/metrics`, `/openapi.json` and `/docs` are
skipped (`middleware.exclude`, `[]` disables). A reader running before priority 45 — or on an
excluded path — sees `ctx.request.locale` as `undefined`, and `localizerFor` answers the default
locale.

`ctx.request.locale` accepts one implicit write per request, like `user` and `tenant`; a second
plain assignment throws. Use `replaceLocale` for a deliberate change.

## Response headers

Every governed response carries `Vary: Accept-Language`, plus `Cookie` while the cookie source is
enabled. Both are unconditional, because the response varies by those headers whether or not they
won on this request. `Vary: Cookie` is correct and has a real cost: most CDNs treat it as
effectively uncacheable. If you want edge caching, set `middleware: { cookie: false }` and let users
choose through the query parameter or a path instead.

`Content-Language` carries the final locale, written after the handler returns, unless the handler
set its own. An error response gets none — its body is the error handler's.

## Caching

`@setu-ts/cache-plugin` keys on the resolved locale by default, the way it keys on the tenant, so
one locale's cached body is never served to another. That holds wherever the cache runs AFTER the
locale is final:

- a route-level `cacheMiddleware` always does — route middleware runs after every global one;
- a global `cacheMiddleware` must have a higher priority number than the locale middleware — 45 by
  default, or whatever `middleware.priority` is set to (as it must already sit above 40 for the
  tenant);
- when the locale middleware runs per route instead (`middleware.enabled: false`), a global cache
  runs before it, so put the cache on that route, listed after `localeMiddleware`;
- a `replaceLocale` override is reflected only when it runs before the cache lookup — in global
  middleware, not inside the handler. A route that changes the locale in its handler must not be
  response-cached.

`@setu-ts/cloudflare-plugin`'s `cacheApiMiddleware` keys on a URL, which the platform matches with
no request headers — `Vary` cannot separate its entries — so its default key carries the resolved
locale as a `setu-cache-locale` parameter (on the key, never the request), under the same conditions
as above — running after the locale middleware, and not reflecting a handler-time `replaceLocale`. A
custom `key` replaces that and must include `ctx.request.locale` itself.

`Vary` protects the caches you do not configure: browsers, proxies and CDNs that honour it.

## Rendering paths

### Server-rendered views

A component receives finished strings as props; the rendering runtime escapes them.

```typescript
import { html } from '@hono/hono/html';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { renderView, ViewPlugin } from '@setu-ts/view-plugin';
import { LocalizationPlugin, localizerFor } from '@setu-ts/localization-plugin';

const Cart = (props: { readonly title: string; readonly summary: string }) =>
  html`
    <h1>${props.title}</h1>
    <p>${props.summary}</p>
  `;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ViewPlugin({ engine: 'hono-html' }),
    LocalizationPlugin({
      supportedLocales: ['en'],
      catalogues: {
        en: { cart: 'Cart', summary: { one: '{count} item', other: '{count} items' } },
      },
    }),
  ],
});

app.router.get('/cart', (ctx) => {
  const { t } = localizerFor(ctx);
  return renderView(ctx, Cart, { title: t('cart'), summary: t('summary', { count: 2 }) });
});
```

### React Router (SSR and hydration)

A loader does not see the kernel's request context, so hand it the request's localizer through an
application-declared context key:

```typescript
import { contextKeyFor, ReactRouterPlugin } from '@setu-ts/react-router-plugin';
import type { RouterLoadContext } from '@setu-ts/react-router-plugin';
import type { ILocalizer } from '@setu-ts/common';
import { localizerFor } from '@setu-ts/localization-plugin';

// app/lib/context-keys.server.ts
export const localizerContext = contextKeyFor<ILocalizer | null>('app.localizer', null);

// setu.config.ts
export const ssr = ReactRouterPlugin({
  serverBuildPath: './build/server/index.js',
  populateLoadContext: (ctx, context) => context.set(localizerContext, localizerFor(ctx)),
});

// app/routes/cart.tsx
export function loader({ context }: { context: RouterLoadContext }) {
  const localizer = context.get(localizerContext);
  return { locale: localizer?.locale ?? 'en', title: localizer?.t('cart') ?? 'Cart' };
}
```

Strings formatted in the loader need nothing on the client. A hydrated component that formats
runtime values itself fetches its locale's catalogue (below) and calls the shared formatter.

### Browser and SDK clients

Expose the catalogues and format with the subpath, which imports nothing at runtime:

```typescript
import { LocalizationPlugin } from '@setu-ts/localization-plugin';

LocalizationPlugin({
  supportedLocales: ['en', 'de'],
  catalogues: { en: { greeting: 'Hello {name}' }, de: { greeting: 'Hallo {name}' } },
  exposeCatalogues: { basePath: '/i18n' }, // GET /i18n/de → { locale, messages }
  timeZone: 'Europe/Berlin',
});
```

```typescript
import { format, negotiateLocale } from '@setu-ts/localization-plugin/format';
import type { MessageCatalogue } from '@setu-ts/common';

const supported = ['en', 'de'];
const locale = negotiateLocale(navigator.languages, supported) ?? 'en';
const { messages } = await (await fetch(`/i18n/${locale}`)).json() as {
  readonly messages: MessageCatalogue;
};

const greeting = messages.greeting;
const text = greeting === undefined ? '' : format(greeting, { name: 'Ada' }, locale, {
  timeZone: 'Europe/Berlin',
});
```

The route serves only supported locales, each overlaid on the default locale's messages so a partial
catalogue falls back exactly as `t()` does. Anything else is a `404` with a fixed detail. Its
default `Cache-Control` is `private, max-age=3600`: browser-cached, never shared, because a session
with `rolling` or `idleTimeoutMs` refreshes its cookie on every response and a shared cache must not
store that. Set `cacheControl: 'public, max-age=3600'` when no session cookie reaches the route.

## Formatting

`{name}` is replaced by `values[name]`: a number with `Intl.NumberFormat`, a `Date` with
`Intl.DateTimeFormat`, a string verbatim, `null`/`undefined` as nothing. A placeholder with no value
is left as written.

**The formatter escapes nothing.** It substitutes text; the renderer escapes it. An `html` template
or JSX escapes the result, a hand-written string concatenated into HTML does not — the same rule as
for `IViewEngine.render`.

**Shared code, not identical output.** The server and the browser run the same formatter, but `Intl`
output depends on each runtime's locale data, and a `Date` formats in the runtime's own time zone
unless one is given. Set the plugin's `timeZone` and pass the same value to `format` in the browser
when dates must agree.

## Missing keys

`t()` for a key no catalogue defines answers the key itself and logs one warning per key, so a
translation gap never fails a request. At most 256 distinct keys are tracked. Set
`onMissing: 'throw'` in tests and CI to fail loudly instead.

## Options

| Option                   | Default         | Description                                                                                                        |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `supportedLocales`       | —               | BCP 47 tags; the first is the default. Required.                                                                   |
| `catalogues`             | —               | Catalogues keyed by tag. Exactly one of this and `source`.                                                         |
| `source`                 | —               | An `IMessageSource` loaded once at `register()`.                                                                   |
| `allowPartialCatalogues` | `false`         | Accept locales missing default keys, with one warning each.                                                        |
| `onMissing`              | `'key'`         | `'throw'` throws `MissingMessageError` for an unknown key.                                                         |
| `timeZone`               | runtime zone    | IANA zone `Date` values are formatted in; validated at startup.                                                    |
| `tenantLocale`           | —               | `(tenant) => tag`, consulted after `Accept-Language`.                                                              |
| `middleware.enabled`     | `true`          | `false` registers no global middleware; use `localeMiddleware`.                                                    |
| `middleware.priority`    | `45`            | After tenant (40), before logging (50).                                                                            |
| `middleware.query`       | `'locale'`      | Query parameter source; `false` disables it.                                                                       |
| `middleware.cookie`      | `'setu_locale'` | Cookie source; `false` disables it and drops `Cookie` from `Vary`.                                                 |
| `middleware.exclude`     | six probe paths | Paths skipped entirely; `[]` disables exclusion.                                                                   |
| `exposeCatalogues`       | off             | `{ basePath, cacheControl? }` serves `GET <basePath>/:locale`; `cacheControl` defaults to `private, max-age=3600`. |

## Health Indicator

The plugin registers a `localization` indicator reporting the supported locale count, the default
locale and the catalogue source. It is always `up`: after `register()` there is no backend to probe.

## Exports

### `@setu-ts/localization-plugin`

| Export                      | Kind      |
| --------------------------- | --------- |
| `localeMiddleware`          | function  |
| `LocalizationPlugin`        | function  |
| `localizerFor`              | function  |
| `MissingMessageError`       | class     |
| `MissingPluralCountError`   | class     |
| `UnsupportedLocaleError`    | class     |
| `IMessageSource`            | interface |
| `LocaleMiddlewareOptions`   | interface |
| `LocalizationPluginOptions` | type      |

### `@setu-ts/localization-plugin/format`

| Export                | Kind      |
| --------------------- | --------- |
| `format`              | function  |
| `negotiateLocale`     | function  |
| `parseAcceptLanguage` | function  |
| `AcceptLanguage`      | interface |
| `FormatOptions`       | interface |
| `FormatValues`        | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#localization-plugin-setu-tslocalization-plugin).
