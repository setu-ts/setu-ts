# Milestone 142 — Page actions in the module generator (`@setu-ts/cli`)

> **Status:** In progress — reopened 2026-11-20 and expanded (§0.1, §3.7–§3.15). §3.1–§3.6 are
> implemented on the branch (commits `a119042af`…`f17c16474`). Branch: `feat/m142-page-actions`.
> `main` and `develop` are protected — all work (implementation + fixes) stays on this one branch
> until it merges via a single PR into `develop`.

## 0. Objective & scope

`setu g module <name> --page` in a full-stack project writes a page that reads through a `loader`
and has no `action`, beside `/api/<name>` routes. The only write path Setu teaches for a page is a
browser `fetch` to a kernel route. This milestone makes the generated page write through its own
React Router `action`, calling the same request-bound service as its `loader`. It makes the `/api`
routes opt-in for a page module (`--api`), and moves the module's one input rule into the service so
the action and the API never duplicate it. The boundary is the module schematic, its flag handling,
its generated tests, the agent brief rule and the CLI docs. §0.1 widens it to the framework
packages, the template, the example app and the docs.

- **In scope:**
  - in `packages/cli/src/schematics/module-full-stack.ts`: the page (`loader` + `action` + form),
    the service's `parse`, the controller calling `parse`, the e2e test per flag combination, and
    the session support helper gaining a signed-in session;
  - in `packages/cli/src/commands/generate.ts`: the `--api` flag (help, validation, guidance);
  - the `full-stack` agent brief rule in `packages/cli/src/agents/rules.ts`;
  - `docs/cli.md`, `CHANGELOG.md` and `docs/upgrading.md`.
- **NOT this milestone:**
  - a separate `setu g page` schematic;
  - migrating Mohor's pages (done by hand on published 0.13.0, 2026-11-19/20; it is the evidence for
    §0.1);
  - generating a `pagePolicies` entry in `setu.config.ts`, which the CLI does not write (§3.5).

### 0.1 Expansion (2026-11-20)

**Why reopened.** Migrating Mohor (built on 0.12.0 by an agent following Setu's templates, docs and
brief) to page actions showed the generator was one of several things that teach a full-stack
application to build a JSON API for its own pages. Each gap below sent Mohor to an `/api` route:

| A page needed…                    | What Setu offered                                                                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| a service refusal with its status | none: an `HttpError` thrown in a loader or action answers 500 and the template logs it as a fault                 |
| an in-page form error             | nothing; Mohor wrote its own `pageAction` helper                                                                  |
| a file upload in an action        | the upload is taught only as kernel middleware (`createUploadMiddleware` + `getUploadedFile`)                     |
| a download, an image, a PDF       | no guidance that a resource route returns any `Response`                                                          |
| an AI chat stream                 | `docs/ai.md`'s recipe is a kernel `router.post('/chat')`                                                          |
| sign-out                          | the template ships none; the auth plugin's `POST /auth/logout` is a browser form route listed as an API operation |
| tests and scripts driving pages   | `app.inject()` for JSON routes; nothing for a page action or loader data                                          |
| an example to copy                | the template's and `apps/full-stack`'s products page only read; writes are shown through `/api/products`          |

**Expanded objective.** A full-stack page never needs the application's own `/api` routes: it writes
through its action, serves files and streams from resource routes, keeps a service refusal's status,
signs out through an action, and the template, the example app, the generated tests, `setu check`,
the docs and the agent brief all teach it. `/api` stays for callers outside the app.

**Added to scope:**

- `packages/react-router-plugin`: `serviceCall` and `pageAction` (§3.7, §3.8), README section.
- `packages/auth-plugin`: its browser sign-in routes and its RFC 9728 metadata route leave the
  OpenAPI document (§3.11).
- `packages/cli`: the full-stack template (products action, sign-out action; §3.10), `setu check`
  `setu.W007` (§3.12), the generated `test/support/pages.ts` (§3.13), the brief sentence extended
  (§3.14).
- `apps/full-stack`: the example upgraded the same way, with a download (§3.15).
- Docs: a new `docs/pages.md` guide, a full-stack section in `docs/ai.md`, `PUBLIC_API.md`,
  `CHANGELOG.md`, `docs/upgrading.md` (§3.14).

