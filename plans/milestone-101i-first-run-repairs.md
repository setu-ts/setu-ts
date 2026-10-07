# Milestone 101i — first-run repairs (`@setu-ts/cli`, `@setu-ts/kernel`, `@setu-ts/rest-starter`, docs)

> **Status:** Implementation in progress. Branch: `fix/cli-first-run`. No ROADMAP entry, by the
> maintainer's direction: this is a batch of defect repairs found by cold-reading the newcomer path
> (the getting-started guide, `setu new` on every template × runtime, the runtime deployment guide)
> and by smoke exercise X66 (DI in the generated full-stack app). It is planned like a milestone so
> the work has one recorded design, and it merges as one PR from this one branch.
>
> Work is split across two checkouts. **Implementation** (§3.1–§3.2, I1–I2) happens in the worktree
> `.claude/worktrees/first-run` on `fix/cli-first-run`. **Documentation** (§3.3, D2–D5) happens on
> `docs/first-run-docs`, which is cut from this branch and merged back into it before the PR opens.

## 0. Objective & scope

Make the first ten minutes work: every command the docs and the CLI tell a newcomer to run must run,
and every capability the docs say is "turned on" by an option must work when that option is set the
way the docs show. The boundary is defects a newcomer hits by following the documented path;
redesigning an API is out of scope.

- **In scope:**
  - **Already shipped on this branch** (commits `cde06e2f`, `45d28f1b`, recorded for traceability):
    `full-stack` `start` builds first on Node and Bun; the guide's CLI install line (`-g -n setu`)
    plus a drift gate over every documented install line; `Application.fetch` bound so
    `export default { fetch: app.fetch }` serves on Workers; a "What it serves" README section
    checked against a booted scaffold; the runtime deployment guide's setup commands and five wrong
    claims.
  - **I1 (X66-1):** the starter `di` arm defaults `autoRegister: true`.
  - **I2 (X66-3):** the generated `full-stack` smoke test requests `/`, so a failing
    `populateLoadContext` fails `deno task test`.
  - **D2–D5:** the X66 documentation repairs (§3.3). X66-5 (a "stray fence" in the
    full-stack-starter README) was retracted: it was a misread of two concatenated `sed` ranges, and
    the section is correct.
- **NOT this milestone:**
  - Replacing a container-provided service with a test double (X66-4). It needs an `override` option
    on `ProviderOptions` in `@setu-ts/common` — a published-contract decision for the maintainer,
    not a repair. Documented as a limitation here (D5); unowned.
  - The Workers `npm install` `ERESOLVE` in fresh scaffolds — owned by
    `fix/workers-devdeps-peer-range`.
  - `setu add` starter guidance (X66-6) and `@setu-ts/testing` in `full-stack` scaffolds (X66-7) —
    already fixed on `develop` by M101g; nothing to do.

## 1. Contracts verified from SOURCE (not names)

| Reference                   | Source (file:line)                                                        | Verified surface / fact                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starter `di` arm            | `packages/starters/rest-starter/src/app.ts:64`                            | `...(options.di ? [DiPlugin(options.di)] : [])` — options passed through unchanged, so `di: {}` builds a container with `autoRegister` off.        |
| `autoRegister` default      | `packages/di-plugin/src/container/container-builder.ts:42,137`            | `#autoRegister = false`; `setAutoRegister(config?.autoRegister ?? false)`.                                                                         |
| `autoRegister` meaning      | `packages/di-plugin/README.md:47`                                         | "Fall back to the kernel `ServiceRegistry` for unregistered tokens."                                                                               |
| CLI's own DI wiring         | `packages/cli/src/templates/di.ts:16-31`                                  | The `class-based` template emits `DiPlugin({ autoRegister: true })` deliberately, so the CLI and the starter arm disagree today.                   |
| Tier inheritance            | `microservice-starter/src/app.ts:9,27`; `full-stack-starter/src/app.ts:9` | microservice spreads `buildRestPlugins(options)`; full-stack builds on `buildMicroservicePlugins` — one change at the REST tier reaches all three. |
| Failure measured (X66)      | `smoke/X66-FINDINGS.md`                                                   | `di: {}` + `@Inject(CAPABILITIES.LOGGER)` → `No provider registered for DI token 'logger'`; `di: { autoRegister: true }` → page renders `$49.00`.  |
| Generated smoke test        | `packages/cli/src/templates/project-files.ts:1650-1675` (approx.)         | Requests `/health` when the host has `appFactory` or `health-plugin`, through `app.inject`. `/health` stays 200 when `populateLoadContext` throws. |
| `inject()` and streams      | `packages/kernel/src/application/application.ts` (`inject`)               | `inject()` throws on a streaming body and points at `app.fetch()`; an SSR page streams, so `/` must be requested through `fetch`.                  |
| `ProviderOptions`           | `packages/common/src/container.ts:81-84`                                  | Only `scope`; no override. `register` on an existing token throws "already registered. Use a child scope to override."                             |
| `setu add` starter guidance | `packages/cli/src/commands/add.ts:179-195,256-275`                        | `REST_ARMS` maps `decorator-plugin`→`decorators`, `di-plugin`→`di`; `printWiringNote` names the arm. X66-6 is fixed on `develop`.                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                    | Resolution (picked side)                                                           | Doc deliverable (same PR)                                                                       |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C1 | `full-stack-starter` and `rest-starter` READMEs show `di: {}` beside an `@Inject(CAPABILITIES.LOGGER)` example; that pairing fails (X66-1). | The code moves (I1): `di: {}` defaults `autoRegister: true`, so the example works. | D4: both READMEs say what the arm turns on, including the registry fallback and how to opt out. |

