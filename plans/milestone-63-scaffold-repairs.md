# Milestone 63 — CLI scaffold repairs (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m63-scaffold-repairs`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A project scaffolded from `@setu-ts/cli` at `0.1.0-alpha.7` cannot be installed, cannot serve its
own health endpoint, cannot type-check its own frontend routes, and fails `deno fmt --check` on
files the CLI itself wrote. All four were reproduced against the published packages by building a
three-service workspace (`hono-enterprise-published-smoke`): `auth` and `todos` on
`--template rest`, `web` on `--template full-stack`, running against real PostgreSQL. This milestone
repairs the generated output so a stock scaffold installs, boots, answers its probes, type-checks,
and formats clean — and adds the gate that would have caught all four, since every one passed the
existing drift check.

- **In scope:** the four reproduced scaffold defects (D1 install, D2 permissions, D3 full-stack
  type-check, D6 formatting), and one e2e gate that boots a scaffolded project and issues real
  requests instead of stopping at `deno check`.
- **NOT this milestone:** making the functional `ctx` style the default and the DI/decorator opt-in
  produce NestJS-shaped classes (M64/M65); the Prisma adapter's unusable lazy path (M66); the
  starters' missing `serviceDiscovery` arm, `.env` emission, RFC 9457 default and workspace port
  allocation (M67); repository filter operators, duplicate-route refusal and the system-path
  registry (M68).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                           | Verified surface / fact                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `denoPermissions()`                        | `packages/cli/src/templates/project-files.ts:625-626`        | Returns `['--allow-net', '--allow-env', ...manifest?.denoPermissions ?? []].join(' ')` — the per-template extension seam already exists    |
| `TemplateManifest.denoPermissions`         | `packages/cli/src/templates/registry.ts:212`                 | `readonly denoPermissions?: readonly string[]` — flags added to the generated `start` task beyond the two defaults                         |
| `FULL_STACK` manifest                      | `packages/cli/src/templates/full-stack.ts:141`               | Already sets `denoPermissions: ['--allow-read']`, so the seam is proven in use by exactly one template                                     |
| Member `deno.json` emission                | `packages/cli/src/templates/project-files.ts:869-884`        | Writes `tasks.start`, `compilerOptions: { experimentalDecorators: true }` **hardcoded**, and `imports`. No `jsx`, no `fmt` key             |
| `TemplateManifest.tsconfigCompilerOptions` | `packages/cli/src/templates/registry.ts:200`                 | Merged into the generated `tsconfig.json` only. Nothing merges compiler options into `deno.json`, which is what Deno reads                 |
| Workspace root emission                    | `packages/cli/src/workspace/root-files.ts:72`                | Writes `JSON.stringify({ workspace: globs, tasks: { dev: profile.runAll } })` — no `minimumDependencyAge`, no `fmt`                        |
| `REST_TEMPLATE` plugin list                | `packages/cli/src/templates/rest.ts:48-49`                   | Wires `HealthPlugin` and `MetricsPlugin`, inherited by `microservice` and `nest`                                                           |
| `selfIndicator`                            | `packages/health-plugin/src/indicators/self-indicator.ts:36` | Reads `runtime.hostname()` on every probe — this is what needs `--allow-sys`                                                               |
| `IRuntimeServices.hostname`                | `packages/runtime/src/adapters/deno/deno-runtime.ts:191`     | `hostname: () => host.hostname()`, the Deno host seam over `Deno.hostname()`, which Deno gates behind `--allow-sys`                        |
| Framework `fmt` settings                   | `deno.json` (repo root), `fmt` block                         | `lineWidth: 100`, `indentWidth: 2`, `singleQuote: true`, `semiColons: true` — the settings generated projects must inherit to format clean |
| Drift gate                                 | `packages/cli/test/e2e/` (scaffold + `deno check`)           | Type-checks a scaffolded project. It does not install, boot, request, format-check, or lint it — which is why all four defects passed      |

