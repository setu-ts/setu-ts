# Milestone 94c — CSRF Token Field (`@setu-ts/session-plugin`)

> **Status:** Planning. Branch: `feat/m94c-csrf-token-field`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Add `csrfTokenField`, a `session-plugin` helper that mints the existing synchronizer token and
returns the complete hidden HTML input a server-rendered form submits. It owns no verification
policy and introduces no plugin dependency: a handler calls it after the session middleware has
loaded the session. Direct HTML responses interpolate its trusted generated markup;
escape-by-default Hono templates must wrap it in their existing `raw()` opt-out. Documentation will
make the global behavior of `SessionPlugin({ csrf: {} })` visible where users learn the helper.

- **In scope:** The exported `csrfTokenField(ctx, options?)` helper; safe HTML attribute rendering;
  use of the existing CSRF token minting path; barrel, README, `PUBLIC_API.md`, `ARCHITECTURE.md`,
  roadmap, status, and changelog documentation; unit and real-app integration coverage.
- **NOT this milestone:** Multipart form-body parsing and multipart token verification are 94b;
  automatic injection into a view engine is deliberately not added because `view-plugin` may not
  import this package; changing the global CSRF middleware registration or its `exclude` policy is
  outside M94c.

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                            | Verified surface / fact                                                                                                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRequestContext`                        | `packages/common/src/http.ts:269-309`                                                         | A per-request context supplies `services`, `state`, request, and response; `csrfTokenField` accepts this same handler context and keeps no global state.                                                                                                                         |
| `getCsrfToken`                           | `packages/session-plugin/src/csrf/token.ts:35-71`                                             | It loads the current session, returns a pre-existing token unchanged, otherwise obtains 32 random bytes through `CAPABILITIES.RUNTIME`, base64url-encodes them, stores them under `CSRF_SESSION_KEY`, and dirties the session for response commit.                               |
| `CsrfFormOptions.fieldName` and resolver | `packages/session-plugin/src/options.ts:59-80`, `:221-241`                                    | `fieldName` is the configurable form carrier and defaults to `'_csrf'`; `resolveCsrfConfig` is the single owner of that default.                                                                                                                                                 |
| CSRF plugin registration                 | `packages/session-plugin/src/plugin/session-plugin.ts:119-129`                                | Providing `options.csrf` always registers `csrfFormMiddleware` at priority 275; it is global rather than route-local.                                                                                                                                                            |
| Existing public barrel                   | `packages/session-plugin/src/index.ts:43-46`                                                  | Existing CSRF public surface is exported from the package barrel, which is where the helper must be exported.                                                                                                                                                                    |
| View-package boundary                    | `packages/view-plugin/deno.json:8-13`, `packages/view-plugin/src/index.ts:17-27`              | View plugin imports common, runtime, testing, decorator, and Hono dependencies; it has no session-plugin dependency. The helper belongs to session-plugin so view engines and application code can consume it without a forbidden plugin-to-plugin import.                       |
| Hono template escaping                   | `packages/view-plugin/README.md:108-128`, `packages/view-plugin/src/html.ts:1-8`              | The default Hono rendering arms escape interpolated strings; `raw()` is the documented application-level opt-out for intentionally generated markup. Session-plugin must return a dependency-free string and document wrapping it with `raw()` when used inside those templates. |
| Real form sequence                       | `packages/session-plugin/test/integration/documented-csrf-sequence.test.ts:44-67`, `:119-144` | A real app already proves the safe request mints a session token and an urlencoded form field plus cookie lets the protected POST run. The revised integration test can exercise the helper at the same surface.                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                 | Doc deliverable (same PR)                                                           |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C1 | No contradiction found after checking `ROADMAP.md` M94c, `ARCHITECTURE.md` session-plugin row, and the SessionPlugin sections of `PUBLIC_API.md`; the latter two merely omit the planned helper. | Preserve the committed source behavior: CSRF remains globally registered when `csrf` is present, and document that behavior next to the helper rather than presenting it as route-local. | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, and `packages/session-plugin/README.md`. |

## 3. Design decisions

### 3.1 Render one complete field through the existing token path

- **Decision:** Add
  `csrfTokenField(ctx: IRequestContext, options: Pick<CsrfFormOptions, 'fieldName'> = {}): string`
  in `src/csrf/token.ts`. It calls `getCsrfToken(ctx)` exactly once, resolves `options.fieldName`
  through `resolveCsrfConfig` so the default has one source, and returns exactly
  `<input type="hidden" name="…" value="…">` with no trailing text or wrapper. It returns a
  dependency-free string; it does not import a view runtime or manufacture a view-runtime
  safe-string type.
- **Why:** The form needs the same token that `verifyCsrfToken` reads from session data; delegating
  to `getCsrfToken` preserves mint-once, dirty-on-mint behavior rather than creating a second token
  path. The narrow structural options shape supports a customized configured field name without
  implying that header, ignored-method, or exclusion options affect HTML rendering. The string
  boundary keeps the plugins independent; applications using Hono's escaping template path
  explicitly call the documented `raw()` at their own rendering boundary.
- **Test home:** `test/unit/csrf/csrf.test.ts` asserts the exact default field, stable minted value,
  customized field name, and one minting path; `test/integration/documented-csrf-sequence.test.ts`
  submits the rendered field through a real app.

### 3.2 Escape the application-configured field name as an HTML attribute

- **Decision:** Escape `&`, `<`, `>`, `"`, and `'` in the `name` attribute before interpolation. The
  token value is emitted from the existing base64url token generator, whose character set excludes
  those delimiter characters; it is not re-encoded or transformed.
