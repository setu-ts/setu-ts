# Milestone 142 — Page actions in the module generator (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m142-page-actions`. `main` and `develop` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

`setu g module <name> --page` in a full-stack project writes a page that reads through a `loader`
and has no `action`, beside `/api/<name>` routes. The only write path Setu teaches for a page is a
browser `fetch` to a kernel route. This milestone makes the generated page write through its own
React Router `action`, calling the same request-bound service as its `loader`. It makes the `/api`
routes opt-in for a page module (`--api`), and moves the module's one input rule into the service so
the action and the API never duplicate it. The boundary is the module schematic, its flag handling,
its generated tests, the agent brief rule and the CLI docs. No framework package changes.

- **In scope:**
  - in `packages/cli/src/schematics/module-full-stack.ts`: the page (`loader` + `action` + form),
    the service's `parse`, the controller calling `parse`, the e2e test per flag combination, and
    the session support helper gaining a signed-in session;
  - in `packages/cli/src/commands/generate.ts`: the `--api` flag (help, validation, guidance);
  - the `full-stack` agent brief rule in `packages/cli/src/agents/rules.ts`;
  - `docs/cli.md`, `CHANGELOG.md` and `docs/upgrading.md`.
- **NOT this milestone:**
  - the full-stack template's own `products` example (its page only reads; `GET /api/products` stays
    as the template's demonstration that one service serves both, §9);
  - a separate `setu g page` schematic;
  - migrating Mohor's pages (an application change, done after this ships);
  - generating a `pagePolicies` entry in `setu.config.ts`, which the CLI does not write (§3.5).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                                                                                                                                   | Verified surface / fact                                                                                                                                                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-stack module schematic       | `packages/cli/src/schematics/module-full-stack.ts:340-379`                                                                                                                                           | `generateFullStackModule(names, { runtime, modules?, page? })` always writes `<kebab>.controller.ts`, and writes the index with families `{ controller: [kebab], [MODULE_SERVICE_ARTIFACTS]: [kebab] }`; the page only with `page` |