## 3. Design decisions

### 3.1 I1 — the starter `di` arm defaults `autoRegister: true`

- **Decision:** `packages/starters/rest-starter/src/app.ts` builds
  `DiPlugin({ autoRegister: true, ...options.di })`. An explicit `autoRegister: false` in the
  caller's options still wins, because the spread comes last.
- **Why:** with the arm on, `DecoratorPlugin` registers every `@Injectable` class as a container
  provider, and an `@Inject(CAPABILITIES.X)` argument can then only resolve if the container falls
  back to the kernel registry. Off, the framework's own services are unreachable from any decorated
  class — the starter's documented example fails. This also matches what the CLI already emits for
  `class-based` (`di.ts`), so "turn on DI" means one thing.
- **Behaviour change:** an existing starter app passing `di: {}` now resolves unregistered tokens
  from the kernel registry instead of throwing. That turns a failure into a success; nothing that
  worked before stops working. CHANGELOG `Changed`, with `di: { autoRegister: false }` as the way
  back.
- **Test home:** `packages/starters/rest-starter/test/integration/app-integration.test.ts` (extend
  it): (a) `buildRestPlugins({ di: {} })` composes a container that resolves `CAPABILITIES.LOGGER`
  through a decorated class injecting it, driven through a REAL `createRestApp` + `start()`; (b)
  `di: { autoRegister: false }` still throws `No provider registered for DI token 'logger'`. One
  full-stack test proving the inheritance:
  `createFullStackApp({ di: {}, decorators: { services:
  [X] } })` resolves an `X` that injects the
  logger.
- **Negative control:** revert to `DiPlugin(options.di)` — test (a) must fail with the X66-1
  message.

### 3.2 I2 — the generated `full-stack` smoke test requests `/`

- **Decision:** for a host with `appFactory` (today only `full-stack`), the emitted
  `test/app.test.ts` requests `/` through `app.fetch(new Request('http://localhost/'))` and asserts
  `200`, in ADDITION to the existing `/health` request. Other hosts are unchanged.
- **Why:** `populateLoadContext` runs only on an SSR request. Every DI misconfiguration X66 tried
  (no `di` arm, an unlisted service, a misspelled token) left `/health` at 200 while every page
  answered 500, so the smoke test passed over all three. `/` is the template's home page and is not
  behind sign-in, so it is a 200 on a fresh scaffold. `fetch`, not `inject`, because the SSR body
  streams and `inject()` refuses a streaming body. The response body must be consumed or cancelled
  so the test's resource sanitizer does not report a leak.
- **Test home:** `packages/cli/test/unit/templates/project-files.test.ts` — the `full-stack` test
  file contains the `/` fetch and the `/health` request; a `rest` test file does not gain the `/`
  fetch. `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` already runs `deno task test` for
  `full-stack` (the BOOTABLE loop), so the new request is exercised for real with no e2e edit.
- **Negative control:** in a scaffolded `full-stack` project, make `populateLoadContext` throw;
  `deno task test` must fail (it passes today). Record the before/after.