- **Why:** `fieldName` is application configuration but the helper emits HTML, so a malformed
  configured name must not break its attribute boundary. The token must retain its exact value
  because the verifier uses timing-safe equality against the stored token.
- **Test home:** `test/unit/csrf/csrf.test.ts` passes a delimiter-containing field name and asserts
  the literal escaped field while also asserting that the token value remains unchanged.

### 3.3 Keep CSRF enforcement and plugin boundaries unchanged

- **Decision:** `csrfTokenField` is a pure rendering convenience around an existing request-scoped
  token. It neither verifies tokens nor registers middleware, creates no capability token, and
  imports no other plugin. The documentation will state that `SessionPlugin({ csrf: {} })` globally
  protects unsafe methods, so forms still need the safe-render-then-submit sequence; it will also
  show `raw(csrfTokenField(ctx))` in an escaping Hono template while plain `ctx.response.html`
  composition interpolates it directly.
- **Why:** M94c owns form ergonomics, not the verifier or middleware composition. Keeping that
  boundary means framework applications may use plain strings, Hono JSX, Hono HTML, or a custom view
  engine without coupling plugins, and makes the escaping opt-out an explicit application decision.
- **Test home:** `test/integration/documented-csrf-sequence.test.ts` uses the barrel-exported helper
  in a `SessionPlugin({ csrf: {} })` application, verifies the generated field can be submitted
  successfully, and retains the bare-POST `403` control.

## 4. Exported surface — every symbol names its consumer