| Generated page                    | `module-full-stack.ts:197-235`                                                                                                                                                                       | `middleware = [requireUser]`, a `loader` calling `getService(context, TOKEN).list()`, no `action`; imports only the type and the token from `~kernel/*`                                                                            |
| Generated controller              | `module-full-stack.ts:138-195`                                                                                                                                                                       | `/api/<kebab>` GET list, GET `:id`, POST, PATCH; its own `inputOf` rule ("A non-empty name is required.")                                                                                                                          |
| Generated service                 | `module-full-stack.ts:62-122`                                                                                                                                                                        | `list`, `get`, `create(input)`, `update(id, input)` over an in-memory `Map`; no validation                                                                                                                                         |
| Generated e2e test                | `module-full-stack.ts:270-322`                                                                                                                                                                       | `fetch`es `/api/<kebab>` with `signedSession` headers (cookie + `x-csrf-token`), checks 201, read-back, and 403 without the token                                                                                                  |
| Session support helper            | `module-full-stack.ts:244-268`                                                                                                                                                                       | `signedSession(baseUrl)` GETs `/login`, keeps the cookie and the `_csrf` field; it does not sign in                                                                                                                                |
| E017 page imports                 | `module-full-stack.ts:129-133` (token comment); `packages/cli/src/diagnostics/` E017                                                                                                                 | a page may value-import only `*.token.ts` from `~kernel/*` (types by `import type`); so a page cannot import a kernel validator function                                                                                           |
| `--page` flag handling            | `packages/cli/src/commands/generate.ts:158, 252-254, 495-505, 523-572, 587, 787-789`                                                                                                                 | help line; refused for a schematic other than `module`, without `react-router-plugin`, in class-based mode; collision checks; passed as `{ page: true }`; the "add to APP_NAV" hint                                                |
| Template CSRF helper              | `packages/cli/src/templates/full-stack-app-files.ts:304` (`app/server/session.server.ts`), used by the login page at `:613-626`                                                                      | `getCsrfToken(context: AppLoadContext): string`; the login form posts it as `_csrf`                                                                                                                                                |
| Template login                    | `full-stack-app-files.ts:641-657` (login `action`)                                                                                                                                                   | a placeholder: any non-empty email signs in (`session.regenerate()`, `userEmail`), redirects to `/products`                                                                                                                        |
| Session regeneration rotates CSRF | `docs/upgrading.md` "Security defaults (M140a)": "Fetch a fresh form-CSRF token after session regeneration, including sign-in"                                                                       | a signed-in test must re-read the token after posting `/login`                                                                                                                                                                     |
| Page policies (M141)              | `packages/react-router-plugin/src/interfaces/index.ts` `PagePolicy` (`middleware`, `on?: 'action' \| 'all'`); keyed by React Router route id                                                         | the generated page's comment can name its route id for `pagePolicies`                                                                                                                                                              |
| Route id of a generated page      | `app/routes.ts` in the template: `flatRoutes({ rootDirectory: 'routes/_app' })` (`full-stack-app-files.ts:20-35`)                                                                                    | `app/routes/_app/<kebab>._index.tsx` has id `routes/_app/<kebab>._index`; **confirmed by the implementation in the built manifest** (§6), not assumed                                                                              |
| Index derivation for `setu sync`  | `packages/cli/src/seams/modules.ts:100-135`                                                                                                                                                          | the index's controller entries come from scanned `*.controller.ts` files, so a module with no controller file gets no controller entry                                                                                             |
| Inactive-module rule              | `packages/cli/src/diagnostics/diagnose.ts:259-266` (`setu.E009`)                                                                                                                                     | a module counts as active when the modules barrel activates its symbol; it does not require routes, so a page-only module passes                                                                                                   |
| Existing tests for this schematic | `packages/cli/test/unit/schematics/module-full-stack.test.ts`; `test/e2e/full-stack-modules-e2e.test.ts:29-58`; `test/e2e/scaffold-runs-e2e.test.ts:366-373`; `test/unit/generated-guidance.test.ts` | the e2e test asserts "page + API read back one service"; the scaffold test runs `g module articles --page` and the project's gates                                                                                                 |
| Agent brief rule                  | `packages/cli/src/agents/rules.ts:130, 136` (`full-stack`, `full-stack-workers`)                                                                                                                     | says loaders resolve services with `getService`; nothing about writes                                                                                                                                                              |
| CLI docs                          | `docs/cli.md:436-437`                                                                                                                                                                                | describes `--page` as a `requireUser` page whose loader reads the service                                                                                                                                                          |

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
  registers its token and no routes. The kernel-route-shadows-page collision check
  (`generate.ts:523-560`) applies only when a controller is written.

- **Why:** an SSR page module needs no JSON API, and an unused API is attack surface someone must
  secure (the controller comment already warns it is not behind sign-in). The flag name follows
  Laravel and AdonisJS (`--api`). The non-page default is unchanged, because without a page the API
  is the module's only entry point.
- **Test home:** `module-full-stack.test.ts` (file list per combination); a generate-command test
  for the refusal; the e2e test for both page combinations.

### 3.3 One input rule: `service.parse`

- **Decision:** the generated `<Pascal>Service` gains
  `parse(value: { readonly name?: unknown }): <Pascal>Input | string`. It returns the input, or the
  message "A non-empty name is required." when `name` is not a non-empty string after trimming.
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
      - POST without `_csrf` gives 403.
    - **API (with no `--page`, or with `--api`):** today's assertions, unchanged.
  - The session helper's JSDoc says the signed-in helper relies on the template's placeholder
    sign-in, and must change when the application replaces it.
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
  - `CHANGELOG.md` ("Changed", `@setu-ts/cli`) and `docs/upgrading.md` ("## 0.14.0"): `--page` no
    longer writes `/api/<name>`, so pass `--api` for it. Existing modules are untouched.
