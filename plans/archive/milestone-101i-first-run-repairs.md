# Milestone 101i — first-run repairs (`@setu-ts/cli`, `@setu-ts/kernel`, `@setu-ts/rest-starter`, docs)

> **Status:** Complete; merges as one PR from `fix/cli-first-run`. No ROADMAP entry, by the
> maintainer's direction: this is a batch of defect repairs found by cold-reading the newcomer path
> (the getting-started guide, `setu new` on every template × runtime, the runtime deployment guide)
> and by smoke exercise X66 (DI in the generated full-stack app). It was planned like a milestone so
> the work has one recorded design.
>
> **Outcome, where it departs from the plan below.** I1 was superseded: rather than the starter's
> `di` arm defaulting `autoRegister: true`, `DiPlugin` itself now defaults it to `true` (a breaking
> change, CHANGELOG'd with migration text), and the starter passes `options.di` through unchanged,
> so the CLI, the starter and a hand-written `DiPlugin()` agree. X66-4, listed below as out of
> scope, was closed without a `common` change: `@setu-ts/testing` gained `overrideProvider`, which
> swaps a container provider before `DecoratorPlugin` registers its own. The cold read of the
> remaining guides also landed here, with three framework fixes it found: an absent header now
> resolves to `undefined`, `Query<T>()` is generic, and the full-stack starter leaves
> `SchedulerPlugin` out on Cloudflare Workers, where it refused to start. A Deno, Node and Bun
> full-stack `dev` entry (`viteDevExternals`) serves route edits without a restart.

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
  - **I3:** `apps/cloudflare` retries a failed start instead of caching it (§3.4), done on
    `docs/first-run-docs` because it touches no file the implementation owns.
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

### 3.4 I3 — the Cloudflare example retries a failed start

- **Decision:** `createWorkerHandler` in `apps/cloudflare/worker.ts` keeps sharing one start across
  concurrent requests and never fetches on a failed one, but clears its memoised promise when the
  start rejects, so the next request retries.
- **Why:** M38 chose to cache the rejection on the premise that "the retry policy is a fresh Worker
  invocation". That premise is false: one isolate serves many invocations, so a cached rejection
  outlives the request that hit it — the reason M70l (X9-8) made the generated Workers entry memoise
  only a successful start. The example contradicted the generated entry and the guides.
- **Test home:** `test/worker-startup-behavior.test.ts` — the concurrent-failure case keeps its
  no-fetch assertion, and a new case asserts a failed start is retried and then serves.
- **Negative control:** remove the clearing `catch`; the retry case must fail.

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
| `apps/cloudflare/worker.ts`                   | I3: forget a failed start.                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                                  | Key assertions                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/starters/rest-starter/test/integration/app-integration.test.ts`       | `rest-starter/src/app.ts`                                    | `di: {}` resolves an injected `CAPABILITIES.LOGGER` through a real started app; `autoRegister: false` still throws. |
| `packages/starters/full-stack-starter/test/integration/app-integration.test.ts` | (inheritance, no src change)                                 | `createFullStackApp({ di: {}, decorators: { services } })` resolves a logger-injected class.                        |
| `packages/cli/test/unit/templates/project-files.test.ts`                        | `cli/src/templates/project-files.ts`                         | `full-stack` smoke test fetches `/` and requests `/health`; `rest` does not fetch `/`.                              |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (unchanged)                   | generated `test/app.test.ts`                                 | `deno task test` on a real `full-stack` scaffold passes with the new request.                                       |
| `test/worker-startup-behavior.test.ts`                                          | `apps/cloudflare/worker.ts` (example; not coverage-measured) | Concurrent failure shared without fetching; a failed start is retried and then serves.                              |

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

## 10. Completed design security review

**Review completed:** 2026-10-08, for the repair design in §§0–3 and the complete
`develop...0900494a` change range. This review is recorded after implementation, at the maintainer's
explicit instruction to complete the design security review and then re-audit. It does not claim
that a review existed before implementation. The subsequent implementation audit must run in an
independent context on the commit containing this section. No exploit finding or security-policy
exception is accepted by this review.

### 10.1 Reviewed flow and trust boundaries

1. HTTP caller → native `Request` → exported or detached `Application.fetch` → registered runtime
   HTTP adapter → kernel middleware → route or SSR handler → native `Response`. Binding a callback
   must preserve the application instance and the existing security pipeline, including refusals,
   opaque server errors and request accounting. It must not add a second dispatch path.
2. Worker invocation → deployment-owned bindings → application factory → plugin registration and
   initialization → successful shared application → HTTP or queue dispatch. An invocation may
   trigger cold start but must never reach a partially initialized application. A failed attempt
   must release acquired resources and a later attempt must construct a fresh application. HTTP and
   queue callers of the example's `application(env)` share the same startup gate.
3. Application author → starter options and decorator service declarations → application-local DI
   container → that application's kernel registry. A registry fallback is composition, not
   authentication or tenant authorization. No request parameter may become a DI token merely because
   the fallback default changed. Enabling the arm must preserve an explicit opt-out.
4. CLI caller → validated/normalized project name and fixed template selection → filesystem write
   pipeline → generated manifests, entry modules, README and smoke test. Project names cross both a
   path boundary and text-output boundaries; validation must precede writes. First-party route
   metadata describes existing routes and grants no authority. The new build commands are fixed
   template commands, not a shell constructed from request or argv data.
5. Generated smoke test → started application → `/health` plus streamed SSR `/` → consumed response
   → assertion and application shutdown. A failing load-context callback must fail the emitted test
   even when health is healthy. The health route is not an SSR or authentication readiness proof.

Source seams reviewed: `packages/kernel/src/application/application.ts` (constructor, `fetch`,
dispatch and failure paths), `packages/di-plugin/src/container/container.ts` (registry fallback),
`packages/starters/rest-starter/src/app.ts` (composition), `apps/cloudflare/worker.ts` (startup and
shared queue access), `packages/cli/src/templates/project-files.ts` (rendering, scripts and smoke
test), `packages/cli/src/utils/names.ts` (path grammar/output escaping), and
`packages/exceptions/src/middleware/error-handler.ts` (response masking versus operator logs).
`docs/runtime-deployment.md` contains two startup recipes which must obey the same fresh-application
rule as the Worker example; compiling a recipe alone cannot prove recovery.

### 10.2 Assets, attackers and assumptions

| Asset                                                | Attacker or failure source                                                                    | Required boundary                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protected route/SSR data and application credentials | Unauthenticated HTTP caller controlling URL, headers and body                                 | Existing guards run before protected handlers; callback receiver changes cannot bypass them; credentials/internal error causes do not enter client error bodies |
| Availability and startup resources                   | HTTP/queue invocation triggering cold start; failing, synchronous-throwing or slow dependency | Failed starts cannot serve or be cached forever; concurrent invocations coalesce; teardown releases resources acquired by failed attempts                       |
| Application-local services and configuration         | Caller trying to influence resolution; accidental cross-app singleton reuse                   | DI exposes only the owning application's registered services; unregistered names refuse; absence/explicit opt-out remains effective                             |
| Developer filesystem, terminal and generated source  | CLI argv containing traversal, control characters or shell punctuation                        | Refuse unsafe derived path segments before writing; normalize allowed names consistently; escape refusal output; no interpolation into executable commands      |
| Developer/CI confidence and response resources       | SSR initialization defect, including a thrown `populateLoadContext` error                     | Emitted test distinguishes failing SSR from healthy health endpoint and consumes/cancels response bodies before shutdown                                        |
| Deployment privileges and secret material            | Incorrect operator configuration or copied deployment recipe                                  | No newly broadened permission/credential grants; deployment examples state their scope rather than promise automatic production hardening                       |

Application code, installed plugins and first-party template definitions are trusted executable
code, not sandboxed tenants. They already receive registry access; DI does not make them less
privileged. Platform binding objects are deployment configuration, not fields taken from an HTTP
request. The standalone Worker example assumes one binding configuration per handler lifetime; it
does not promise the generated entry's binding-replacement behavior. Cross-app isolation is
required; tenant isolation inside an application's singleton service remains that service's
responsibility. No per-request DI scope is promised by the loader documentation.

Operator logs are a separate, access-controlled diagnostic destination. Internal exception messages,
causes and paths may reach that destination under the existing logging contract, but must not appear
in opaque HTTP 500 bodies. This is not permission to log secrets: AI_GUIDELINES §13.3 still applies.
Credential/header/password metadata must be redacted, and application code must not embed
credentials in free-form exception text. The review does not claim that field redaction recognizes
arbitrary secrets embedded in prose, or that `logErrors: false` disables every framework logging
path. The audit must show the actual captured log behavior alongside wire-body checks, not infer log
confidentiality from an opaque response.

### 10.3 Resource budgets and limits of the design

- **Startup state:** at most one pending startup and one successfully retained application reference
  per Worker handler. Concurrent fetch/queue access must share it. Failure clears the pending
  reference; repeated failures must not accumulate handler-retained applications or unclosed
  resources for completed registration work. A retry invokes the factory again rather than
  restarting the failed kernel instance.
- **DI fallback state:** successful fallback entries are limited to services registered in the
  owning application's registry; missing/prototype-named tokens must not allocate providers or
  singletons. There is no registry populated from arbitrary HTTP keys in this change.
- **Response lifecycle:** every emitted SSR smoke response is consumed or cancelled; application
  shutdown runs on both assertion success and failure.
- **Filesystem/name budget:** existing derived project path segments remain limited to 255 UTF-8
  bytes, with the existing portable name grammar. This repair introduces no new numeric input bound.
- **Startup deadline:** these helpers add no deadline or cancellation mechanism. A dependency that
  never settles can hold the pending startup and callers; the platform/application must supply its
  dependency timeout. The audit must exercise a controlled hang and report this limitation
  explicitly, rather than claim bounded response latency or regard a hung request as a successful
  refusal.
- **Audit workloads, not production caps:** exercise at least 100 refused requests followed by a
  successful request; 1,000 unknown DI tokens; and eight failed startup waves with sixteen
  concurrent callers per wave followed by recovery. These establish regression evidence, not
  load-test capacity.
- No body/rate/connection bound, listener default, credential format, npm dependency or Deno
  permission declaration is changed by these repairs. Existing broad development task grants and the
  generated development session placeholder are not production least-privilege or secret-management
  guarantees. Documentation's explicit `0.0.0.0` deployment listeners are intentional externally
  reachable servers; they are not a loopback-only local control plane.

### 10.4 Design findings and resolutions to verify

| ID      | Threat / design concern                                                         | Design resolution and audit obligation                                                                                                                               |
| ------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D101I-1 | Detached callback loses its receiver or bypasses middleware                     | Bind the existing Fetch method; retain adapter/pipeline dispatch; O1 and a binding-removal negative control                                                          |
| D101I-2 | DI fallback crosses app ownership or defeats caller opt-out                     | Resolve only the owning registry, cache only existing registrations, preserve explicit false and absent arm; O2 with default/precedence controls                     |
| D101I-3 | Failed startup serves partial state, remains cached, or leaks retry resources   | Gate all consumers, coalesce each attempt, clear rejection and construct fresh apps; O3 with retry-clear/fresh-factory controls                                      |
| D101I-4 | Opaque response is mistaken for secret-free logging                             | Separate client response and operator diagnostic destinations; forbid credential logging, inspect actual output/redaction and record free-form error limitations; O4 |
| D101I-5 | Project name escapes its directory or forges output/commands                    | Preserve pre-write path grammar and sink escaping; render fixed script strings and first-party route data; O5                                                        |
| D101I-6 | Health-only test approves broken SSR or leaks stream resources                  | Execute the emitted test through real SSR/context handling, require page 200 and body consumption, stop in finally; O6 and request-removal control                   |
| D101I-7 | Copyable deployment snippets overstate startup recovery or privilege guarantees | Exercise both startup recipes; inspect permission/dependency/listener changes and non-root Docker directives without claiming an untested deployment; O3/O7          |

These rows specify required behavior, not closed implementation findings. The independent audit
decides whether the committed implementation meets them. No Critical/High finding is pre-accepted,
and inherited behavior is not excused solely because it predates this branch.

### 10.5 Implementation-audit obligations

Every obligation below requires source and raw stdout in the report, a legitimate positive control
through the same path, and explicit limitations. A missing or nondiscriminating probe fails the
audit. Run sandboxed, with an emptied environment and scoped local permissions, under the canonical
security-audit procedure; do not use real credentials or remote targets.

| ID | Required probe and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 | Drive bare detached Fetch and `{ fetch: app.fetch }` through the real adapter/kernel pipeline. Refuse unauthorized calls without running protected handlers, accept legitimate ones after repeated refusals, keep malformed requests out of handlers, and reject a missing adapter asynchronously. Plant internal error/cause/query canaries and inspect raw response bodies/headers. Remove binding and observe the probe fail, then restore and pass. No raw-socket framing guarantee is inferred from Fetch                                                                                                                                           |
| O2 | Start real REST and full-stack apps with DI/decorators. Prove default capability injection, explicit false refusal, absent-arm behavior, two-app service identity isolation and no provider/singleton allocation from 1,000 missing names plus prototype-like names. Re-resolve a legitimate service after refusals. Reverse both default and explicit-option precedence separately; each relevant probe must fail                                                                                                                                                                                                                                       |
| O3 | Use real kernel lifecycle hooks in the Worker handler, including fetch and shared application/queue startup access. Prove failed applications never dispatch; each concurrent wave uses one attempt; failure cleanup matches acquired resources; recovery uses a fresh app and a successful app is reused. Drive synchronous factory/registration throws and a controlled hung dependency, then release it and show recovery. Exercise both deployment-guide startup recipes with a transient post-registration failure. Remove retry clearing and replace fresh construction with failed-instance reuse; discriminate and restore the relevant controls |
| O4 | Capture client bodies/headers and operator log output for successful and failing paths. Internal-error/cause/path canaries must be absent from opaque client 500s; known credential/password/header metadata canaries must be redacted in logs. Show useful legitimate responses and diagnostic logging still occur. Record any internal canaries visible in diagnostic logs and any unsupported free-form secret-redaction claim. A newly introduced path disclosing credentials is a finding, not an accepted diagnostic destination                                                                                                                   |
| O5 | Drive the actual CLI on a scoped real filesystem with traversal, CR/LF/NUL/ESC, quotes and shell punctuation. Refused names create no files; normalized names remain contained and every captured output line and changed generated file uses safe names. Prove a legitimate scaffold works and that generated Node/Bun build-before-start commands remain fixed, with no argv substitution. No execution of hostile command text is necessary                                                                                                                                                                                                           |
| O6 | Execute the emitted full-stack smoke test against real full-stack/SSR context handling: healthy health and SSR pass; thrown `populateLoadContext` leaves health healthy but fails the emitted test. Consume streaming bodies and observe shutdown/resource sanitizers. A faithful injected handler loader is permitted if stated; source-string assertions alone do not satisfy this obligation. Remove the emitted page probe and show the audit catches the now-passing broken app                                                                                                                                                                     |
| O7 | Read the complete production/configuration/deployment diff for new broad permission grants, dependencies, lazy imports, credential material and externally exposed listeners. Check changed non-root Docker directives and explain intended listener exposure. Scope the fifteen-class sweep to actual added/changed controls; justify every N/A. Record unsupported native-runtime/platform/build claims and produce the PR audit record. No deployment hardening is certified from text checks alone                                                                                                                                                   |

For every security control added or changed, temporarily remove it, load the changed code in a fresh
process, observe the relevant probe fail, restore it and confirm a clean tree before the next probe.
Existing name/redaction controls inspected as seams are not falsely counted as newly added controls.
Re-run the previous audit's probes as well as the obligations above on the new committed revision.
If a new finding appears, report it with severity and evidence; do not fix or choose a waiver within
the audit pass. S101I-P1 can be closed only after the independent auditor confirms this completed
review supplies the required design and that its obligations were driven.