| Exported symbol  | Kind     | Consumer / real code path that READS it                                                                                                                                                     |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csrfTokenField` | function | An application GET handler rendering an HTML form calls it; the browser submits its `name=value` field and `csrfFormMiddleware` reads the same configured form field on the protected POST. |

### 4.1 Options — every option names its consumer

| Option              | Consumer         | Behavior (per implementation)                                                                                                                                                                |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `options.fieldName` | `csrfTokenField` | Resolved via `resolveCsrfConfig` and emitted as the escaped hidden-input `name`; callers pass the same field name used by their CSRF middleware configuration when deviating from `'_csrf'`. |

## 5. Implementation files

| File                                                                        | Purpose                                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/src/csrf/token.ts`                                 | Add the documented helper, attribute escaping, and the narrow field-name options use while retaining `getCsrfToken` as the sole minting implementation.   |
| `packages/session-plugin/src/index.ts`                                      | Re-export `csrfTokenField` from the package’s CSRF surface.                                                                                               |
| `packages/session-plugin/test/unit/csrf/csrf.test.ts`                       | Cover exact output, minting/stability, custom-name behavior, and HTML-attribute escaping.                                                                 |
| `packages/session-plugin/test/integration/documented-csrf-sequence.test.ts` | Render the barrel helper in a real app, parse its generated hidden field, and submit it with the committed session cookie.                                |
| `test/package-readme-fence-compiler.test.ts`                                | Update the pinned SessionPlugin README fence inventory so the documentation gate compiles the added escaping-template example.                            |
| `packages/session-plugin/README.md`                                         | Replace hand-built token-input examples with the helper, show `raw()` for an escaping Hono template, and state the global `csrf` composition consequence. |
| `PUBLIC_API.md`                                                             | Add `csrfTokenField` to the SessionPlugin export table and show its direct HTML and escaping-template use plus the global-CSRF composition fact.          |
| `ARCHITECTURE.md`                                                           | Add `csrfTokenField` to the SessionPlugin public API description without altering the documented priority ordering.                                       |
| `ROADMAP.md`                                                                | Mark 94c complete only after implementation verification, while preserving 94b as unfinished.                                                             |
| `CLAUDE.md`                                                                 | Add the completed M94c status entry and update the next-milestone pointer consistently with the roadmap.                                                  |
| `CHANGELOG.md`                                                              | Record the additive helper and the documentation of existing global-CSRF behavior.                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                   | src covered                                                                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/session-plugin/test/unit/csrf/csrf.test.ts`                       | `packages/session-plugin/src/csrf/token.ts`                                         | `csrfTokenField(ctx)` returns the exact default hidden input using the minted `getCsrfToken(ctx)` value; `csrfTokenField(ctx, { fieldName: 'authenticity_token' })` uses that name; delimiter characters are attribute-escaped and the base64url token stays exact. |
| `packages/session-plugin/test/integration/documented-csrf-sequence.test.ts` | `packages/session-plugin/src/index.ts`, `packages/session-plugin/src/csrf/token.ts` | A kernel application imports `csrfTokenField` from the package barrel, renders it on a safe request with `SessionPlugin({ csrf: {} })`, and a subsequent urlencoded POST with the response cookie succeeds; the no-prior-safe-request control still returns `403`.  |
| `test/package-readme-fence-compiler.test.ts`                                | `packages/session-plugin/README.md`                                                 | The SessionPlugin README has eleven expected compilable Setu fences, including the Hono escaping-template `raw(csrfTokenField(ctx))` example, and every fenced example still compiles.                                                                              |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m94c-csrf-token-field, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Before milestone completion, run the required forbidden-construct audit against
`packages/session-plugin/src`, run `deno task publish:check` and
`deno task release:verify <version>` on the committed tree, and use a production-default kernel-app
probe that renders then submits the helper’s field.

## 8. Risks & mitigations

- A helper could generate a new token different from the stored one → delegate only to
  `getCsrfToken` and exercise render then protected submit against one real application session.
- A custom field name could escape the HTML attribute and invalidate the markup → attribute-escape
  every delimiter and test a deliberately hostile configuration string.
- Documentation could imply route-local CSRF while plugin registration is global → document the
  verified registration condition and retain a bare protected-POST refusal test.
- A barrel-only export could be forgotten by API documentation → test the package-barrel import,
  update both export inventories, and run the documentation check with the normal gates.
- A Hono template could escape the helper into visible text → show the source-verified
  `raw(csrfTokenField(ctx))` composition in docs and keep the helper independent of the view
  package.
- The README fence inventory could drift when documentation adds a compilable example → update its
  pinned count and run the repository fence-compiler test.

## 9. Out of scope

- Parsing multipart bodies and accepting their CSRF token fields belongs to 94b’s shared
  `IRequest.formData?()` work.
- A Hono JSX component, automatic form transformation, or any `view-plugin` import belongs to no
  part of M94c; applications insert this string into the rendering mechanism they already chose and
  use that mechanism's explicit raw-markup escape hatch when it escapes interpolations.
- Changing default CSRF enablement, token lifetime, verification order, headers, method exemptions,
  and path exclusions remains existing SessionPlugin behavior rather than a M94c change.