- **Test home:** `test/unit/agents` (the rule text and its stability test);
  `generated-guidance.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none (no package export changes). It is a behaviour change of a CLI
command (`--page` alone no longer writes a controller), recorded in the CHANGELOG and the upgrade
notes, and it ships in minor 0.14.0.

| Exported symbol                                                | Kind     | Consumer / real code path that READS it                                                     |
| -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------- |
| `--api` (CLI flag)                                             | CLI flag | `generate.ts` reads `args.flags['api']` and passes `api: true` to `generateFullStackModule` |
| `FullStackModuleOptions.api` (internal, not in `src/index.ts`) | option   | `generateFullStackModule` decides the controller file, index families and e2e test          |

### 4.1 Options — every option names its consumer

| Option | Consumer                  | Behavior (per implementation)                                                                                          |
| ------ | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `page` | `generateFullStackModule` | writes the page with `loader` + `action`; without `api`, writes no controller                                          |
| `api`  | `generateFullStackModule` | with `page`, also writes the controller, its index entry and the API e2e case; `generate.ts` refuses it without `page` |

## 5. Implementation files

| File                                               | Purpose                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/schematics/module-full-stack.ts` | page with action and form; `parse` in the service; controller via `parse`; files and index per `page`/`api`; e2e test per path; `signedInSession` |
| `packages/cli/src/commands/generate.ts`            | `--api` help, refusal without `--page`, pass-through; collision check only when a controller is written                                           |
| `packages/cli/src/agents/rules.ts`                 | the `full-stack` and `full-stack-workers` rule sentence                                                                                           |
| `docs/cli.md`, `CHANGELOG.md`, `docs/upgrading.md` | C1, §3.6                                                                                                                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                             | src covered                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/schematics/module-full-stack.test.ts`                                                         | `module-full-stack.ts`       | file list for `{}`, `{ page: true }`, `{ page: true, api: true }`; the index has a controller entry only with a controller; the page exports `action`, posts `_csrf`, calls `parse`, names `routes/_app/<kebab>._index`; the controller calls `parse` and has no `inputOf`; the e2e test has the page case, the API case, or both; `signedInSession` re-reads the token after `POST /login` |
| a generate-command test (existing file covering `--page` refusals, or `test/unit/commands/generate-api-flag.test.ts`) | `generate.ts`                | `--api` without `--page` is refused with the §3.2 message; `--page --api` passes `api: true`; `--page` alone writes no controller and skips the shadowing check                                                                                                                                                                                                                             |
| `packages/cli/test/unit/agents/*` (the rule-text tests)                                                               | `rules.ts`                   | the new sentence appears in both full-stack rules; the brief stays formatter-stable                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/unit/generated-guidance.test.ts`                                                                   | `generate.ts` guidance       | the `--page` help line names `--api`                                                                                                                                                                                                                                                                                                                                                        |
| `packages/cli/test/e2e/full-stack-modules-e2e.test.ts` (reworked)                                                     | generated project            | `g module articles --page` then `check`, `build` and the generated tests pass, and a direct POST to `/articles` creates a record the page shows. `g module notes --page --api` passes the same gates, and the API and the page read back one service. `setu sync` leaves the page-only module's index without a controller entry. The built manifest names `routes/_app/articles._index`    |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (existing)                                                          | generated project per target | `g module articles --page` still keeps each target formatted, checked and tested                                                                                                                                                                                                                                                                                                            |

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

## 9. Out of scope

- The full-stack template's `products` example. Its page only reads, and `GET /api/products`
  demonstrates one service serving both. Revisit if the template gains a write.
- A `setu g page` schematic for a page without a module.
- Migrating Mohor's own pages to actions; that is application work after 0.14.0.
- Writing `pagePolicies` into `setu.config.ts` from the generator.
