# Localization

How a Setu-TS application answers in more than one language: where the strings live, how a request
gets its locale, and how the same text reaches a server-rendered page, a React Router route and a
browser. Every code example lives in the
[`@setu-ts/localization-plugin` README](../packages/localization-plugin/README.md), where a gate
compiles it; this guide explains the decisions behind them.

## The pieces

- **Catalogues** hold one message per key per locale. They are validated when the application
  starts, so a missing translation is a failed deploy rather than a broken page.
- **The resolution middleware** decides each request's locale and writes it to `ctx.request.locale`,
  a first-class request field like `user` and `tenant`.
- **The localizer** (`localizerFor(ctx)`) formats a message for that locale. Other plugins reach the
  same contract through `CAPABILITIES.LOCALIZATION`.
- **The formatter** is one module shared by the server and the browser, published as the subpath
  `@setu-ts/localization-plugin/format`.

## Choosing how users pick a language

The middleware reads, in order: a query parameter, a cookie, the browser's `Accept-Language`, a
tenant default, and finally your default locale. Each source is a preference, not a credential — any
client can select any locale you support, and nothing else.

Pick the sources you need with the cost in mind:

| Source            | Use it when                                    | Cost                                                     |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------- |
| `Accept-Language` | You want the browser's language by default     | None beyond `Vary: Accept-Language`                      |
| Query parameter   | Links must carry a language (shared, SEO)      | None; the URL already separates cache entries            |
| Cookie            | A language switcher should stick across visits | `Vary: Cookie`, which most CDNs treat as uncacheable     |
| Tenant default    | Each customer has a house language             | Requires `multi-tenancy-plugin`; ranked below the header |

A signed-in user's saved preference is applied by your code, not by a source: session and
authentication run after locale resolution, so call `replaceLocale(ctx.request, tag)` once you know
the user. Do it in middleware rather than in a handler when the route is cached (see below).

## Writing catalogues

Keep keys flat and stable (`cart.empty`, not the English sentence). Use a plural record for any
message with a count, and remember that the plural form comes from the language's rules: English
`count: 0` selects `other`, so "0 items" needs no special form, while Arabic genuinely has `zero`
and `two`.

Start strict. By default a locale missing a key the default locale defines fails startup — the right
behaviour once a translation is shipped. While a language is being added, `allowPartialCatalogues`
serves the default language for the gaps and warns once per locale.

Catalogues kept in a database or a KV store load once at startup through an `IMessageSource`; a
request never waits on them.

## Rendering paths

- **Server-rendered views.** Call `t()` in the handler and pass finished strings as component props.
  The view engine escapes them, so markup in a value arrives as text.
- **React Router.** A loader does not see the kernel's request context, so give it the request's
  localizer through an application-declared context key in `populateLoadContext`. Strings formatted
  in the loader need no client code at all.
- **Browsers and SDK clients.** Expose the catalogues (`exposeCatalogues`), fetch the active
  locale's messages, and format with the `/format` subpath. It has no runtime dependency outside
  itself, so it is safe in a browser bundle; a test enforces that structurally.

**Shared code is not identical output.** The browser and the server run the same formatter, but
`Intl` data differs between runtimes, and a date formats in the runtime's own time zone. When dates
must agree, set the plugin's `timeZone` and pass the same zone to `format` in the browser.

**The formatter never escapes.** Escaping belongs to whatever renders the text. A string
concatenated into HTML by hand is not escaped, exactly as with a view component written that way.

## Caching

A localized response must never be served to a reader of another language. Two mechanisms cover two
kinds of cache:

- **Caches that honour `Vary`** — browsers, CDNs, proxies — rely on `Vary: Accept-Language` (plus
  `Cookie` while the cookie source is on), which the middleware writes on every governed response.
- **`cache-plugin`'s own store** keys on `ctx.request.locale` automatically, as it keys on the
  tenant.
- **`cloudflare-plugin`'s Cache API middleware** keys on a URL, which the platform matches with no
  request headers, so it carries the locale in its default key instead, under the same ordering
  conditions below; a custom `key` must include `ctx.request.locale` itself.

Both hold only when the cache runs after the locale is final, which means after the locale
middleware. A global cache needs a higher priority number than that middleware's: 45 by default, or
whatever `middleware.priority` is set to. Where the locale middleware is applied per route instead
(`middleware.enabled: false`), a global cache runs before it, so the cache belongs on the same
route, listed after `localeMiddleware`. A locale changed inside a handler happens after the cache
lookup, so such a route must not be response-cached.

## Operations

- The `localization` health indicator reports the locale count, the default and the catalogue
  source. It is always `up`: nothing remains to probe after startup.
- A key no catalogue defines answers the key itself and logs one warning per key, at most 256
  tracked. Use `onMissing: 'throw'` in tests and CI to turn gaps into failures.
- A tag your runtime's `Intl` has no data for is refused at startup — on a thin ICU build that is
  the signal, not a plugin defect.
