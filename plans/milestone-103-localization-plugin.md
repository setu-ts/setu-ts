# Milestone 103 — Localization (`@setu-ts/localization-plugin`)

> **Status:** Planning. Written on `docs/m103-localization-roadmap` beside the ROADMAP section that
> opens the milestone; implementation happens on `feat/m103-localization-plugin`. `develop` and
> `main` are protected — all work (implementation + fixes) stays on that one branch until it merges
> via a single PR.

## 0. Objective & scope

One place for an application's user-facing strings per locale, one way to learn which locale a
request wants, and one formatter that produces identical text on the server and in a browser. A new
`@setu-ts/localization-plugin` registers an `ILocalizer` under a new `CAPABILITIES.LOCALIZATION`,
resolves the request locale in middleware and writes it to a new first-class `IRequest.locale` (the
`tenant` precedent), validates every catalogue at `register()`, and ships its formatter and locale
negotiation as a zero-import subpath export (`@setu-ts/localization-plugin/format`) so a hydrated
React Router component or an SDK client formats with the same code the server used. `cache-plugin`
keys on the resolved locale by default, the way it keys on the tenant since M70b.

- **In scope:** `common` — `CAPABILITIES.LOCALIZATION`, `common/src/services/localization.ts`
  (`ILocalizer`, `LocalizationMessage`, `PluralForms`, `MessageCatalogue`), `IRequest.locale?`, the
  `locale` slot in `request-identity.ts` plus `replaceLocale`. The new plugin: options, catalogue
  validation, the resolution middleware at priority 45, `Vary`/`Content-Language`, the opt-in
  catalogue route, the `localization` health indicator, the `/format` subpath. `cache-plugin` — a
  `localeSegment` in `composeCacheKey`. Docs: README, `PUBLIC_API.md` (two sections),
  `ARCHITECTURE.md` (package row, diagram node, priority-table row), `docs/localization.md`,
  `docs/health-indicators.md` row, CHANGELOG `Added`, root README capability row, release list.
- **NOT this milestone:** wiring localization into the CLI's scaffolded full-stack template (M101g
  owns that template; M101d is editing `react-router-plugin` under it); any `src` change in
  `react-router-plugin`, `full-stack-starter`, `cli`, `view-plugin`, `mail-plugin` or
  `decorator-plugin`; ICU MessageFormat syntax (`select`, nested plural, `offset`) — a follow-on
  once the catalogue shape has a consumer; translation-file tooling (key extraction, `.po`/`.xliff`
  import) — a CLI concern; right-to-left layout; `Intl.Collator` sorting; per-tenant catalogue
  overrides beyond a tenant-selected tag such as `en-GB-x-acme`.

## 1. Contracts verified from SOURCE (not names)