Reproductions, all against `0.1.0-alpha.7` on Deno 2.9.5:

- **D1** — `deno install` on a pristine workspace:
  `error: Could not find version of '@setu-ts/common'
  that matches '^0.1.0-alpha.7' … newer than the specified minimum dependency age`.
  Deno 2.9 refuses a dependency published within 24h; `setu new` pins generated projects to the
  CLI's own version, so the window is guaranteed on release day.
- **D2** — `GET /health` on a stock `--template rest` project started with its own generated task:
  `{"statusCode":500,"message":"Requires sys access to \"hostname\", run again with the --allow-sys
  flag"}`.
  Adding `--allow-sys` returns `200`.
- **D3** — `deno check app/routes/_auth/login.tsx` in a stock `--template full-stack` project:
  `TS2686 'React' refers to a UMD global … Found 79 errors.`
- **D6** — `deno fmt --check` on a pristine three-member workspace:
  `Found 62 not formatted files in
  74 files`, including `apps/auth/main.ts`,
  `src/health/index.ts`, `app/root.tsx` and `app/routes.ts` — all CLI output, none hand-edited.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                        | Doc deliverable (same PR)                                                          |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| C1 | `registry.ts:204-211` documents `denoPermissions` as "flags the generated Deno `start` task needs beyond the default", implying the default suffices for templates that omit it. `rest` omits it and its own `/health` returns 500.                    | The JSDoc is right about the mechanism and wrong about the sufficiency of the default. Keep the field; correct the prose to say the set is derived from the template's plugins. | JSDoc correction at `registry.ts:204-211`.                                         |
| C2 | `project-files.ts:876-878` comments `experimentalDecorators` as needed because "the decorator and OpenAPI plugins ship legacy decorators", but emits it unconditionally — including for `full-stack`, which registers neither and needs `jsx` instead. | The comment describes the REST case correctly and the emission over-applies it. Make the option come from the template manifest.                                                | Comment corrected at the emission site to name which templates need which options. |
| C3 | `CLAUDE.md` "Verification" lists four gates plus two publish gates as sufficient for a milestone. All four defects here passed every one of them.                                                                                                      | The gate list is right for _package_ changes and blind to _generated-project_ changes, which are only observable by running the generated project.                              | A "Scaffold changes" note in `CLAUDE.md` "Verification" pointing at the new gate.  |

## 3. Design decisions

### 3.1 How the permission set is decided

- **Decision:** Keep `denoPermissions` as the single mechanism and populate it per template from the
  plugins that template wires: `rest`, `microservice` and `nest` gain `--allow-sys` (HealthPlugin's
  `selfIndicator` reads the hostname); `full-stack` keeps `--allow-read` and gains `--allow-sys` for
  the same reason. No new machinery is added.
- **Why:** The seam already exists and is already used by one template. Deriving the flags
  mechanically from the plugin list was considered and rejected: a plugin's permission needs are not
  declared anywhere on the plugin, so the derivation would be a second hard-coded table keyed by
  package name, which is the same data in a less obvious place.
- **Test home:** `permissions-are-sufficient.e2e.test.ts` — boots each template and requires `200`
  from `/health`.

### 3.2 Where a member's Deno compiler options come from

- **Decision:** Add `TemplateManifest.denoCompilerOptions`, merged into the generated member
  `deno.json`. `rest`/`microservice`/`nest` supply `{ experimentalDecorators: true }`; `full-stack`
  supplies `{ jsx, jsxImportSource, lib }` and does NOT supply `experimentalDecorators`, which it
  never uses. The no-template host keeps `experimentalDecorators`, so a developer who adds
  `decorator-plugin` by hand to a bare project does not meet a compile error from a manifest they
  never wrote.