**Still not this milestone:** the OpenAPI-document defects V13-56…V13-65 (response media types,
multipart, Swagger with a session cookie, schema hoisting, one document per app, header credentials,
the Bearer challenge on key-only routes, `/mcp`); migrating Mohor (done by hand on published 0.13.0,
2026-11-19/20); a `setu g page` schematic.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                                                                                                                                                | Verified surface / fact                                                                                                                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-stack module schematic          | `packages/cli/src/schematics/module-full-stack.ts:340-379`                                                                                                                                                                        | `generateFullStackModule(names, { runtime, modules?, page? })` always writes `<kebab>.controller.ts`, and writes the index with families `{ controller: [kebab], [MODULE_SERVICE_ARTIFACTS]: [kebab] }`; the page only with `page` |
| Generated page                       | `module-full-stack.ts:197-235`                                                                                                                                                                                                    | `middleware = [requireUser]`, a `loader` calling `getService(context, TOKEN).list()`, no `action`; imports only the type and the token from `~kernel/*`                                                                            |
| Generated controller                 | `module-full-stack.ts:138-195`                                                                                                                                                                                                    | `/api/<kebab>` GET list, GET `:id`, POST, PATCH; its own `inputOf` rule ("A non-empty name is required.")                                                                                                                          |
| Generated service                    | `module-full-stack.ts:62-122`                                                                                                                                                                                                     | `list`, `get`, `create(input)`, `update(id, input)` over an in-memory `Map`; no validation                                                                                                                                         |
| Generated e2e test                   | `module-full-stack.ts:270-322`                                                                                                                                                                                                    | `fetch`es `/api/<kebab>` with `signedSession` headers (cookie + `x-csrf-token`), checks 201, read-back, and 403 without the token                                                                                                  |
| Session support helper               | `module-full-stack.ts:244-268`                                                                                                                                                                                                    | `signedSession(baseUrl)` GETs `/login`, keeps the cookie and the `_csrf` field; it does not sign in                                                                                                                                |
| E017 page imports                    | `packages/cli/src/diagnostics/page-imports.ts` (`page-kernel-value-import`, `ids.ts:25`); `module-full-stack.ts:129-133` (token comment)                                                                                          | a page may value-import only `*.token.ts` from `~kernel/*` (types by `import type`); so a page cannot import a kernel validator function                                                                                           |
| `--page` flag handling               | `packages/cli/src/commands/generate.ts:158, 252-254, 495-505, 523-572, 587, 787-789`                                                                                                                                              | help line; refused for a schematic other than `module`, without `react-router-plugin`, in class-based mode; collision checks; passed as `{ page: true }`; the "add to APP_NAV" hint                                                |
| Template CSRF helper                 | `packages/cli/src/templates/full-stack-app-files.ts:304` (`app/server/session.server.ts`), used by the login page at `:613-626`                                                                                                   | `getCsrfToken(context: AppLoadContext): string`; the login form posts it as `_csrf`                                                                                                                                                |
| Template login                       | `full-stack-app-files.ts:641-657` (login `action`)                                                                                                                                                                                | a placeholder: any non-empty email signs in (`session.regenerate()`, `userEmail`), redirects to `/products`                                                                                                                        |
| Session regeneration rotates CSRF    | `docs/upgrading.md` "Security defaults (M140a)": "Fetch a fresh form-CSRF token after session regeneration, including sign-in"                                                                                                    | a signed-in test must re-read the token after posting `/login`                                                                                                                                                                     |
| Page policies (M141)                 | `packages/react-router-plugin/src/interfaces/index.ts` `PagePolicy` (`middleware`, `on?: 'action' \| 'all'`); keyed by React Router route id                                                                                      | the generated page's comment can name its route id for `pagePolicies`                                                                                                                                                              |
| Route id of a generated page         | `app/routes.ts` in the template: `flatRoutes({ rootDirectory: 'routes/_app' })` (`full-stack-app-files.ts:20-35`)                                                                                                                 | `app/routes/_app/<kebab>._index.tsx` has id `routes/_app/<kebab>._index`; **confirmed by the implementation in the built manifest** (§6), not assumed                                                                              |
| Index derivation for `setu sync`     | `packages/cli/src/seams/modules.ts:100-135`                                                                                                                                                                                       | the index's controller entries come from scanned `*.controller.ts` files, so a module with no controller file gets no controller entry                                                                                             |
| Inactive-module rule                 | `packages/cli/src/diagnostics/diagnose.ts:259-266` (`setu.E009`)                                                                                                                                                                  | a module counts as active when the modules barrel activates its symbol; it does not require routes, so a page-only module passes                                                                                                   |
| Existing tests for this schematic    | `packages/cli/test/unit/schematics/module-full-stack.test.ts`; `test/e2e/full-stack-modules-e2e.test.ts:29-58`; `test/e2e/scaffold-runs-e2e.test.ts:366-373`; `test/unit/generated-guidance.test.ts`                              | the e2e test asserts "page + API read back one service"; the scaffold test runs `g module articles --page` and the project's gates                                                                                                 |
| Agent brief rule                     | `packages/cli/src/agents/rules.ts:130, 136` (`full-stack`, `full-stack-workers`)                                                                                                                                                  | says loaders resolve services with `getService`; nothing about writes                                                                                                                                                              |
| CLI docs                             | `docs/cli.md:436-437`                                                                                                                                                                                                             | describes `--page` as a `requireUser` page whose loader reads the service                                                                                                                                                          |
| React Router errors, resource routes | `react-router` 8.5.1 `dist/development/lib/server-runtime/server.js:325-360` (`handleResourceRequest`)                                                                                                                            | a thrown `Response` is returned as is, unlogged; a thrown route error response (`data()`) calls `handleError` and becomes JSON; any other throw is logged and answers 500                                                          |
| React Router errors, page requests   | `server.js:246-249` (document) and `single-fetch.js:64,117` (`.data`): `if (!isRouteErrorResponse(err) \|\| err.error) handleError(err)`                                                                                          | a `Response` thrown from a page loader or action becomes a route error response with its status and is NOT passed to `handleError`; only internal errors (an unmatched URL's 404, an unexpected throw) are                         |
| React Router range in the template   | `packages/cli/src/templates/full-stack-build-files.ts:28` (`REACT_ROUTER_RANGE = '^8.0.0'`); `react-router@8.0.0` tarball `dist/production/index.d.ts`                                                                            | `UNSAFE_decodeViaTurboStream` is exported from 8.0.0 (checked in the published 8.0.0 tarball) to 8.5.2 (latest at plan time), so §3.13's decoder exists across the template's range                                                |
| Plugin error handling                | `packages/react-router-plugin/src/handler/*` (no `HttpError` or status-hint handling; `get-service.ts` only)                                                                                                                      | nothing maps a service refusal thrown in a loader or action                                                                                                                                                                        |
| Template `handleError`               | `packages/cli/src/templates/full-stack-app-files.ts:162-181`                                                                                                                                                                      | logs every route error React Router passes it, except a 404; with the row above, a refusal thrown as a `Response` never reaches it, so it needs no change (§3.9)                                                                   |
| Status hints                         | `packages/common/src/errors/status-hint.ts:175` (`httpStatusHintOf`); `packages/exceptions/src/middleware/error-responder-impl.ts:38`                                                                                             | an `HttpError` carries `statusCode`, not a hint; the error responder checks both, as `serviceCall` will                                                                                                                            |
| Problem Details shape                | `packages/exceptions/src/formatters/rfc9457-formatter.ts:1-30`, `problem-details.ts`                                                                                                                                              | `type`, `title`, `status`, `detail`, `instance` (request path)                                                                                                                                                                     |
| Plugins depending on `exceptions`    | `packages/auth-plugin/package.json`, `packages/mcp-plugin/package.json`                                                                                                                                                           | a plugin may depend on `@setu-ts/exceptions` (not a plugin); `react-router-plugin` today depends only on `common`                                                                                                                  |
| Auth sign-in routes                  | `packages/auth-plugin/src/sign-in/routes.ts:284` (login), `:409` (callback), `:566` (`registerLogout`, `POST <basePath>/logout`)                                                                                                  | registered without a `schema`, so the OpenAPI document lists them                                                                                                                                                                  |
| Protected-resource metadata route    | `packages/auth-plugin/src/resource-server/metadata-route.ts:30` (`router.get(compiled.metadataPath, …)`); path built in `resource-server/config.ts:126`                                                                           | registered without a `schema`, so the OpenAPI document lists `/.well-known/oauth-protected-resource…`                                                                                                                              |
| Excluding one route                  | `packages/common/src/http.ts:578` (`RouteSchema.excludeFromDocument`)                                                                                                                                                             | a route can leave the document from its own definition                                                                                                                                                                             |
| `setu check` ids and page scan       | `packages/cli/src/diagnostics/ids.ts:5-28` (last warning `setu.W006`); `page-imports.ts` (scans `app/` for E017)                                                                                                                  | a new warning takes `setu.W007` and reuses the `app/` file walk                                                                                                                                                                    |
| AI recipe                            | `docs/ai.md:85-110` (`registerChatRoutes`, `router.post('/chat', …)` writing through `ctx`)                                                                                                                                       | teaches the stream as a kernel route only                                                                                                                                                                                          |
| Example app                          | `apps/full-stack/app/routes/_app/products._index.tsx` (loader only), `src/modules/products/products.controller.ts:16` (`/api/products`), `smoke.ts:53-170` (drives `/api/products`); `package.json` `check:apps`, `check:browser` | the example reads on its page and writes only through the API; it has no sign-out                                                                                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                       | Resolution (picked side)                                                      | Doc deliverable (same PR)                                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| C1  | `docs/cli.md:436` and the schematic's header comment (`module-full-stack.ts:1-13`) describe the module as `/api/<name>` routes plus an optional read-only page | the new behaviour: `--page` writes an action and no controller unless `--api` | `docs/cli.md` "generate module" section and the schematic header rewritten; the help text |
| C2  | The generated controller comment says browser code sends the token in `x-csrf-token`, implying pages call it                                                   | the controller is for callers outside the app; pages post their action        | the controller's comment                                                                  |

No other conflict found (checked ROADMAP M130/M141, the full-stack agent brief rule and
`docs/cli.md`).

## 3. Design decisions

### 3.1 `--page` writes an `action`

- **Decision:** the page module exports:
  - `loader`: returns `{ items, csrfToken }`, adding `getCsrfToken(context)` from
    `~/server/session.server.ts`.
  - `action({ request, context })`:
    1. reads `request.formData()` and calls `service.parse({ name: form.get('name') })`;
    2. on a string result, returns `{ error }` (HTTP 200, rendered by the page);
    3. otherwise calls `service.create(parsed)` and returns `redirect('/<kebab>', 303)`.
  - The default component renders the list and a `<Form method="post">` with a hidden `_csrf` field,
    a `name` input, a submit button and `useActionData` for the error.

  `requireUser` (the existing `middleware` export) covers the action too.

- **Why:** this is React Router's own write path (document POST without JavaScript; fetch with it),
  so no browser code calls a kernel route. The redirect is post/redirect/get, so a reload does not
  resubmit.
- **Test home:** `module-full-stack.test.ts` (page contents per option);
  `full-stack-modules-e2e.test.ts` (the action creates a record the page then shows).

### 3.2 `--api` makes the controller opt-in on a page module

- **Decision:** a new boolean flag `--api`:

  | Command                   | Controller (`/api/<kebab>`) | Page |
  | ------------------------- | --------------------------- | ---- |
  | `g module x`              | yes (unchanged)             | no   |
  | `g module x --page`       | **no**                      | yes  |
  | `g module x --page --api` | yes                         | yes  |

  `--api` without `--page` is refused with "--api applies with --page: a module without a page is
  already reached through its /api routes." It is refused where `--page` is refused (not a module,
  no `react-router-plugin`, class-based), because it requires `--page`.

  With no controller, the module index is written with only the service family, so the module
  registers its token and no routes. Of the existing collision checks:
  - the refusal while adopting a same-named controller (`generate.ts:523-541`) still runs, because
    that controller's routes would still shadow the page;
  - the "kernel routes `<base>` and `<base>/:id` would take precedence" check
    (`generate.ts:543-558`) runs only when a controller is written, because otherwise there are no
    kernel routes;
  - the existing-page refusal (`generate.ts:561-572`) still runs.