| Reference                                    | Source (file:line)                                                                | Verified surface / fact                                                                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCapabilityToken`                      | `packages/common/src/tokens.ts` (`TOKEN_PATTERN` guard)                           | Lowercase kebab-case, optional dot namespaces, colons illegal. `localization` passes.                                                                                                                                                   |
| `CAPABILITIES`                               | `packages/common/src/tokens.ts:41-269`                                            | Flat `KEY: 'token'` record; `VIEW: 'view'` at `:262` is the most recent plugin token. `LOCALIZATION: 'localization'` is added beside it.                                                                                                |
| `IRequest.user` / `IRequest.tenant`          | `packages/common/src/http.ts:36-66`                                               | Both OPTIONAL, mutable, documented as one-implicit-write with `replacePrincipal`/`replaceTenant`. `locale?: string` follows the same shape and JSDoc wording.                                                                           |
| `sealRequestIdentity`                        | `packages/common/src/request-identity.ts:120`                                     | Installs module-level accessor descriptors (`IDENTITY_DESCRIPTORS`) over `user` and `tenant`; migrates a seeded value as the first write; idempotent. `field: 'user' \| 'tenant'` is a closed union in `secondWriteError`/`isSealed`.   |
| `replaceTenant`                              | `packages/common/src/request-identity.ts` (last export)                           | Writes the slot directly on a sealed request, assigns on an unsealed one. `replaceLocale` is the same body over a `LOCALE_SLOT`.                                                                                                        |
| Seal call sites                              | `kernel/src/context/request-context.ts:161`; `testing/src/mock-context.ts:413`    | Exactly two producers call `sealRequestIdentity`. Adding a descriptor inside `IDENTITY_DESCRIPTORS` reaches both with NO change to those two files.                                                                                     |
| `IRequestContext`                            | `packages/common/src/http.ts:298-335`                                             | `request`, `response`, `services`, `params`, `query: Readonly<Record<string,string>>`, `state: Map<string, unknown>`, `startTime`, `signal`, `raw?`. The query parameter is read from `ctx.query`.                                      |
| `IResponse.header` / `appendHeader`          | `packages/common/src/http.ts:207`; `kernel/src/context/response.ts:41,46`         | `header(name, value)` sets, `appendHeader(name, value)` appends — M48 verified `appendHeader` never consults `#ended`. `Vary` uses `appendHeader`; `Content-Language` uses `header`.                                                    |
| `IMiddlewareApi.add`                         | `packages/common/src/plugin.ts:50`                                                | `add(middleware, { priority?, name? })`. The plugin registers at `priority: 45`, `name: 'locale'`.                                                                                                                                      |
| `IPluginContext.logger` / `runtime`          | `packages/common/src/plugin.ts:525-529`                                           | `runtime: IRuntimeServices` required; `logger?: ILogger` optional — every log call is optional-chained and read at CALL time (M52b).                                                                                                    |
| `IHealthApi.register` / `HealthIndicatorFn`  | `packages/common/src/plugin.ts:214`; `common/src/services/health.ts:26`           | `register(name, () => Promise<HealthCheckResult>)`.                                                                                                                                                                                     |
| `createPathMatcher` / `PathPattern`          | `packages/common/src/path-matcher.ts`; used at `tenant-middleware.ts:102`         | The one path matcher M90a promoted; the exclusion list is compiled once at construction.                                                                                                                                                |
| `DEFAULT_EXCLUDED_PATHS`                     | `multi-tenancy-plugin/src/middleware/tenant-middleware.ts:54`                     | Declared INSIDE the tenancy plugin, not in `common`, so it cannot be imported here (§2.2). This plugin declares its own list and a test pins it equal to the tenancy list by value.                                                     |
| `respondWithError`                           | `packages/common/src/errors/error-responder.ts:206`                               | `(target, init)`; writes the configured format (M70f). The catalogue route's 404 goes through it.                                                                                                                                       |
| `parseCookie`                                | `packages/common/src/cookie.ts:63`, exported at `index.ts:558`                    | `(header: string \| null \| undefined) => Record<string, string>`. The cookie source reads through it; no second cookie parser.                                                                                                         |
| `IRouterApi.get`                             | `packages/common/src/plugin.ts:91`                                                | `get(path, handler)`; `:name` segments populate `ctx.params`. The catalogue route is `${basePath}/:locale`.                                                                                                                             |
| `composeCacheKey` / `tenantSegment`          | `packages/cache-plugin/src/utils/cache-key.ts:42,96`                              | `tenantSegment(ctx) + varySegment(ctx, vary) + base`; the tenant segment is `t:<len>:<id>\|`, empty when unresolved, applied around a custom `key` too. The locale segment is inserted between tenant and vary with the same encoding.  |
| `Component<P>`                               | `packages/common/src/services/view.ts` (`export type Component<P>`)               | `(props: P) => unknown`. README fences pass strings in as props; no view-plugin change.                                                                                                                                                 |
| `servicesContext`                            | `react-router-plugin/src/handler/context-keys.ts:38`; set at `load-context.ts:28` | The default load context already exposes `ctx.services`; a loader resolves the localizer from it. No `react-router-plugin` change.                                                                                                      |
| `Custom(name)` + `registerParameterResolver` | `decorator-plugin/src/decorators/params.ts:220`; `index.ts:51,101`                | The application registers a `'locale'` resolver and declares `@Params(Custom<string>('locale'))`. No `decorator-plugin` change; shown in the README.                                                                                    |
| Subpath export precedent                     | `packages/runtime/deno.json:7`                                                    | `"./worker": "./src/worker/define-worker-task.ts"` — a second `exports` entry is how a package ships a module importable without the barrel.                                                                                            |
| Release list                                 | `scripts/release-packages.ts:70` (`'packages/view-plugin'`, Tier 4)               | The new package joins Tier 4 after `view-plugin`; `release:verify` moves from 49 to 50 and the first-publish runbook step applies.                                                                                                      |
| Root workspace                               | `deno.json:50` (`"./packages/view-plugin"`)                                       | The new member is added to the workspace list.                                                                                                                                                                                          |
| README fence gate                            | `test/package-readme-fence-compiler.test.ts:96`                                   | A per-README fence COUNT is pinned; the new README gets a row with its count.                                                                                                                                                           |
| Health-indicator audit                       | `docs/health-indicators.md:38,66`                                                 | Each indicator row pins `file:line` of its `ctx.health.register` call and a classification. The new row is `justified-literal` with the stated justification.                                                                           |
| `Intl.getCanonicalLocales`                   | probed on Deno 2.9 (2026-10-04)                                                   | `'de-at'` → `['de-AT']`; `'x'.repeat(40)`, `'en_US'`, `''` each THROW `RangeError`. Every call sits inside a guard.                                                                                                                     |
| `Intl.Locale(tag).minimize()`                | probed                                                                            | `'de-AT'.minimize()` is `'de-AT'`, NOT `'de'` — so fallback cannot use `minimize`; subtags are stripped right-to-left by hand (§3.2).                                                                                                   |
| `Intl.PluralRules`                           | probed                                                                            | `select(1)` on `en` is `'one'`, `select(2)` on `ar` is `'two'`; `supportedLocalesOf(['tlh','de'])` is `['de']` — an UNKNOWN tag silently falls back to the runtime default, which is why only configured tags ever reach `Intl` (§3.6). |
| `Intl.NumberFormat` / `DateTimeFormat`       | probed                                                                            | `de-DE` formats `1234.5` as `1.234,5`; `en-GB` formats epoch zero as `01/01/1970`. Both are per-locale with no npm dependency.                                                                                                          |
| `navigator` on Deno                          | probed                                                                            | `typeof navigator === 'object'` on Deno, so a "runs in a browser" test cannot key on `navigator`; it keys on the ABSENCE of `Deno`/`process` (§3.13).                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                           | Doc deliverable (same PR)                                                                                  |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md` §10 priority table (`:1866-1882`) has rows at 40 (tenant) and 50 (logging) and nothing between; this plan's middleware sits at 45 and the table is the committed statement of the bands.                    | Insert a `45 / LocaleMiddleware / Resolve request locale` row; the prose below the table gains `locale resolution (45)` in its list of self-registered middleware. | `ARCHITECTURE.md` §10 table and prose.                                                                     |
| C2 | `common/src/state-keys.ts:19-27` documents every cross-package `ctx.state` key; the ROADMAP's first draft of M103 put the locale there, and the committed section (`4fcc84d5`) moves it onto `IRequest`. No state key exists. | The ROADMAP section is authoritative: `IRequest.locale`, no state key, so `state-keys.ts` is NOT touched and the ROADMAP needs no further change.                  | None beyond confirming `state-keys.ts` is unchanged in the PR diff (`git diff --stat` names no such file). |
| C3 | `cache-plugin`'s README and `PUBLIC_API.md` Cache section describe the key as tenant segment + vary segment + base; after this milestone a locale segment sits between them.                                                  | Document the new composition in both, naming absence → empty segment → byte-identical keys for applications without this plugin.                                   | `packages/cache-plugin/README.md` key-composition paragraph; `PUBLIC_API.md` Cache "Notes".                |
| C4 | `PUBLIC_API.md`'s `common` section documents `IRequest` with `user` and `tenant` as the two one-write identity fields and names `replacePrincipal`/`replaceTenant`.                                                           | Add `locale` as the third, with `replaceLocale`, in the same paragraph, so the three are documented as one mechanism.                                              | `PUBLIC_API.md` `common` → `IRequest` and request-identity notes.                                          |

## 3. Design decisions

### 3.1 The resolved locale is `IRequest.locale`, sealed like `user` and `tenant`

- **Decision:** `common` gains `locale?: string` on `IRequest` (a BCP 47 tag, canonical casing), a
  `LOCALE_SLOT`/`LOCALE_WRITTEN` pair and a `locale` descriptor inside `IDENTITY_DESCRIPTORS`, the
  `field` union widened to `'user' | 'tenant' | 'locale'`, seeding of a pre-set `locale` in
  `sealRequestIdentity`, and an exported `replaceLocale(request, tag)` with `replaceTenant`'s body.
  The middleware writes through `replaceLocale`, exactly as `tenantMiddleware` writes through
  `replaceTenant` (`tenant-middleware.ts:137`), so a global registration plus a route-level one is a
  supported composition. No `ctx.state` key is written for the locale.
- **Why:** the second reader exists on day one (`cache-plugin`, §3.10), and a cross-package state
  key must live as a constant in `common` anyway (`state-keys.ts:5`), so a field is the same
  `common` change with discoverability. The three things to watch are stated in the field's JSDoc
  and `PUBLIC_API.md`: a flagged, optional, source-compatible `common` widening; the seal's
  per-request cost (§8 measures it); and a reader below priority 45 seeing `undefined`.
- **Test home:** `common/test/unit/request-identity.test.ts` (new cases: second implicit write
  throws naming `replaceLocale`; seeded value counts as first write; `replaceLocale` on sealed and
  unsealed requests; `Object.keys(request)` and `JSON.stringify` unchanged by sealing — the
  symbol-keyed slot invariant); `localization-plugin/test/unit/locale-middleware.test.ts` (writes
  through `replaceLocale`, so a second run does not throw).

### 3.2 Resolution chain, matching, and fallback

- **Decision:** the middleware tries, in this fixed order, the first source that yields a SUPPORTED
  tag: (1) the query parameter (`middleware.query`, default name `locale`, `false` disables); (2)
  the cookie (`middleware.cookie`, default name `setu_locale`, read through `parseCookie`, `false`
  disables); (3) `Accept-Language` (§3.3); (4) `tenantLocale(ctx.request.tenant)` when the option is
  supplied and a tenant is present; (5) `supportedLocales[0]`, the default. A candidate is matched
  against `supportedLocales` ONLY, never passed to `Intl` otherwise: it is canonicalized inside a
  `try` around `Intl.getCanonicalLocales` (a malformed tag is simply "no match"), compared for exact
  equality after canonicalization, then by stripping subtags right-to-left (`de-Latn-AT` → `de-Latn`
  → `de`) until a supported tag matches. `Intl.Locale.minimize` is NOT used (§1: it leaves `de-AT`
  alone). The negotiation is one pure function, `negotiateLocale(candidates,
  supported)`, in the
  `/format` subpath so a browser resolves `navigator.languages` with the same rules.
- **Why:** query and cookie are how an application lets a user choose; the header is the browser's
  default; the tenant default lets a B2B deployment pin a language per customer; and the default
  closes the chain so `request.locale` is ALWAYS set on a non-excluded path, which is what lets
  `cache-plugin` and `Content-Language` rely on it. Matching only against the configured set is the
  whole security argument (§10): attacker text never selects an unconfigured locale and never
  reaches `Intl` unvalidated.
- **Test home:** `test/unit/negotiate.test.ts` (each rule, with `de-at` canonical casing, the
  three-subtag strip, a malformed tag yielding no match, `*`); `test/unit/locale-middleware.test.ts`
  (one case per source with the sources above it absent, one negative control per source proving
  precedence — the query beats the cookie beats the header beats the tenant beats the default).

### 3.3 `Accept-Language` is parsed under a bound, before any work

- **Decision:** the header value is sliced to 1024 bytes before splitting; at most 16 ranges are
  considered and the rest ignored; a range longer than 35 bytes is dropped before canonicalization;
  `q` is parsed as RFC 9110 §12.4.2 (0 to 1, at most three decimals; malformed → treated as 1; `q=0`
  excludes); ranges sort by `q` descending, stable on ties; `*` matches the default locale. Parsing
  is one pure function, `parseAcceptLanguage(value)`, returning ordered tags; the middleware hands
  them to `negotiateLocale`.
- **Why:** the header is network input, and a bound applied after the split has already paid the
  cost of the split (the M90a `maxBodyBytes` lesson). 35 bytes is BCP 47's practical maximum for a
  well-formed tag; 16 ranges exceeds any real browser preference list.
- **Test home:** `test/unit/accept-language.test.ts` (q ordering, `q=0` exclusion, `*`, a 64 KiB
  header costing one slice and yielding at most 16 ranges — asserted by count, a 36-byte range
  dropped, malformed `q`).

### 3.4 Catalogues are validated at `register()`

- **Decision:** `supportedLocales` (non-empty; the first entry is the default; each entry must
  canonicalize and `Intl.PluralRules.supportedLocalesOf` must return it, else `register()` throws
  naming the tag) and `catalogues: Record<tag, MessageCatalogue>` (static) or
  `source: IMessageSource` (`load(): Promise<Record<tag, MessageCatalogue>>`, awaited once in
  `register()`); supplying both or neither is a refusal. A catalogue for a supported locale missing
  a key the DEFAULT locale defines fails `register()` naming the locale and the first ten missing
  keys, unless `allowPartialCatalogues: true`, which downgrades it to one `warn` per locale and
  fills the gap from the default locale at lookup time. A catalogue for an UNSUPPORTED tag is a
  refusal (a typo would otherwise silently ship a dead catalogue). Every message value must be a
  string or a `PluralForms` record whose keys are among `zero|one|two|few|many|other` and which
  carries `other`; anything else is a refusal naming the key.
- **Why:** a missing translation is a deployment-time fact and should fail at startup, never on a
  request. The `IMessageSource` seam is the inject-or-static shape — no filesystem convention, so
  the plugin stays Workers-portable (M92's rule).
- **Test home:** `test/unit/catalogue-validation.test.ts` (each refusal by message; partial
  catalogues warn once per locale; the `source` arm awaited; both-arms and neither-arm refusals; a
  tag the runtime's `Intl` lacks is refused).

### 3.5 A missing key at request time never fails the request

- **Decision:** `t(key)` for a key present in no catalogue returns the KEY itself and logs `warn`
  once per key per process through `ctx.logger` read at call time; `onMissing: 'throw'` makes it
  throw `MissingMessageError` (exported, carries `key` and `locale`) — the strict arm for tests and
  CI. With `allowPartialCatalogues`, a key present in the default locale but absent in the resolved
  one is served from the default without a warning (the warning already fired at `register()`).
- **Why:** a request must not `500` over a translation gap; the application shipped it and the key
  is a readable fallback, while CI wants it loud.
- **Test home:** `test/unit/localizer.test.ts` (key echoed; exactly one warn for N calls; `throw`
  arm; default-locale fallback under partial catalogues).

### 3.6 The formatter: `{name}` placeholders, plural records, `Intl` for numbers and dates

- **Decision:** `format(message, values, locale)` in the zero-import `/format` subpath. A string
  message has `{name}` placeholders replaced by `values[name]`; a `number` is rendered with
  `new Intl.NumberFormat(locale)`, a `Date` with `new Intl.DateTimeFormat(locale)`, a string
  verbatim, `null`/`undefined` as the empty string, anything else via `String()`. A placeholder
  whose name is absent from `values` is left VERBATIM (`{name}`), never thrown. A `PluralForms`
  record requires `values.count` to be a finite number — absent or non-finite throws
  `MissingPluralCountError` naming the key — selects the form with
  `new Intl.PluralRules(locale).select(count)` falling back to `other`, then formats the chosen
  string as above. `Intl` instances are cached per locale in a module-level `Map` capped at the
  supported set's size (the formatter is handed only configured tags). The formatter escapes
  nothing.
- **Why:** this is the smallest grammar that handles "3 items" correctly in every CLDR language
  without a parser; ICU's `select`/nested/offset grammar is the named follow-on. Escaping is the
  rendering runtime's job — the M92/M102 rule — and the docs say so in three sites.
- **Test home:** `test/unit/format.test.ts` (placeholders; verbatim unknown placeholder; number and
  Date per locale with literal expected strings from §1's probes; plural selection for `en` and
  `ar`; missing count throws; the escaping NON-guarantee pinned: `format('{x}', { x: '<b>' })` is
  `<b>`).

### 3.7 `Vary: Accept-Language` and `Content-Language`

- **Decision:** on every non-excluded request the middleware, BEFORE `next()`, appends
  `Vary: Accept-Language` via `appendHeader` and sets `Content-Language: <tag>` via `header`.
  Setting before `next()` is deliberate: a handler that knows better can overwrite
  `Content-Language`, and `appendHeader` never consults `#ended` (M48) so a later terminal cannot
  lose `Vary`.