- **Why:** `tsconfigCompilerOptions` already exists for the npm toolchain and Vite reads it; Deno
  reads `deno.json` and nothing populates that. **The mechanism is sharper than "full-stack was
  missing `jsx`", and was established by measurement only after the first negative control failed to
  discriminate:** a manifest with NO `compilerOptions` key type-checks JSX cleanly, because Deno
  applies its own `react-jsx` default — but declaring ANY option replaces that default set. The
  previously-hardcoded `experimentalDecorators` was therefore the CAUSE of the 79 errors, not a
  redundant extra sitting beside a missing setting. That is also why the option stays free on the
  no-template host, which emits no JSX, and why it could not stay on `full-stack`.
- **Test home:** the `check:app` step of `scaffold-runs-e2e.test.ts`. Its negative control must
  restore `{ experimentalDecorators: true }` rather than delete the key — deleting it passes.

### 3.3 How full-stack route modules become reachable by the type-checker

- **Decision:** Emit a `check:app` task, `deno check app/**/*.ts app/**/*.tsx`, in the `full-stack`
  member's `deno.json` via the existing `TemplateHost.extraTasks`.
- **Why:** `deno check main.ts` reaches only what `main.ts` statically imports; route modules are
  loaded through the compiled server build, so the entry point never reaches them. A glob is
  required rather than a file list because `app/routes.ts` resolves routes through `flatRoutes()` at
  build time and statically imports none of them. This is the fix `apps/full-stack` already carries
  for itself; the template does not emit it.
- **Test home:** `full-stack-typechecks.e2e.test.ts`, which fails without the task because there is
  nothing to run.

### 3.4 What a generated project inherits about formatting

- **Decision:** Emit the repo's own `fmt` block (`lineWidth: 100`, `indentWidth: 2`,
  `singleQuote: true`, `semiColons: true`) into the generated root manifest — the workspace root at
  `root-files.ts:72` and the standalone project root at `project-files.ts:869` — and normalize every
  `.tsx` emitter to single-quoted JSX attributes.
- **Why:** The CLI emits single-quoted TypeScript while Deno's default is double, so an unconfigured
  scaffold fails on almost every file. Emitting the config alone is not sufficient: with
  `singleQuote: true` the CLI's `.tsx` templates still fail, because they emit double-quoted JSX
  attributes. Both halves are required for a scaffold to format clean, which is why they ship as one
  decision rather than two.
- **Test home:** `scaffold-formats-clean.e2e.test.ts` — runs `deno fmt --check` on a scaffolded
  workspace.

### 3.5 What the generated root says about dependency age

- **Decision:** Emit `"minimumDependencyAge": 0` in the generated root manifest, carrying a comment
  that names why.
- **Why:** `setu new` stamps generated projects with the CLI's own version. Deno 2.9 refuses any
  dependency published in the last 24 hours, so on the day of any release the scaffolder emits a
  project that cannot resolve its own pins. Setting a smaller non-zero age was considered and
  rejected: the correct value depends on how long ago the release happened, which the generated
  project cannot know. A generated project pinning exact versions the user did not choose gains
  nothing from the policy, and the user can remove the key.
- **Test home:** `scaffold-installs.e2e.test.ts` — runs a real `deno install` against the registry.

### 3.6 What the new gate proves

- **Decision:** One e2e suite that, for each template and for a workspace, scaffolds into a temp
  directory, repoints imports at this workspace, installs, formats, lints, type-checks, boots the
  project in a subprocess, and issues real requests to `/health`, `/metrics` and one generated
  route.
- **Why:** Three of these four defects are invisible to a type-checker by construction — an install
  failure, a runtime permission error, and a formatter disagreement. The existing drift gate stops
  at `deno check` and passed all four. The boot-and-request step is the part that discriminates.
- **Test home:** the suite itself; its discriminating power is established by the negative controls
  in §7.

## 4. Exported surface — every symbol names its consumer