- **Why:** an SSR page module needs no JSON API, and an unused API is attack surface someone must
  secure (the controller comment already warns it is not behind sign-in). The flag name follows
  Laravel and AdonisJS (`--api`). The non-page default is unchanged, because without a page the API
  is the module's only entry point.
- **Test home:** `module-full-stack.test.ts` (file list per combination); a generate-command test
  for the refusal; the e2e test for both page combinations.

### 3.3 One input rule: `service.parse`

- **Decision:** the generated `<Pascal>Service` gains
  `parse(value: { readonly name?: unknown }): <Pascal>Input | string`. It returns `{ name }` with
  the name trimmed, or the message "A non-empty name is required." when `name` is not a string or is
  empty after trimming. The API therefore stores a trimmed name where it stored the raw string
  before; the CHANGELOG entry says so.
  - The action calls it through `getService`, because a page may not value-import kernel code
    (E017).
  - The controller (when written) calls it in POST and PATCH and throws `badRequest(message)` on a
    string. It no longer has its own `inputOf`.
  - `create` and `update` keep their signatures, and their JSDoc says they take parsed input.
- **Why:** with two write paths (action and API), the rule must have one home, and E017 rules out a
  shared kernel import in the page. A method on the request-bound service is the one place both can
  reach.
- **Test home:** `module-full-stack.test.ts` (both callers use `parse`); the generated unit test
  `<kebab>.test.ts` gains a `parse` case; the e2e test checks the action's error message.