- **Why:** the response varies by the header whenever the middleware is in the pipeline, whether or
  not the header won this time, so a conditional `Vary` would mis-describe the cache contract.
- **Test home:** `test/integration/headers.test.ts` through a real kernel app and `app.fetch` (not
  `inject()`, which skips the response mapper — the M97b finding): both headers present; `Vary`
  composes with an existing `Vary` value rather than replacing it; excluded paths carry neither.

### 3.8 The catalogue route is opt-in and serves only supported locales

- **Decision:** `exposeCatalogues: { basePath: string; cacheControl?: string }` registers
  `GET ${basePath}/:locale` answering `{ locale, messages }` as JSON for a supported tag, with
  `Cache-Control` (default `public, max-age=3600`) and `Content-Language`; an unsupported `:locale`
  answers `404` through `respondWithError` with a fixed detail, never a lookup and never an echo of
  the parameter. Off when the option is absent. `basePath` must start with `/` and contain no `:` or
  `*`, refused at construction.
- **Why:** a browser formatting after hydration needs exactly this file; an application whose
  strings never leave the server exposes nothing.
- **Test home:** `test/integration/catalogue-route.test.ts` (served body equals the configured
  catalogue; headers; `404` body in the configured format via the M70f responder; absent option →
  `404` from the kernel; `basePath` refusals).