No symbol is added to `packages/cli/src/index.ts`. This milestone changes what the CLI _writes_, not
what it exports; the one new type is internal to the template registry.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                                                      |
| --------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None (checked)  | —    | `packages/cli/src/index.ts` is unchanged. `TemplateManifest.denoCompilerOptions` is a field on an already-exported interface, read by `project-files.ts` when it emits a member manifest — not a new export. |

### 4.1 Options — every option names its consumer

| Option                                        | Consumer                                                | Behavior (per implementation)                                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `TemplateManifest.denoCompilerOptions`        | `project-files.ts` member-manifest emitter (`:869-884`) | Merged into the generated `deno.json` `compilerOptions`. Absent on a template that needs none, so the key is omitted rather than emitted empty. |
| `TemplateManifest.denoPermissions` (existing) | `denoPermissions()` (`:625-626`)                        | `rest`/`microservice`/`nest` gain `--allow-sys`; `full-stack` becomes `['--allow-read', '--allow-sys']`. Read on every generated `start` task.  |

## 5. Implementation files

| File                                         | Purpose                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                               | Unchanged — no export moves.                                                                                                                                             |
| `src/templates/registry.ts`                  | Add `denoCompilerOptions` to `TemplateManifest`; correct the `denoPermissions` JSDoc (C1).                                                                               |
| `src/templates/project-files.ts`             | Read `denoCompilerOptions` instead of hardcoding `experimentalDecorators`; emit `fmt` and `minimumDependencyAge` in a standalone project root; correct the comment (C2). |
| `src/templates/rest.ts`                      | `denoPermissions: ['--allow-sys']`; `denoCompilerOptions: { experimentalDecorators: true }`.                                                                             |
| `src/templates/microservice.ts`              | Inherit the REST manifest additions.                                                                                                                                     |
| `src/templates/nest.ts`                      | Inherit the REST manifest additions.                                                                                                                                     |
| `src/templates/full-stack.ts`                | `denoPermissions: ['--allow-read', '--allow-sys']`; `denoCompilerOptions: { jsx, jsxImportSource }`; `extraTasks` gains `check:app`.                                     |
| `src/templates/full-stack-app-files.ts`      | Normalize emitted JSX to single-quoted attributes (D6).                                                                                                                  |
| `src/templates/full-stack-build-files.ts`    | Same normalization for any emitted `.tsx`.                                                                                                                               |
| `src/templates/nest.ts` (emitted controller) | Same normalization if it emits JSX; verify before editing.                                                                                                               |
| `src/workspace/root-files.ts`                | Emit `fmt` and `minimumDependencyAge` in the workspace root manifest (`:72`).                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                         | src covered                                | Key assertions (and the signature each call type-checks against)                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/templates/deno-manifest.test.ts`       | `project-files.ts`, `registry.ts`          | A manifest with `denoCompilerOptions` emits exactly those keys; a manifest without one omits the key entirely rather than emitting `{}`. Calls the emitter against its committed signature. |
| `test/unit/templates/permissions.test.ts`         | `project-files.ts` `denoPermissions()`     | `rest` yields `--allow-net --allow-env --allow-sys`; `full-stack` yields those plus `--allow-read`; ordering is stable so the emitted task is byte-identical across runs.                   |
| `test/unit/workspace/root-files.test.ts`          | `workspace/root-files.ts`                  | The root manifest carries `fmt` with the four framework settings and `minimumDependencyAge: 0`, alongside the existing `workspace` globs and `dev` task.                                    |
| `test/e2e/scaffold-installs.e2e.test.ts`          | root emitters                              | `setu new … --workspace` then a real `deno install` exits 0. Guarded on network; skips with exit 77 when the registry is unreachable, never reporting a skip as a pass.                     |
| `test/e2e/permissions-are-sufficient.e2e.test.ts` | every template manifest                    | For each of `rest`/`microservice`/`nest`/`full-stack`: scaffold, boot in a subprocess, `GET /health` is `200` and `GET /metrics` is `200`. This is the assertion D2 would fail.             |
| `test/e2e/full-stack-typechecks.e2e.test.ts`      | `full-stack.ts`, `full-stack-app-files.ts` | Scaffold `full-stack`, run its generated `check:app` task, exit 0. Fails without both §3.2 and §3.3.                                                                                        |
| `test/e2e/scaffold-formats-clean.e2e.test.ts`     | every emitter                              | `deno fmt --check` and `deno lint` on a scaffolded workspace exit 0 with no findings.                                                                                                       |

The e2e suite spawns `deno` subprocesses, so `packages/cli/deno.json` already granting `run` is
required; it does today for the M34b drift gate. Existing drift-gate coverage is kept rather than
replaced — the new suite is additive, since the M55 review found a milestone that deleted 1123 lines
of pre-existing adapter coverage while adding its own.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m63-scaffold-repairs, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

Negative controls, each to be observed failing and then reverted, because a gate that has never
failed is not known to discriminate:

1. Remove `--allow-sys` from the `rest` manifest — `permissions-are-sufficient` must fail with the
   500 quoted in §1, not with a timeout.
2. Set `full-stack`'s `denoCompilerOptions` back to `{ experimentalDecorators: true }` — the
   `check:app` step must fail with `TS2686`. NOT by deleting the key: that was tried first and
   PASSED, because Deno's own defaults then apply. See §3.2.
3. Remove the `check:app` task while keeping the compiler options — the same suite must fail with
   `Task not found: check:app`, proving the two fixes are independently load-bearing.
4. Revert one `.tsx` emitter to double-quoted JSX — the format step must name that file.
5. Remove `minimumDependencyAge` — an install must fail during the release window and is expected to
   pass outside it; record which condition the run was under, since a pass proves nothing on its
   own.

Observed: control 1 failed all three boot steps with the exact `Requires sys access to "hostname"`
500; control 2, in its corrected form, failed with `TS2686`; control 3 failed with
`Task not found: check:app`; control 4 named `app/routes/_auth/login.tsx`. Control 5 is not
reproducible outside a release window, so the emitted key carries a unit assertion instead.

## 8. Risks & mitigations

- The `scaffold-installs` gate depends on how recently the framework was published, so it passes
  vacuously outside a release window → assert the emitted key is present in the manifest as a
  separate unit test, and treat the install run as corroboration rather than the proof.
- `deno fmt` settings are a Deno version behaviour; a future Deno could change its default quoting
  and make the emitted config redundant rather than wrong → the gate runs `fmt --check` on generated
  output, so a change in default is caught as a failure rather than silently drifting.
- Booting four templates in one suite is slow and could push CI over its budget → boot with no port
  bound where the assertion allows it, reuse one scaffold per template across assertions, and keep
  the subprocess boot to the templates that wire an HTTP surface.
- Changing `full-stack`'s emitted compiler options removes `experimentalDecorators` from that
  member. A user who added a decorated class to a full-stack app would newly fail to compile →
  verified against the smoke workspace, whose `web` member registers no decorator plugin and uses
  none; called out in the release notes rather than assumed harmless.

## 9. Out of scope

- Making the functional `ctx` style the default and having the DI/decorator opt-in generate
  NestJS-shaped class components — M65, with the `@Ctx()` built-in it depends on in M64.
- The Prisma adapter's lazy import path, which cannot construct a client at the version it pins, and
  the same audit for the Drizzle adapter — M66.
- The starters' missing `serviceDiscovery` arm, `.env` emission, the RFC 9457 scaffold default, and
  workspace port allocation — M67.
- Repository filter operators and `findOne`, kernel refusal of a duplicate `METHOD path`, the
  plugin-owned system-path registry, and making `AuthPluginOptions.rbac` optional — M68.
- Any change to a published package's runtime behaviour. This milestone changes generated output and
  test coverage only, so no `common` contract, capability token, or plugin option moves.