### 3.4 The generated e2e test

- **Decision:**
  - `renderSessionSupport()` gains `signedInSession(baseUrl, email = 'e2e@example.test')`:
    1. GET `/login` and keep the cookie and token;
    2. POST `/login` form-urlencoded (`email`, `_csrf`), keeping the rotated cookie;
    3. GET `/login` again for the new token (sign-in regenerates the session and its CSRF token).

    It returns `{ cookie, token, headers(extra) }`. `signedSession` stays for the API test.

  - The module e2e file has one `it` per write path written:
    - **page (with `--page`):**
      - POST `/<kebab>` form-urlencoded `{ name: 'Example', _csrf }` with the cookie gives 303 with
        `location` `/<kebab>`;
      - GET `/<kebab>` HTML contains `Example`;
      - POST with an empty name gives 200 and HTML containing "A non-empty name is required.";
      - POST without `_csrf` gives 403. Form CSRF runs in the global pipeline before the page's
        `requireUser`, so this holds whether or not the request is signed in;
      - POST `/<kebab>.data` with the same form, the request a browser sends with JavaScript,
        answers below 400 and creates a record the page then shows. The test asserts the record, not
        React Router's encoded redirect body.
    - **API (with no `--page`, or with `--api`):** today's assertions, unchanged.
  - The session helper's JSDoc says the signed-in helper relies on the template's placeholder
    sign-in, and must change when the application replaces it.
  - `test/support/session.ts` is a managed file (`module-full-stack.ts:377`), so `setu sync` and the
    next `g module` rewrite it in existing projects. `signedInSession` is added beside an unchanged
    `signedSession`, so existing module tests keep passing.
  - Cloudflare Workers keeps today's split: the e2e test is generated and the service unit test is
    not (`module-full-stack.ts:364-375`). The scaffold gate covers the Workers target.
- **Why:** each generated write path gets a test that drives it through the real server, as today's
  API test does.
- **Test home:** `module-full-stack.test.ts` (rendered test per combination); the generated tests
  run in `full-stack-modules-e2e.test.ts` and `scaffold-runs-e2e.test.ts`.

### 3.5 Pointing the page at `pagePolicies`

- **Decision:** the action's JSDoc says that a rate limit, upload check or other route guard for
  this action is a page policy keyed `'routes/_app/<kebab>._index'` in `setu.config.ts`, with
  `on: 'action'`. The key is written as a literal, because `setu check` cannot read a computed key
  (V13-7). Nothing is written to `setu.config.ts`.
- **Why:** the CLI does not edit the application's config for a policy the application has not
  chosen. The comment carries the one non-obvious fact, the route id.
- **Test home:** `module-full-stack.test.ts` (the page names its route id).

### 3.6 Guidance, brief and docs

- **Decision:**
  - The `--page` help line in `generate.ts:158` gains `--api`.
  - The "add to APP_NAV" hint is unchanged.
  - The `full-stack` and `full-stack-workers` brief rules gain one sentence: "Pages write through
    their own `action` (a `<Form>` or `useFetcher`), guarded with `pagePolicies`. Write an `/api`
    route only for callers outside the app (`g module --page --api`)." It must keep the brief
    formatter-stable (M139d).
  - `docs/cli.md` describes the three combinations.
  - `CHANGELOG.md` ("Changed", `@setu-ts/cli`) and `docs/upgrading.md` ("## Unreleased", renamed to
    0.14.0 by the release bump): `--page` no longer writes `/api/<name>`, so pass `--api` for it;
    the generated API now trims the name. Existing modules are untouched.