### 3.9 Middleware priority 45, excluded paths, and registration

- **Decision:** `register()` adds the middleware at `middleware.priority ?? 45` with
  `name:
  'locale'`; `middleware.exclude` defaults to the six operational paths (`/health`,
  `/live`, `/ready`, `/metrics`, `/openapi.json`, `/docs`), compiled once with `createPathMatcher`;
  `[]` disables exclusion. `middleware.enabled: false` registers nothing, for an application
  attaching `localeMiddleware` per route group through the exported factory. The plugin declares
  `optionalDependencies: [CAPABILITIES.MULTI_TENANCY]` so, when a tenancy plugin is present, it is
  ordered first and `tenantLocale` sees a resolved tenant.
- **Why:** after tenant (40) so the tenant default can participate; before logging (50) so a log
  line can carry the locale. The exclusion list mirrors `tenantMiddleware`'s because a probe carries
  no preference and an `Accept-Language` parse per probe is wasted work.
- **Test home:** `test/unit/localization-plugin.test.ts` (registration options; the exclusion list
  pinned equal to the tenancy plugin's by value; `enabled: false`; `optionalDependencies`);
  `test/integration/with-tenancy.test.ts` (a real `MultiTenancyPlugin` listed AFTER this plugin in
  the array, and `tenantLocale` still sees the tenant — the edge, not array order, orders them).

### 3.10 `cache-plugin` keys on the locale by default

- **Decision:** `cache-key.ts` gains `localeSegment(ctx)` returning `l:<len>:<tag>|` when
  `ctx.request.locale` is set and `''` otherwise; `composeCacheKey` becomes
  `tenantSegment + localeSegment + varySegment + base`. No option is added.
- **Why:** M70b closed X4-1 (one tenant's cached body served to another) with the tenant segment; a
  locale is the same class of discriminator and gets the same treatment by default, so an
  application never has to remember a `vary` callback. Absent locale → empty segment → every
  existing key is byte-identical.
- **Test home:** `cache-plugin/test/unit/cache-key.test.ts` (segment encoding; empty when absent;
  composition order; keys byte-identical to the pre-change fixture when `locale` is undefined);
  `localization-plugin/test/integration/cache-vary.test.ts` (the REAL `cacheMiddleware` and this
  plugin in one app: two locales produce two entries, one locale produces one).

### 3.11 One localizer, bound per request through `localizerFor(ctx)`

- **Decision:** the service registered under `CAPABILITIES.LOCALIZATION` is bound to the default
  locale; `ILocalizer.forLocale(tag)` returns a localizer bound to a SUPPORTED tag (an unsupported
  tag throws `UnsupportedLocaleError`, since callers hand it configuration, never user input). The
  exported `localizerFor(ctx)` resolves the service from `ctx.services` and returns
  `service.forLocale(ctx.request.locale ?? service.locale)`. Both `forLocale` and `localizerFor`
  reach one `createBoundLocalizer` so the two entry points cannot drift.
- **Why:** a single app-scoped service is what other plugins resolve (mail, notification); the
  request binding is a view over it, not a second registry entry.
- **Test home:** `test/unit/localizer.test.ts` (`forLocale` refusal; bound `locale`); the
  one-implementation test drives `forLocale(tag)` and `localizerFor(ctx)` under a non-default
  catalogue and asserts identical output.

### 3.12 Health indicator

- **Decision:** `ctx.health.register('localization', …)` answers `up` with
  `data: { locales:
  supportedLocales.length, default, source: 'static' | 'injected' }`.
  Classification `justified-literal`: after `register()` there is no backend and nothing to probe.
- **Why:** the M92 `view` indicator precedent; the live `data` carries the real fact.
- **Test home:** `test/unit/localization-plugin.test.ts`.

### 3.13 The `/format` subpath is proven browser-safe, not assumed

- **Decision:** `src/format/index.ts` re-exports `format`, `negotiateLocale`, `parseAcceptLanguage`
  and their types from modules that import NOTHING (not `common`, not each other beyond type-only
  imports from `./types.ts`). A test spawns `deno run --no-npm` on a probe that deletes
  `globalThis.Deno`, asserts `typeof process === 'undefined'`, imports the subpath, and compares
  `format(...)` output byte-for-byte against the in-process result for the same inputs. `deno.json`
  `exports` gains `"./format": "./src/format/index.ts"`.
- **Why:** the formatter's reason to exist is one implementation on both sides; a stray `common`
  import would type-check and ship a browser bundle that imports a server contract module.
- **Test home:** `test/e2e/format-browser-safe.test.ts`.

### 3.14 React Router and the SDK are README recipes, not code

- **Decision:** the README shows a loader resolving `ILocalizer` from `servicesContext` and
  returning `{ locale, messages }`, a hydrated component calling the subpath `format`, and an SDK
  client fetching the catalogue route and calling `negotiateLocale(navigator.languages, supported)`.
  All three fences compile under the fence gate. No test here imports `react-router-plugin`.
- **Why:** the loader is application code over a seam that exists (`load-context.ts:28`); a test of
  it belongs with the template that scaffolds it, which is M101g's.
- **Test home:** `test/package-readme-fence-compiler.test.ts` (row for this README with its count).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                     | Kind           | Consumer / real code path that READS it                                                                      |
| ------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `LocalizationPlugin(options)`                                       | fn             | The application's plugin list; registers the service, middleware, route and indicator.                       |
| `LocalizationPluginOptions`                                         | type           | The argument type of `LocalizationPlugin`; every member is read in §4.1.                                     |
| `IMessageSource`                                                    | type           | Implemented by an application loading catalogues from a store; awaited in `register()` (§3.4).               |
| `localizerFor(ctx)`                                                 | fn             | Handlers and middleware needing a request-bound localizer (§3.11); the README's functional route.            |
| `localeMiddleware(options)`                                         | fn             | The plugin's own `register()` AND an application attaching it per route group under `enabled: false` (§3.9). |
| `MissingMessageError`                                               | class          | Thrown under `onMissing: 'throw'` (§3.5); `instanceof` in application tests.                                 |
| `MissingPluralCountError`                                           | class          | Thrown by `format` for a plural record with no finite `count` (§3.6).                                        |
| `UnsupportedLocaleError`                                            | class          | Thrown by `forLocale` (§3.11).                                                                               |
| `LocaleMiddlewareOptions`                                           | type           | The `middleware` option's type and `localeMiddleware`'s parameter.                                           |
| `/format` → `format(message, values, locale)`                       | fn (subpath)   | The server's `t()` AND the browser (§3.6, §3.13).                                                            |
| `/format` → `negotiateLocale(candidates, supported)`                | fn (subpath)   | The middleware (§3.2) AND an SDK client over `navigator.languages`.                                          |
| `/format` → `parseAcceptLanguage(value)`                            | fn (subpath)   | The middleware (§3.3); exported so a client-side proxy or test can reuse the same parser.                    |
| `/format` → `FormatValues`                                          | type (subpath) | `format`'s `values` parameter.                                                                               |
| `common` → `CAPABILITIES.LOCALIZATION`                              | token          | `LocalizationPlugin.provides`; every resolver of the service.                                                |
| `common` → `ILocalizer`                                             | type           | The registered service's contract; `mail-plugin`/`notification-plugin` consumers resolve it (M102's shape).  |
| `common` → `LocalizationMessage`, `PluralForms`, `MessageCatalogue` | type           | Option types and the catalogue route's body; `format`'s message parameter.                                   |
| `common` → `IRequest.locale`                                        | field          | `cache-plugin`'s `localeSegment` (§3.10), `localizerFor` (§3.11), `Content-Language` (§3.7).                 |
| `common` → `replaceLocale(request, tag)`                            | fn             | The middleware's write (§3.1); an application overriding the locale after authentication.                    |
| `cache-plugin` → (no new export)                                    | —              | `localeSegment` is internal to `cache-key.ts`; `composeCacheKey` reads it.                                   |

### 4.1 Options — every option names its consumer

| Option                                                    | Consumer                          | Behavior (per implementation)                                                                                           |
| --------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `supportedLocales: readonly string[]`                     | `register()`, negotiation, health | Non-empty; `[0]` is the default; each canonicalizes and is `Intl`-supported, else refused (§3.4).                       |
| `catalogues?`                                             | `register()`                      | Static catalogues; validated per §3.4. Exactly one of `catalogues`/`source` is required.                                |
| `source?: IMessageSource`                                 | `register()`                      | `await source.load()` once; validated identically; health `data.source: 'injected'`.                                    |
| `allowPartialCatalogues?: boolean`                        | validation, lookup                | Default `false`. `true`: one warn per incomplete locale at `register()`, default-locale fallback at lookup (§3.4/§3.5). |
| `onMissing?: 'key' \| 'throw'`                            | `t()`                             | Default `'key'` (§3.5).                                                                                                 |
| `tenantLocale?: (tenant: ITenant) => string \| undefined` | middleware                        | Step 4 of the chain (§3.2); its return is negotiated against the supported set like any candidate.                      |
| `middleware.enabled?`                                     | `register()`                      | Default `true`; `false` registers no global middleware (§3.9).                                                          |
| `middleware.priority?`                                    | `register()`                      | Default `45`; a non-integer is refused at construction.                                                                 |
| `middleware.exclude?`                                     | middleware                        | Default the six operational paths; `[]` disables (§3.9).                                                                |
| `middleware.query?: string \| false`                      | middleware                        | Default `'locale'`; `false` skips the source (§3.2).                                                                    |
| `middleware.cookie?: string \| false`                     | middleware                        | Default `'setu_locale'`; `false` skips the source (§3.2).                                                               |
| `exposeCatalogues?.basePath`                              | `register()`                      | Registers the route (§3.8); refused unless it starts with `/` and has no `:`/`*`.                                       |
| `exposeCatalogues?.cacheControl?`                         | catalogue route                   | Default `public, max-age=3600`.                                                                                         |

## 5. Implementation files

| File                                                                                         | Purpose                                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/tokens.ts`                                                              | `LOCALIZATION: 'localization'`.                                                                                    |
| `packages/common/src/services/localization.ts`                                               | `ILocalizer`, `LocalizationMessage`, `PluralForms`, `MessageCatalogue`.                                            |
| `packages/common/src/http.ts`                                                                | `IRequest.locale?: string` with the one-write JSDoc.                                                               |
| `packages/common/src/request-identity.ts`                                                    | `locale` slot, descriptor, seeding, `replaceLocale`; `field` union widened.                                        |
| `packages/common/src/index.ts`                                                               | Barrel lines for the above.                                                                                        |
| `packages/cache-plugin/src/utils/cache-key.ts`                                               | `localeSegment`; `composeCacheKey` order (§3.10).                                                                  |
| `packages/localization-plugin/deno.json`                                                     | Manifest; `exports` `.` and `./format`; `test.permissions`.                                                        |
| `packages/localization-plugin/src/index.ts`                                                  | Barrel (`@module`-first JSDoc — `release:verify` check 5).                                                         |
| `src/interfaces/index.ts`                                                                    | `LocalizationPluginOptions`, `LocaleMiddlewareOptions`, `IMessageSource`.                                          |
| `src/errors.ts`                                                                              | The three error classes.                                                                                           |
| `src/format/types.ts`                                                                        | `FormatValues` and the message types re-declared structurally (zero-import module).                                |
| `src/format/format.ts`                                                                       | `format` (§3.6); zero imports beyond `./types.ts`.                                                                 |
| `src/format/negotiate.ts`                                                                    | `negotiateLocale`, `parseAcceptLanguage` (§3.2, §3.3); zero imports.                                               |
| `src/format/index.ts`                                                                        | The `./format` subpath barrel.                                                                                     |
| `src/catalogue/validate.ts`                                                                  | `register()`-time validation (§3.4).                                                                               |
| `src/service/localizer.ts`                                                                   | `createLocalizer`, `createBoundLocalizer`, `localizerFor` (§3.5, §3.11).                                           |
| `src/middleware/locale-middleware.ts`                                                        | `localeMiddleware` (§3.2, §3.7, §3.9).                                                                             |
| `src/routes/catalogue-route.ts`                                                              | The opt-in route (§3.8).                                                                                           |
| `src/plugin/localization-plugin.ts`                                                          | `LocalizationPlugin`: options refusals, `register()`, health (§3.9, §3.12).                                        |
| `packages/localization-plugin/README.md`                                                     | Overview, install, the three rendering-path recipes, options table, exports table, escaping and missing-key notes. |
| `docs/localization.md`                                                                       | The guide: resolution chain, catalogue shape, plural records, browser formatting, caching.                         |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `README.md`, `docs/health-indicators.md`, `CHANGELOG.md` | The doc deliverables of §0 and §2.                                                                                 |
| `scripts/release-packages.ts`, `deno.json`                                                   | Tier 4 entry after `view-plugin`; workspace member.                                                                |
| `test/package-readme-fence-compiler.test.ts`                                                 | The new README's fence-count row.                                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                     | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                           |
| ------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/request-identity.test.ts` (extended)        | `request-identity.ts`, `http.ts`                       | §3.1 cases against `sealRequestIdentity(request: IRequest)` and `replaceLocale(request: IRequest, tag: string)`; enumeration unchanged.                                                                    |
| `common/test/unit/barrel-exports.test.ts` (extended)          | `index.ts`, `tokens.ts`, `services/localization.ts`    | `CAPABILITIES.LOCALIZATION === 'localization'`; compile-time pins for the three types and `replaceLocale`.                                                                                                 |
| `cache-plugin/test/unit/cache-key.test.ts` (extended)         | `utils/cache-key.ts`                                   | §3.10 against `composeCacheKey(ctx, baseKey?, vary?)`; pre-change key fixture byte-identical when `locale` is undefined.                                                                                   |
| `localization-plugin/test/unit/format.test.ts`                | `format/format.ts`, `format/types.ts`                  | §3.6 against `format(message: LocalizationMessage, values: FormatValues, locale: string): string`.                                                                                                         |
| `test/unit/negotiate.test.ts`                                 | `format/negotiate.ts`                                  | §3.2 against `negotiateLocale(candidates: readonly string[], supported: readonly string[]): string \| undefined`.                                                                                          |
| `test/unit/accept-language.test.ts`                           | `format/negotiate.ts`                                  | §3.3 against `parseAcceptLanguage(value: string \| null): readonly string[]`.                                                                                                                              |
| `test/unit/catalogue-validation.test.ts`                      | `catalogue/validate.ts`, `errors.ts`                   | §3.4 refusals by message; partial warn count.                                                                                                                                                              |
| `test/unit/localizer.test.ts`                                 | `service/localizer.ts`, `errors.ts`                    | §3.5, §3.11 against `ILocalizer.t(key: string, values?: FormatValues): string`, `forLocale(tag: string): ILocalizer`, `localizerFor(ctx: IRequestContext): ILocalizer`; the two-entry-point identity case. |
| `test/unit/locale-middleware.test.ts`                         | `middleware/locale-middleware.ts`                      | §3.2 precedence with a negative control per source; §3.9 exclusion; writes via `replaceLocale`; uses `createTestContext` from `@setu-ts/testing` so the request is sealed as the kernel seals it.          |
| `test/unit/localization-plugin.test.ts`                       | `plugin/localization-plugin.ts`, `interfaces/index.ts` | Option refusals (§4.1); `provides`/`optionalDependencies`; health payload (§3.12); exclusion list equals the tenancy list by value; `enabled: false`.                                                      |
| `test/unit/barrel-exports.test.ts`                            | `index.ts`, `format/index.ts`                          | Both barrels pinned at compile time (the M56 class); the `/format` barrel exports exactly three functions and one type.                                                                                    |
| `test/integration/headers.test.ts`                            | middleware, plugin                                     | §3.7 through a real kernel app and `app.fetch`.                                                                                                                                                            |
| `test/integration/catalogue-route.test.ts`                    | `routes/catalogue-route.ts`                            | §3.8, including the responder-formatted `404` under `errorHandler({ format: 'rfc9457' })` asserted field by field.                                                                                         |
| `test/integration/cache-vary.test.ts`                         | plugin + the real `cacheMiddleware`                    | §3.10 end to end: two locales, two entries.                                                                                                                                                                |
| `test/integration/with-tenancy.test.ts`                       | plugin + the real `MultiTenancyPlugin`                 | §3.9 ordering by edge; `tenantLocale` participates.                                                                                                                                                        |
| `test/integration/render.test.ts`                             | plugin + the real `ViewPlugin`                         | A route resolves `localizerFor(ctx)`, passes `t('greeting', { name })` as a prop, and the rendered HTML carries the `de` string under `Accept-Language: de`; a negative control under `en`.                |
| `test/e2e/format-browser-safe.test.ts`                        | `format/*`                                             | §3.13 subprocess with `Deno` deleted; byte-identical output.                                                                                                                                               |
| `test/package-readme-fence-compiler.test.ts` (root, extended) | README                                                 | Fence count row; the loader, hydration and SDK recipes compile.                                                                                                                                            |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m103-localization-plugin, never develop or main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs        # fence gate, exports tables, health-indicator pin, @since tags
deno task publish:check     # committed tree — a new package
deno task release:verify 0.8.0   # 50 publishable packages, @module-first entrypoint
```

Beyond the gates: a `.verify-103/driver.ts` behavioural probe through a real kernel app drives all
five resolution sources with a negative control each, the two headers, the cache entries, the
catalogue route, and the browser-safe formatter — the `verify-milestone` procedure.

## 8. Risks & mitigations

- **`Intl` silently falls back to the runtime default for an unknown tag** (§1 probe:
  `supportedLocalesOf(['tlh','de'])` → `['de']`), so a typo in `supportedLocales` would format every
  message in the server's own locale with no error → `register()` refuses any configured tag
  `Intl.PluralRules.supportedLocalesOf` does not return, and only configured tags ever reach `Intl`.
- **ICU data differs by runtime** (Node `small-icu` builds, workerd's subset) so a tag Deno accepts
  may be refused elsewhere → the refusal above is the same check on every runtime, and the README
  names it as the symptom of a thin ICU build rather than a plugin defect.
- **The seal's per-request cost grows with a third field** (M87 measured the two-field seal at ~0.5
  µs) → measured in the PR with the M87 interleaved A/B harness, recorded in the PR body; the field
  stays sealed for consistency with `user`/`tenant` unless the measurement exceeds 1 µs, in which
  case the number and the decision are brought back to the maintainer before merge.
- **A reader below priority 45 sees `undefined`** → stated in the field's JSDoc and `PUBLIC_API.md`;
  `localizerFor` falls back to the default locale rather than throwing, so a mis-ordered reader
  degrades to the default language, never to a `500`.
- **`appendHeader('Vary', …)` on a response that already carries `Vary` from CORS** → the
  integration test asserts the combined header has both tokens.
- **The browser-safe test passes vacuously if the probe's import resolves the barrel instead of the
  subpath** → the probe asserts `typeof Deno === 'undefined'` after deletion AND asserts the
  imported module's export set is exactly the subpath's three functions and no plugin symbol.
- **A `MessageCatalogue` value typed `LocalizationMessage` admits `{ other }` with extra keys at
  compile time only through an index signature** → the validator checks keys at `register()`, so a
  catalogue built from JSON is caught where a type cannot see it.

## 9. Out of scope

- Full-stack template wiring (`setu new --template full-stack` emitting the plugin and the loader
  recipe) — M101g, which owns that template.
- ICU MessageFormat (`select`, nested plural, `offset`, per-placeholder format options) — a
  follow-on milestone once the catalogue shape has a consumer.
- Translation tooling: key extraction from source, `.po`/`.xliff`/`.arb` import — a CLI milestone.
- `Intl.Collator` sorting, `Intl.RelativeTimeFormat`, right-to-left layout helpers.
- Per-tenant catalogue overrides as a mechanism — documented as a tenant-selected private-use tag
  (`en-GB-x-acme` as its own supported locale).
- A `@Locale()` decorator in `decorator-plugin` — the application's `Custom('locale')` resolver is
  two lines and `decorator-plugin` may not import this plugin.
- ETag/conditional requests on the catalogue route.

## 10. Design security review

**Inputs that cross the trust boundary.** `Accept-Language` (any client), the `locale` query
parameter (any client), the `setu_locale` cookie (any client), and the `:locale` route parameter
(any client). Catalogue contents are deployment configuration, not network input.

| Threat                                                                              | Control                                                                                                                    | Negative control (observed failing without the control)                                                          |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Oversized `Accept-Language` costs CPU per request                                   | Slice to 1024 bytes before splitting; at most 16 ranges; 35-byte range cap (§3.3).                                         | A 64 KiB header: parse yields ≤16 ranges, measured constant-time against a 100-byte header within noise.         |
| Malformed tag reaches `Intl.getCanonicalLocales` and throws into the pipeline       | Every canonicalization is inside a guard that answers "no match"; the middleware never throws on input (§3.2).             | `'en_US'`, `''`, 40 `x`s, and a NUL-bearing tag each resolve to the default with no rejection escaping `next()`. |
| An unconfigured locale is selected, making `Intl` fall back to the server's default | Candidates match only against `supportedLocales`; an unmatched candidate never reaches `Intl` (§3.2, §3.6).                | `Accept-Language: tlh` resolves the default, and `format` is never called with `tlh`.                            |
| Header injection through `Content-Language`                                         | The value written is a tag from `supportedLocales` — configuration — never the request's text.                             | `?locale=en%0D%0AX-Injected:1` resolves the default; the response carries no `X-Injected` header.                |
| The catalogue route enumerates or echoes attacker input                             | `:locale` is matched against the supported set; a miss answers a FIXED `404` detail with no echo (§3.8).                   | `GET /i18n/<script>` body contains neither `<` nor the parameter.                                                |
| Catalogue values execute or render unescaped                                        | The formatter substitutes text and never evaluates; escaping is the rendering runtime's (§3.6), stated in three doc sites. | `format('{x}', { x: '<b>' })` is `<b>` (pinned) and the `ViewPlugin` integration renders it as `&lt;b&gt;`.      |
| A second middleware overwrites the resolved locale silently                         | `IRequest.locale` is sealed: a second implicit write throws naming `replaceLocale` (§3.1).                                 | Two `localeMiddleware` instances with `replaceLocale` swapped for assignment: the second request throws.         |
| Cache poisoning across locales                                                      | `localeSegment` in the cache key by default (§3.10); `Vary: Accept-Language` on every governed response (§3.7).            | Reverting `localeSegment`: the `cache-vary` integration test serves the `de` body to the `en` request.           |

**Not a control, stated so it is not mistaken for one:** the cookie and query sources are preference
channels, not authentication — anyone can set them, and all they can select is one of the configured
locales.