- **Baseline:** `template-baseline.json` does not cover `full-stack`, so no hash changes; confirm.

### 3.3 Documentation (D2–D5, on `docs/first-run-docs`)

- **D2 (X66-2):** a "Constructor injection in loaders" section in the `full-stack-starter` README:
  register `@Injectable` classes through `decorators: { services }`, turn the container on with
  `di: {}`, resolve in `populateLoadContext` from `CAPABILITIES.DI_CONTAINER`, carry the instance on
  a `contextKeyFor` key, read it in the loader. Scopes: no per-request scope exists, so a `scoped`
  provider resolved from the root acts as a singleton (the measured X66 table).
- **D3 (X66-3):** in the same section, that a resolution error surfaces per SSR request while
  `/health` stays 200, and that the generated smoke test (after I2) requests `/` to catch it.
- **D4 (C1):** both starter READMEs' `di` arm text states it defaults `autoRegister: true` (after
  I1) and what that means.
- **D5 (X66-4):** `@setu-ts/testing` README: a container-provided service cannot be replaced with
  `overrideCapability` (it is not in the registry) nor by re-registering on the container; name the
  limitation rather than leave a reader to find it.
- **Test home:** the package README fence compiler and `check:docs`. If a starter README is not in
  the fence compiler's list, D2's fences are compiled by hand once and the result recorded.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. I1 changes a default inside the starter; I2 changes generated
output for newly scaffolded `full-stack` projects only.

| Exported symbol | Kind                      | Consumer / real code path that READS it |
| --------------- | ------------------------- | --------------------------------------- |
| None (checked)  | No `src/index.ts` changes | I1 and I2 add no export.                |

### 4.1 Options — every option names its consumer

| Option                             | Consumer                             | Behavior (per implementation)                                                         |
| ---------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `RestStarterOptions.di` (existing) | `buildRestPlugins` → `DiPlugin` (I1) | Present: `DiPlugin({ autoRegister: true, ...di })`. Absent: no container (unchanged). |

## 5. Implementation files

| File                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `packages/starters/rest-starter/src/app.ts`   | I1: `autoRegister: true` default on the `di` arm.    |
| `packages/cli/src/templates/project-files.ts` | I2: the `full-stack` smoke test also fetches `/`.    |
| `CHANGELOG.md`                                | I1 `Changed` entry; I2 `Fixed` entry ("PR pending"). |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                          | Key assertions                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/starters/rest-starter/test/integration/app-integration.test.ts`       | `rest-starter/src/app.ts`            | `di: {}` resolves an injected `CAPABILITIES.LOGGER` through a real started app; `autoRegister: false` still throws. |
| `packages/starters/full-stack-starter/test/integration/app-integration.test.ts` | (inheritance, no src change)         | `createFullStackApp({ di: {}, decorators: { services } })` resolves a logger-injected class.                        |
| `packages/cli/test/unit/templates/project-files.test.ts`                        | `cli/src/templates/project-files.ts` | `full-stack` smoke test fetches `/` and requests `/health`; `rest` does not fetch `/`.                              |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (unchanged)                   | generated `test/app.test.ts`         | `deno task test` on a real `full-stack` scaffold passes with the new request.                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/cli-first-run (implementation) / docs/first-run-docs (docs)
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task check:docs
deno task test
deno task test:coverage:pkg cli rest-starter full-stack-starter   # per-file ≥90% on every changed src file
deno task publish:check     # on the committed tree
```

## 8. Risks & mitigations

- I1 widens resolution for existing starter apps with `di: {}` → only previously-throwing lookups
  change; covered by the `autoRegister: false` test and the CHANGELOG way back.
- I2's `fetch('/')` could leak an unconsumed body and trip the test sanitizer → the emitted test
  consumes the body; the e2e runs it for real.
- Two checkouts edit `CHANGELOG.md` → implementation owns the I1/I2 entries; docs adds its own
  entries in a separate paragraph, and the merge of `docs/first-run-docs` resolves any overlap.

## 9. Out of scope

- A test-double route for container providers (X66-4) — needs `ProviderOptions.override` in
  `@setu-ts/common`; maintainer decision, unowned.
- The Workers scaffold `ERESOLVE` — `fix/workers-devdeps-peer-range`.
- X66-6 and X66-7 — already fixed on `develop` (M101g).