- **Test home:** `test/unit/agents` (the rule text and its stability test);
  `generated-guidance.test.ts`.

### 3.7 `serviceCall`: a refusal keeps its status in loaders, actions and resource routes

- **Decision:** `@setu-ts/react-router-plugin` exports
  `serviceCall<T>(request: Request, work: () => Promise<T>): Promise<T>`. It returns `work()`'s
  value. When `work` throws an `HttpError` (from `@setu-ts/exceptions`, a new dependency) with a
  status below 500, or an error whose `httpStatusHintOf` is a 4xx, it throws a `Response` instead:
  - status: the error's;
  - `content-type: application/problem+json` and `cache-control: private, no-store`. No
    `Retry-After`: the common status hint carries only `status` and `detail`
    (`status-hint.ts:97-108`), and another plugin's quota error is not visible to this one. A page
    that must pass a quota's wait to the browser calls a request-bound service that writes the
    kernel's own refusal (Mohor's explanation route); `docs/pages.md` shows it;
  - body: `{ type: 'about:blank', title, status, detail, instance }`, the RFC 9457 fields the error
    handler writes, with `instance` the request's path and `title` the status's reason.

  Anything else (a 5xx, an unknown error) is rethrown untouched, so a fault stays a fault.

- **Why:** React Router returns a thrown `Response` as is from a resource route and renders it as a
  route error with its status in a page (§1), while any other throw answers 500. One wrapper covers
  a page's loader (the error boundary gets `isRouteErrorResponse(error)` with the real status), an
  action, and a resource route serving a file, an image or a stream.
- **Test home:** `packages/react-router-plugin/test/unit/service-call.test.ts` (each branch, every
  Problem Details field asserted present and no `message` field); an integration test through a real
  React Router build (a resource route and a page loader) in the plugin's existing harness.

- **Implementation note (2026-11-20):** no `@setu-ts/exceptions` dependency. Every 4xx `HttpError`
  brands itself with the common status hint in its constructor
  (`exceptions/src/errors/http-error.ts`, `withHttpStatusHint(this, { status, title, detail })`), so
  `httpStatusHintOf` alone covers both cases and the plugin keeps `common` as its only dependency
  (no duplicate-`instanceof` hazard). `type` and `title` follow the hint's `problem` when it carries
  one, as the error handler does. The real-handler test showed React Router parses only
  `application/json`, so a page boundary's `error.data` is the Problem Details JSON text;
  `docs/pages.md` says so.

### 3.8 `pageAction`: a form's refusal shown in the page

- **Decision:**
  `pageAction<T>(intent: string, work: () => Promise<T>): Promise<PageActionResult<T>>` with
  `PageActionResult<T> = { ok: true; intent; value } | { ok: false; intent; error; status }`. A
  refusal (the same two cases as §3.7) becomes `{ ok: false, error: <its detail> }`; a fault is
  rethrown. It is the shape Mohor used across six migrated areas (Mohor's
  `app/server/page-action.server.ts`).
- **Why:** an invalid form should come back to the form with its reason, not to an error page.
  `serviceCall` is for loaders and resource routes; `pageAction` is for a form's action.
- **Test home:** `service-call.test.ts` (ok, refusal, quota hint, fault rethrown).

### 3.9 (Dropped at review) The template's `handleError`

Planned to skip logging 4xx refusals. Dropped: React Router passes a page request's route error to
`handleError` only when it wraps an internal error (§1, page requests), and `serviceCall` throws a
plain `Response`, so a refusal is never logged there. The existing 404 filter stays. The scaffold
e2e run asserts no "SSR request failed" line for a refused request.

### 3.10 The template writes through actions and signs out through one

- **Decision:**
  - `products._index.tsx` gains the generated module's shape (§3.1): an `action` that reads the
    form, calls the service's `parse`, then `create` through `pageAction`, and redirects; a `<Form>`
    with the `_csrf` field. The template's products service (`full-stack-module-files.ts:41-75`) has
    only `list()` over static data today; it gains `parse` and `create` over the in-memory store the
    generated module service uses (`module-full-stack.ts:62-122`). `GET /api/products` stays as the
    template's outside-caller example, and its comment says so.
  - A new action-only route `app/routes/_app/logout.tsx` ends the session the way the template's
    placeholder sign-in starts it (`session.regenerate()` then `userEmail`,
    `full-stack-app-files.ts:651-654`): `getSession(context).clear()` then `regenerate()`
    (`common/src/services/session.ts:155,165`), and redirects to `/login`. The app layout's header
    gets a sign-out form posting to it with `_csrf`. An application on the auth plugin's sign-in
    calls its session service's `signOut(ctx)` from a request-bound service instead (Mohor);
    `docs/pages.md` shows both.
- **Why:** the template is what every project copies. Its one page must show a write, and a session
  app needs a sign-out that is a page action rather than the auth plugin's form route.
- **Test home:** the template files test (action, form, logout route, layout form); the scaffold e2e
  run (create through the page, sign out, then a protected page redirects to `/login`).

- **Implementation note (2026-11-20):** sign-out is a guarded `/logout` page (loader for the token,
  a form posting to its own action), and the layout's header only links to it. The planned layout
  sign-out form needed a layout loader, and React Router places a middleware error at the highest
  route with a loader (`router.js:1663`), so every child route's middleware refusal moved to the
  root boundary (the example's `/forbidden` smoke check caught it). The products service refuses a
  duplicate name with `conflict` in the template too, so `pageAction` has a refusal to show.

### 3.11 The auth plugin's browser and discovery routes leave the API document

- **Decision:** two route families move to the definition form with
  `schema: { excludeFromDocument: true }`, their handlers unchanged:
  - the login, callback and logout routes registered by `sign-in/routes.ts`
    (`router.get(path, flowRoute(...))` today);
  - the RFC 9728 protected-resource metadata route registered by
    `resource-server/metadata-route.ts:30` (`router.get(compiled.metadataPath, handler)` today;
    `/.well-known/oauth-protected-resource` plus the resource's path).
- **Why:** the sign-in routes are browser redirects and a form post with a session cookie, not API
  operations; in the document they read as callable endpoints no API client can use. The metadata
  document is found by a client from the `resource_metadata` parameter of a `401`'s
  `WWW-Authenticate` header or at its well-known address (RFC 9728 §3, §5), never from the
  application's OpenAPI document, so listing it there only adds an operation that is not the
  application's API. (Corrected 2026-11-20: the first version of this section kept it listed.)
- **Test home:** `packages/auth-plugin/test/unit/sign-in-routes-document.test.ts` (the three sign-in
  definitions and the metadata route carry the flag); an OpenAPI-plugin-composed test that the
  document lists no `/auth/*` and no `/.well-known/*` path, while the metadata route still answers
  its document and a `401` still names it in `WWW-Authenticate`.

### 3.12 `setu check` warns when a page fetches its own `/api`

- **Decision:** a new warning `setu.W007` (`page-fetches-own-api`): a module under `app/` that calls
  `fetch()` with a first argument that is a string or template literal starting `/api/`. The finding
  names the file and line and says: "a page writes through its action and reads through its loader;
  `/api` routes are for callers outside the app". Silenceable through `.setu-ts/check.json` like
  every warning. Absolute URLs, other paths, comments and strings not passed to `fetch` are not
  findings. It reuses E017's pipeline in `page-imports.ts` (esbuild `transform` to JavaScript, then
  `maskComments`), not a new parser, and a template literal's `${…}` substitutions are scanned as
  code, not as the path (the past defect class "a regex scanner that reads JS source must scan
  template substitutions as code").
- **Why:** it is the pattern this milestone exists to remove, and an agent following a stale example
  writes it first. A warning, not an error: a page may legitimately call an API it also publishes.
- **Test home:** `packages/cli/test/unit/diagnostics/page-fetch.test.ts` (positives: string and
  template literal; negatives: absolute URL, `/apis`, comment, a non-`fetch` call, a silenced
  finding); `setu check` on a scaffold stays at 0 warnings.

- **Implementation note (2026-11-20):** `maskComments` refuses any template literal, so it cannot
  scan a template's substitutions at all. The finder is `lexApiFetches` beside `lexImportSpecifiers`
  (`utils/import-specifiers.ts`), on the same tokenizer, which reads `${…}` as code; it runs on
  esbuild's output, and each call is mapped to its source line through esbuild's source map
  (`page-fetch.ts`, `originalLineAt`). Matched hosts: bare `fetch`, `window.`, `globalThis.`,
  `self.`.

### 3.13 Generated test support for pages

- **Decision:** a managed `test/support/pages.ts` beside `session.ts`, written by `g module --page`
  like the other support files (`module-full-stack.ts:36-39, 569`; the template writes no tests, so
  it does not write this file):
  - `postForm(baseUrl, path, fields, session)`: a form-urlencoded document POST with `_csrf` and the
    cookie; returns the `Response` (a 303 for a redirecting action).
  - `pageData<T>(baseUrl, path, routeId, session)`: GET `<path>.data?_routes=<routeId>` and decode
    it with React Router's own decoder (`UNSAFE_decodeViaTurboStream` from `react-router`),
    returning the route's loader data.

  The generated module e2e test (§3.4) reads the record back through `pageData` as well as the HTML.

- **Why:** a test or script should drive a page as the browser does, not through a JSON API kept for
  the purpose (Mohor kept 11 routes for its recording scripts until it wrote these helpers).
- **Test home:** `module-full-stack.test.ts` (the file is written and managed); the scaffold e2e run
  (the generated test passes against the real server, which also proves the decoder against the
  installed `react-router`).

### 3.14 Guide, recipe, brief and notes

- **Decision:**
  - New `docs/pages.md` ("Pages that write through actions"), in `docs/README.md` and the website's
    docs nav (`website/src/lib/docs-nav.ts`): forms (`pageAction`), refusals (`serviceCall`),
    uploads (the upload middleware as a page policy, the `File` read in the action, and the
    starter's request body limit, `runtime.maxBodyBytes` with a 1 MiB default, raised to admit the
    largest upload), downloads and images as resource routes, a stream as a resource-route action
    calling a request-bound service that returns a `Response`, sign-out, and testing with
    `test/support/pages.ts`. Every code block is fence-checked.
  - `docs/ai.md` gains "From a full-stack page": the same stream served from a resource route.
  - `packages/react-router-plugin/README.md`: `serviceCall` and `pageAction`, and resource routes.
  - The brief sentence (§3.6) gains: "files, images and streams are resource routes".
  - `PUBLIC_API.md`, `CHANGELOG.md` (react-router-plugin added; auth-plugin changed; cli changed),
    `docs/upgrading.md` (the template's sign-out; `/auth/*` leaves the document).
- **Test home:** `check:docs` and the fence gate; the agents rule test.

### 3.15 The example app, upgraded

- **Decision:** `apps/full-stack` follows the template:
  - the products page creates through its action (§3.10) and shows a refusal in place: the example's
    service refuses a duplicate product name with `conflict` (a 409 `HttpError`), which `pageAction`
    turns into the form's message;
  - a resource route `app/routes/_app/products.export.tsx` downloads the list as CSV through
    `serviceCall`, linked from the page;
  - sign-out as in §3.10;
  - `smoke.ts` drives the page action (document and `.data`), the CSV download, a refused create,
    and sign-out, in place of its `/api/products` writes; one `/api/products` read stays to show the
    outside-caller path;
  - its README walkthrough says which path is which;
  - its browser harness (`check:browser`) covers creating through the form.
- **Why:** the example is what readers run; it must show the rule this milestone teaches.
- **Test home:** `pnpm run check:apps` (runs `smoke.ts`) and `pnpm run check:browser`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. New exports are additive (`react-router-plugin`). Behaviour
changes, recorded in the CHANGELOG and the upgrade notes and shipped in minor 0.14.0: `--page` alone
no longer writes a controller; the auth plugin's sign-in routes leave the OpenAPI document.

| Exported symbol                                                | Kind           | Consumer / real code path that READS it                                                                                                            |
| -------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api` (CLI flag)                                             | CLI flag       | `generate.ts` reads `args.flags['api']` and passes `api: true` to `generateFullStackModule`                                                        |
| `FullStackModuleOptions.api` (internal, not in `src/index.ts`) | option         | `generateFullStackModule` decides the controller file, index families and e2e test                                                                 |
| `serviceCall` (`react-router-plugin`)                          | function       | the template's and `apps/full-stack`'s loaders and resource routes; `docs/pages.md`                                                                |
| `pageAction`, `PageActionResult` (`react-router-plugin`)       | function, type | the template's and `apps/full-stack`'s products actions (the generated module page keeps §3.3's `parse` string result: it has no refusal to catch) |
| `setu.W007` (`page-fetches-own-api`)                           | diagnostic id  | `diagnose.ts` emits it; `.setu-ts/check.json` silences it by id                                                                                    |

### 4.1 Options — every option names its consumer

| Option | Consumer                  | Behavior (per implementation)                                                                                          |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `page` | `generateFullStackModule` | writes the page with `loader` + `action`; without `api`, writes no controller                                          |
| `api`  | `generateFullStackModule` | with `page`, also writes the controller, its index entry and the API e2e case; `generate.ts` refuses it without `page` |

## 5. Implementation files

| File                                                                                          | Purpose                                                                                                                                           |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/schematics/module-full-stack.ts`                                            | page with action and form; `parse` in the service; controller via `parse`; files and index per `page`/`api`; e2e test per path; `signedInSession` |
| `packages/cli/src/commands/generate.ts`                                                       | `--api` help, refusal without `--page`, pass-through; collision check only when a controller is written                                           |
| `packages/cli/src/agents/rules.ts`                                                            | the `full-stack` and `full-stack-workers` rule sentence                                                                                           |
| `docs/cli.md`, `CHANGELOG.md`, `docs/upgrading.md`                                            | C1, §3.6                                                                                                                                          |
| `packages/react-router-plugin/src/handler/service-call.ts` (new), `src/index.ts`, `README.md` | §3.7, §3.8 (no new dependency: the 4xx `HttpError` brand is read through `common`)                                                                |
| `packages/auth-plugin/src/sign-in/routes.ts`, `src/resource-server/metadata-route.ts`         | §3.11                                                                                                                                             |
| `packages/cli/src/templates/full-stack-app-files.ts`                                          | §3.10 (products action, logout route, layout form)                                                                                                |
| `packages/cli/src/templates/full-stack-module-files.ts`                                       | §3.10 (the products service gains `parse` and `create`)                                                                                           |
| `packages/cli/src/schematics/module-full-stack.ts`                                            | §3.13 (`pages.ts` managed file; the e2e test reads back through `pageData`)                                                                       |
| `packages/cli/src/diagnostics/page-fetch.ts` (new), `ids.ts`, `diagnose.ts`                   | §3.12                                                                                                                                             |
| `apps/full-stack/**`                                                                          | §3.15                                                                                                                                             |
| `docs/pages.md` (new), `docs/ai.md`, `docs/README.md`, website docs list, `PUBLIC_API.md`     | §3.14                                                                                                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                     | src covered                                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/schematics/module-full-stack.test.ts`                                                                 | `module-full-stack.ts`                                   | file list for `{}`, `{ page: true }`, `{ page: true, api: true }`; the index has a controller entry only with a controller; the page exports `action`, posts `_csrf`, calls `parse`, names `routes/_app/<kebab>._index`; the controller calls `parse` and has no `inputOf`; the e2e test has the page case, the API case, or both; `signedInSession` re-reads the token after `POST /login` |
| a generate-command test (existing file covering `--page` refusals, or `test/unit/commands/generate-api-flag.test.ts`)         | `generate.ts`                                            | `--api` without `--page` is refused with the §3.2 message; `--page --api` passes `api: true`; `--page` alone writes no controller and skips the shadowing check                                                                                                                                                                                                                             |
| `packages/cli/test/unit/agents/*` (the rule-text tests)                                                                       | `rules.ts`                                               | the new sentence appears in both full-stack rules; the brief stays formatter-stable                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/unit/generated-guidance.test.ts`                                                                           | `generate.ts` guidance                                   | the `--page` help line names `--api`                                                                                                                                                                                                                                                                                                                                                        |
| `packages/cli/test/e2e/full-stack-modules-e2e.test.ts` (reworked)                                                             | generated project                                        | `g module articles --page` then `check`, `build` and the generated tests pass, and a direct POST to `/articles` creates a record the page shows. `g module notes --page --api` passes the same gates, and the API and the page read back one service. `setu sync` leaves the page-only module's index without a controller entry. The built manifest names `routes/_app/articles._index`    |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (existing)                                                                  | generated project per target                             | `g module articles --page` still keeps each target formatted, checked and tested; the template's products page creates through its action, sign-out ends the session, and `setu check` reports 0 warnings                                                                                                                                                                                   |
| `packages/react-router-plugin/test/unit/service-call.test.ts` (new)                                                           | `service-call.ts`                                        | `serviceCall`: value passthrough; `HttpError` 4xx → thrown `Response` with the status, `application/problem+json`, every RFC 9457 field and no `message`; a 4xx status hint likewise (its `detail`); a 5xx and an unknown error rethrown. `pageAction`: ok, refusal `{ ok: false, error, status }`, fault rethrown                                                                          |
| `packages/react-router-plugin/test/integration/*` (existing harness)                                                          | `service-call.ts`                                        | through a real React Router build: a resource route answers the refusal's status and body unlogged; a page loader's refusal reaches the error boundary with its status                                                                                                                                                                                                                      |
| `packages/auth-plugin/test/unit/sign-in-routes-document.test.ts` (new; the sign-in tests are flat files, `sign-in-*.test.ts`) | `sign-in/routes.ts`, `resource-server/metadata-route.ts` | login, callback, logout and the metadata route carry `excludeFromDocument`; a composed document lists no `/auth/*` and no `/.well-known/*` path; the metadata route still serves its document and a `401` still names it in `WWW-Authenticate`                                                                                                                                              |
| `packages/cli/test/unit/diagnostics/page-fetch.test.ts` (new)                                                                 | `page-fetch.ts`, `diagnose.ts`                           | W007 for a string and a template literal; none for an absolute URL, `/apis/…`, a comment, a non-`fetch` call; silenced by id                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/templates/full-stack-app-files.test.ts` (existing)                                                    | `full-stack-app-files.ts`                                | the products action and form, the logout route and layout form; the products service's `parse` and `create` (`full-stack-module-files.ts`)                                                                                                                                                                                                                                                  |
| `apps/full-stack/smoke.ts` via `pnpm run check:apps`; `apps/full-stack/browser` via `pnpm run check:browser`                  | the example app                                          | §3.15: create through the page (document and `.data`), a refused create shown in place, CSV download, sign-out, one `/api/products` read                                                                                                                                                                                                                                                    |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m142-page-actions
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cli      # ANSI-stripped per-file table; ≥90% every changed src file
pnpm run ci:local --shard cli
pnpm run check:docs
pnpm test:coverage react-router-plugin auth-plugin --no-tooling
pnpm run check:apps
pnpm run check:browser
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0   # the version the packages carry on develop
```

A milestone that changes what `packages/cli` generates also boots a scaffolded project: the
full-stack scaffold with `g module --page`, and with `--page --api`, runs its own install, check,
build, generated tests and start, and answers its advertised pages.

## 8. Risks & mitigations

- **The generated sign-in helper depends on the template's placeholder login.** When an application
  replaces the login, its generated module tests fail. Mitigation: the helper's JSDoc says so, and
  the failure is a clear 303-versus-200 assertion at sign-in, not a silent pass.
- **The CSRF token rotates on sign-in.** A helper that reuses the pre-sign-in token gets 403.
  Mitigation: §3.4 re-reads the token, and the e2e test would fail first.
- **A user relying on `--page` writing `/api/<name>`.** Mitigation: the CHANGELOG and upgrade note
  name `--api`; existing modules are never rewritten (`g module` refuses an existing module).
- **The route id in the comment could differ from React Router's.** Mitigation: the e2e test reads
  the built manifest.
- **`pageData` uses React Router's `UNSAFE_decodeViaTurboStream`.** It may change in a React Router
  release. Mitigation: it lives in one generated support file; the scaffold e2e test runs it against
  the installed version, so a change fails the gate, not a user's tests silently.
- **(Retired at implementation) `react-router-plugin` gaining a dependency on
  `@setu-ts/exceptions`.** It does not: the 4xx `HttpError` brand is read through `common` (§3.7
  implementation note).
- **W007 false positives** (a page that calls an API it also publishes on purpose). Mitigation: a
  warning, silenceable by id, matching only a literal `/api/` first argument to `fetch`.
- **Hiding the auth plugin's routes from the document** could surprise someone who used Swagger to
  find them. Mitigation: the CHANGELOG and upgrade notes say so; the routes still work.

## 9. Out of scope

- A `setu g page` schematic for a page without a module.
- The OpenAPI-document defects V13-56…V13-65 (§0.1).
- Migrating Mohor's own pages to actions; that is application work after 0.14.0.
- Writing `pagePolicies` into `setu.config.ts` from the generator.
