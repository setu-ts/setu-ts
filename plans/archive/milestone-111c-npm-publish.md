# Milestone 111c — npm Publishing Machinery (every workspace member + release tooling)

> **Status:** Planning. Branch: `feat/m111c-npm-publish`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

After this milestone, a tag push publishes all 51 workspace members to npm as `@setu-ts/*` from CI,
with provenance and no long-lived token, and every check the release depends on reads npm rather
than JSR. **This milestone builds and proves the machinery; it does not cut `v0.9.0`.** The cut
cannot happen before 111d: `setu new` pins generated projects to the CLI's own version and still
installs them from JSR (`jsr:` specifiers, or `@jsr/…` through `.npmrc`), so an npm-only `0.9.0` CLI
would scaffold projects pinning a version JSR never receives. The sequence is therefore 111c
(machinery) → 111d (Node-first CLI) → the `v0.9.0` cut (bootstrap publish, trusted-publisher
configuration, exit proof) → 111e/111f.

- **In scope:** publish metadata in every generated `package.json` (`description`, `repository`,
  `homepage`, `bugs`, `publishConfig`, `sideEffects`) and a generated per-member `LICENSE`; the
  `sideEffects` audit; an npm publisher that packs with `pnpm pack`, checks each packed manifest,
  skips an already-published version and publishes the tarball with `npm publish`; a split
  `release.yml` whose publishing job alone holds `id-token: write`, authenticated by OIDC alone,
  plus a placeholder generator for the one-time name bootstrap; `release:verify` and the `@since`
  gate re-pointed at npm, and the JSR-only checks retired with reasons; `compat/` switched to
  `@setu-ts/*` from npm; the CI dry run switched from `deno publish --dry-run` to packing and
  `npm publish --dry-run` for all 51; the pack-and-boot gate extended to install and import all 51
  tarballs and to prove the `sideEffects` declaration under a real bundler; the release runbook's
  publish sections rewritten for npm.
- **NOT this milestone:** bumping to `0.9.0` and publishing it, publishing the placeholders,
  trusted- publisher configuration and the exit proof (the cut, after 111d); the CLI `bin` and
  Node-default projects (111d); porting scripts to Node, Prettier/ESLint, removing
  `deno.json`/`deno.lock`, and moving `resolved-set.json` from `deno.lock` to `pnpm-lock.yaml`
  (111e); install lines in docs and READMEs, `docs/upgrading.md`, the JSR README/description sunset,
  and the dormant JSR admin scripts (`create-jsr-packages`, `link-jsr-repos`, `verify-jsr-repos`,
  `set-jsr-metadata`, `archive-old-scope`), which 111f uses once more to point each JSR page at npm
  (111f).

## 1. Contracts verified from SOURCE (not names)

Read on 2026-10-12 against `develop` at `9353835a` (npm 11.16.0, Node 24.18.0). External facts are
from the npm documentation pages named in the row.

| Reference                    | Source (file:line)                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release allow-list           | `scripts/release-packages.ts:20-87`                                          | 51 entries in dependency order (common → kernel → tier 3 → plugins → cli → starters); `UNPUBLISHED_PACKAGES` empty; `PUBLICATION_HOLDS` empty and enforced by the publisher, reported by `release:verify`.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| JSR publisher                | `scripts/publish-packages.ts`                                                | Spawns `deno publish --config <dir>/deno.json` per package; skips a version already in `jsr.io/@setu-ts/<pkg>/meta.json`; stops at the first failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Release workflow             | `.github/workflows/release.yml:24-26,437,457`                                | ONE job holding both `contents: write` and `id-token: write`; it installs and runs the whole Node and Deno suite (third-party install scripts included: `esbuild` is an allowed build) before `deno task release:publish`. The M111b audit recorded this as an observation.                                                                                                                                                                                                                                                                                                                                                                     |
| Generated manifest           | `scripts/node-manifests.ts:393-440`                                          | Emits `name`, `version`, `type`, `license`, `engines`, `files: ['dist','README.md']`, `exports`, `scripts`, deps. No `description`, `repository`, `homepage`, `bugs`, `publishConfig` or `sideEffects`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `sideEffects` guard          | `scripts/node-manifests.ts:112,579-600`                                      | Refuses a `decorator-plugin` manifest declaring `false` or a list omitting `./dist/metadata/symbol-metadata.js`; today no manifest declares `sideEffects`, so the guard is inert.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Side-effect imports in `src` | `grep -rn "^import '\." packages/*/src`                                      | Nine `decorator-plugin/src/decorators/*.ts` files import `../metadata/symbol-metadata.ts` for effect. One hit in `cli/src/templates/full-stack-app-files.ts:54` is inside a template string (generated code), so an audit must mask strings. Three class static blocks (`cache-plugin/src/services/cache-service.ts:46`, `health-plugin/src/services/health-service.ts:181`, `scheduler-plugin/src/services/scheduler-service.ts:96`) only assign arrow functions to module-top-level `let` bindings (`:16`, `:46`/`:73`, `:49`) — the M98 private-field seam (found by the implementer; the first draft of §3.2 would have refused all three). |
| Source masker                | `scripts/npm-specifier-audit.ts:234`                                         | `maskNonCode(source)` blanks comments and string/template contents, length-preserving; reused rather than re-implemented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Package descriptions         | `scripts/jsr-metadata.ts:83`                                                 | `PACKAGE_METADATA` holds a reviewed one-line description for all 51 packages (idempotency and localization included).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Packed-manifest check        | `scripts/node-build-gate.ts:35`                                              | `workspaceProtocolSpecifiers(manifest)` reports any `workspace:` left in shipped dependency fields; reused by the publisher.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Pack-and-boot gate           | `scripts/check-node-build.ts`                                                | Packs all 51 with `pnpm pack`, refuses `workspace:`, but installs only the kernel/runtime/decorator closure and boots one fixture on Node 24, Node 22 and Bun.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `release:verify`             | `scripts/verify-release.ts:93-156,181-243`                                   | Check 2 reads `jsr:@setu-ts/*` entries in member `deno.json` `imports`; since M111a member import maps carry no `@setu-ts` alias (e.g. `packages/kernel/deno.json`), so check 2 is vacuous. Check 5 enforces `@module`-first for jsr.io README rendering. Checks 1, 3, 4, 6, 7, 8, 9, 10 are registry-independent.                                                                                                                                                                                                                                                                                                                              |
| Version sites                | `scripts/version-sites.ts`                                                   | `deno.json`, `package.json` and `src/version.ts` must agree with the tag; unchanged here.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@since` gate                | `scripts/check-since-tags.ts:50,143,273,461,526`                             | Fetches `jsr.io/@setu-ts/<pkg>/meta.json` and the SOURCE file at the claimed version; `symbolPresent` matches a declaration regex that already accepts `declare` (`.d.ts`-compatible). A version newer than every published one is skipped, so after JSR stops every new tag would be skipped forever.                                                                                                                                                                                                                                                                                                                                          |
| Compat suite                 | `compat/package.json`, `compat/.npmrc`, `compat/compat.test.mjs:228,375`     | 49 `@jsr/setu-ts__*` deps at `latest` through `npm.jsr.io`; `idempotency-plugin` and `localization-plugin` are missing and `PENDING_FIRST_PUBLISH` is empty, so check 1 fails — the weekly run has failed since 2026-10-05 (`gh run list --workflow compat.yml`). Check 9 scans only grpc/telemetry for `npm:` in `import()`.                                                                                                                                                                                                                                                                                                                   |
| CI dry run                   | `.github/workflows/ci.yml:587-637`                                           | `publish-dry-run` runs `deno task publish:check` (`deno publish --dry-run`), `release:verify` and `check:versions`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| npm trusted publishing       | docs.npmjs.com/trusted-publishers                                            | npm CLI ≥ 11.5.1, Node ≥ 22.14.0; provenance generated automatically from a public repository with no `--provenance` flag; `repository.url` "must exactly match your GitHub repository"; configuration names owner, repo, workflow filename, optional environment. The repository is public (`gh repo view`).                                                                                                                                                                                                                                                                                                                                   |
| `npm trust`                  | docs.npmjs.com/cli/v11/commands/npm-trust                                    | npm ≥ 11.15.0 (`--allow-publish` first appears there; verified against the docs and npm 11.16.0's help): `npm trust github <pkg> --file release.yml --repo setu-ts/setu-ts --env <name> --allow-publish --yes`; the package must already exist; account 2FA required, with a 5-minute skip window that covers a scripted loop over all 51.                                                                                                                                                                                                                                                                                                      |
| Trust expiry                 | docs.npmjs.com/trusted-publishers ("Trusted publisher configuration expiry") | A new configuration must complete its first successful publish THROUGH it within 2 days, which validates it and binds it to the repository's identity; otherwise it expires and must be deleted and recreated. npm does not check a configuration when it is saved. OIDC is tried before any token.                                                                                                                                                                                                                                                                                                                                             |
| Registry state               | `npm view @setu-ts/kernel`                                                   | `E404`: nothing is published under `@setu-ts`; the organization exists (claimed 2026-10-10, owner `dkpaul91`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                         | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                                       |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP 111c: "Blocked on the maintainer claiming the `@setu-ts` npm organization." The organization was claimed on 2026-10-10.                                                                                                                                                                                                  | Reality. The block is gone.                                                                                                                                                                                                                                                                                                                                       | ROADMAP 111c bullet replaced with the claim date and owner; the measured-coupling table row updated the same way.                               |
| C2 | ROADMAP 111c bundles the machinery and the first publish, with an exit criterion of a live `npm install`. The publish cannot precede 111d (§0).                                                                                                                                                                                  | Split. 111c ends at a proven, dry-run-gated machinery; the cut after 111d performs the bootstrap, the trust configuration and the live exit proof.                                                                                                                                                                                                                | ROADMAP 111c objective and exit rewritten; a "v0.9.0 cut" block added after 111d listing those three steps; the Sequencing paragraph corrected. |
| C3 | ROADMAP's bootstrap is a manual local publish of the real release, while its exit criterion requires "provenance on all packages". A local publish produces no provenance, so `0.9.0` itself would carry none; and a trusted-publisher configuration made AFTER that publish is validated by nothing and expires in 2 days (§1). | The local publish is of a README-only PLACEHOLDER version, which only creates the names; trust is configured next, and `0.9.0` is the first publish through it, from `release.yml` by OIDC (§3.6). That one publish validates all 51 configurations and carries provenance, so the exit criterion holds for every real version. No npm token exists at any point. | ROADMAP bootstrap bullet rewritten; `docs/releasing.md` one-time setup rewritten.                                                               |
| C4 | ROADMAP 111f owns `docs/releasing.md`, but the `v0.9.0` cut, which precedes 111f, follows that runbook.                                                                                                                                                                                                                          | The publish-mechanics sections move here (one-time setup, publish, partial-failure recovery, verification); prose describing the toolchain generally stays with 111f.                                                                                                                                                                                             | `docs/releasing.md` publish sections rewritten; ROADMAP 111f bullet narrowed to "the remaining toolchain prose".                                |
| C5 | ROADMAP 111c: "`compat/` … becomes the post-publish proof". The compat weekly run has failed since 2026-10-05 because two members never reached JSR.                                                                                                                                                                             | The switch to npm fixes the coverage gap; until the first npm publish the workflow reports the scope as unpublished rather than failing (§3.9).                                                                                                                                                                                                                   | `compat/README.md` and the `compat.yml` header rewritten.                                                                                       |
| C6 | `CLAUDE.md` (Verification, Before-reporting), `AGENTS.md:70`, `apps/graphql-demo/README.md:79` and `scripts/version-sweep.ts:18` name `deno task publish:check` as a mandatory gate; §3.10 removes that task.                                                                                                                    | The gate is replaced, not dropped: `deno task release:publish --dry-run` packs and checks every tarball, and `tsc -b` with `isolatedDeclarations` covers the slow-type rule.                                                                                                                                                                                      | Each named site re-pointed in the same PR (§5).                                                                                                 |

## 3. Design decisions

### 3.1 Publish metadata is generated, like the rest of the manifest

- **Decision:** `renderPackageJson` adds `description` (from `PACKAGE_METADATA`; a member without an
  entry is a generator refusal), `repository`
  (`{ type: 'git', url: 'git+https://github.com/setu-ts/setu-ts.git', directory: '<member dir>' }`),
  `homepage` (the member's tree URL on GitHub), `bugs` (the repository's issues URL),
  `publishConfig: { access: 'public' }`, `sideEffects` (§3.2), and `LICENSE` and `src` in `files`.
  `src` ships because `tsconfig.base.json` sets `sourceMap` and `declarationMap`: every `.js.map`
  and `.d.ts.map` in `dist` points at `../src/*.ts`, which today's `files: ['dist', 'README.md']`
  leaves out of the tarball, so go-to-definition lands in `.d.ts` and Vite warns about a source map
  pointing at missing sources. Turning the maps off was the alternative and was rejected: it loses
  go-to-source for every consumer to save tarball bytes. The generator also writes
  `<member>/LICENSE` as a byte copy of the root `LICENSE`; `--check` refuses a drifted copy.
  `provenance` is NOT put in `publishConfig`: it would make a local `npm publish` (the §8 risk 1
  fallback) fail outright.
- **Why:** `repository.url` must match the repository exactly for provenance to verify (§1); scoped
  packages default to restricted access, so a first publish without `access: public` fails; npm
  renders `description` in search results. One generator keeps 51 manifests from drifting, and a
  generated copy keeps one source for the licence text.
- **Test home:** `test/unit/node-manifests.test.ts` (each field rendered; missing description
  refused; drifted `LICENSE` refused); negative control: delete `repository` from the renderer →
  `release:verify` check 11 (§3.7) and the packed-manifest check (§3.4) both fail.

### 3.2 `sideEffects` is decided per package by an audit

- **Decision:** new `scripts/side-effects.ts` exports `auditSideEffects(files)`, which masks each
  `src` file with `maskNonCode` and reports (a) a top-level expression statement, (b) a top-level
  side-effect-only import (`import './x'`) and the module it names, and (c) a class static block,
  unless every top-level statement in that block is `<name> = <function or arrow expression>;` where
  `<name>` is declared by a top-level `let` in the SAME module. That form is the private-field seam
  the M98 collectors use (`cache-service.ts:46`, `health-service.ts:181`,
  `scheduler-service.ts:96`): it writes only a module-local binding, runs no call, and is invisible
  outside the module, so a bundler dropping the module loses nothing. Any other statement in a
  static block — a call, an assignment to a global, an import or another module's binding, or a
  right-hand side that is not a function — is a finding. A committed table in the same file lists
  every module allowed to have effects, with its reason — today exactly `decorator-plugin`'s
  `src/metadata/symbol-metadata.ts`. A finding not in the table is a refusal; a table entry with no
  finding is a refusal (stale). The generator emits `"sideEffects": false` for a member with no
  table entry and a list of the members' `dist` paths otherwise. The existing
  `checkDecoratorSideEffects` guard stays as the specific backstop.
- **Why:** bundlers tree-shake whole modules under `sideEffects: false`; Workers projects are
  bundled by esbuild through wrangler, so this is real size. A wrong `false` silently drops code, so
  the audit refuses rather than guesses, and the table entry carries the reason a human approved.
  The audit is a heuristic (a top-level `const x = f()` whose `f` mutates globals is not seen); the
  bundler proof in §3.8 is what tests the one known effect end to end.
- **Test home:** `test/unit/side-effects.test.ts` (each finding kind; masked template text ignored;
  unlisted finding and stale entry refused; the three real seam files classified local and not
  reported; static-block negatives — a call, `globalThis.x = …`, an assignment to an imported name,
  a non-function right-hand side, and an assignment to a `let` declared only inside a function —
  each reported); `check:node-build`'s bundle leg (§3.8).

### 3.3 Packing and publishing: `pnpm pack`, then `npm publish <tarball>`

- **Decision:** new `scripts/npm-publish.ts` (orchestration) replaces `publish-packages.ts` behind
  `deno task release:publish`. It refuses an active publication hold (`scripts/publication-hold.ts`,
  unchanged) and an npm older than 11.5.1 (the trusted-publishing floor, §1; checked from
  `npm --version`, since `setup-node` takes whatever npm the latest Node 24 bundles), runs one
  `tsc -b`, then for each member of `PUBLISHED_PACKAGES` in order: `pnpm pack --ignore-scripts` into
  `.tmp/npm-pack/`; read the packed `package.json` and refuse on any §3.4 problem; skip when the
  registry packument already lists the version; otherwise
  `npm publish <tarball> --access public --tag <tag> --ignore-scripts` (plus `--provenance` when
  `GITHUB_ACTIONS` is `true`), stopping at the first failure. No member declares a lifecycle script
  today (the generated `scripts` holds only `build`); `--ignore-scripts` keeps it that way inside
  the job holding `id-token: write` whatever a later manifest adds. `--dry-run` does everything
  except the upload: it packs, checks, **performs the packument lookup** (an unauthenticated GET)
  and runs `npm publish --dry-run`. The lookup stays in the dry run deliberately — `v0.1.0-alpha.2`
  failed its first real publish because the JSR dry run skipped the already-published check, so the
  `--allow-net` that check needed was never exercised; a dry run that skips the lookup repeats that
  failure. The tag is `latest` for a release version and `next` for a prerelease: npm refuses a
  prerelease without `--tag`, and `next` keeps a prerelease from becoming what a bare install
  resolves.
- **Why:** pnpm rewrites `workspace:^` to `^<version>` only when it packs; publishing the packed
  tarball means the bytes checked are the bytes uploaded. Publishing per package in dependency order
  and skipping published versions keeps the JSR publisher's resumability (npm versions are never
  reusable, so a re-run must not attempt one).
- **Test home:** the pure core in §3.4; CI's dry-run job (§3.10) runs the orchestration for all 51.

### 3.4 Packed-manifest checks are one pure module

- **Decision:** new `scripts/npm-release-gate.ts` exports
  `packedManifestProblems(manifest,
  expected)` — name under `@setu-ts/`, `version === expected`,
  no `workspace:` (delegating to `workspaceProtocolSpecifiers`), every shipped `@setu-ts/*`
  dependency equal to `^expected`, `repository.url` equal to the one constant,
  `publishConfig.access === 'public'`, `license` present, `files` containing `dist` and `src` — plus
  `packumentHasVersion(packument, version)`, `distTagFor(version)` and
  `npmSupportsTrustedPublishing(versionText)`. The publisher and `release:verify` check 11 both call
  it.
- **Why:** one implementation for the two entry points (the publish path and the PR gate), and the
  rules a publish depends on are decidable without a network.
- **Test home:** `test/unit/npm-release-gate.test.ts`, one table of manifests, each violating one
  rule.

### 3.5 `release.yml`: gates, publish and the Release object are separate jobs

- **Decision:** three jobs. `gates` (`contents: read`, no `id-token`) runs every gate the current
  job runs, `release:verify`, the version sweep and the resolved-set generation, uploading
  `resolved-set.json` as an artifact. `publish` (`needs: gates`, GitHub environment `npm`,
  `id-token: write`, `contents: read`) checks out with `persist-credentials: false`, sets up Node 24
  with `registry-url: https://registry.npmjs.org`, pnpm and Deno, runs
  `pnpm install --frozen-lockfile --ignore-scripts`, then `deno task release:publish`. `release`
  (`needs: publish`, `contents: write`) downloads the artifact and creates the GitHub Release as
  today. The workflow file keeps its name, `release.yml`, because the trusted-publisher
  configuration names it.
- **Why:** the M111b audit observed that third-party install scripts run in the job holding the
  publish credential. With the split, the job that can publish installs with scripts disabled (`tsc`
  needs none) and runs no test code; the environment narrows the trust claim to that job.
- **Test home:** `test/apps-gate.test.ts` (new assertions: `id-token: write` appears only in the
  `publish` job; that job's install carries `--ignore-scripts`; it names environment `npm`);
  `release:verify` check 8 is updated to read the artifact upload in its new place.

### 3.6 Authentication: OIDC only, after a placeholder bootstrap

- **Decision:** `release.yml` publishes by OIDC alone; no job reads an npm token, and no secret is
  added. Trusted publishing needs each package to exist (§1), so the names are created once by a
  placeholder: new `scripts/npm-placeholders.ts` writes, for every member of `PUBLISHED_PACKAGES`, a
  directory under `.tmp/npm-placeholders/` holding a `package.json` (`name`, version
  `0.0.0-bootstrap.0`, the §3.1 `description`, `license`, `repository`, `publishConfig.access`) and
  a README saying the version is a placeholder and naming the first real release. It publishes
  nothing; `deno task release:placeholders` runs it. The cut's one-time procedure in
  `docs/releasing.md`, in order: (1) create the `npm` GitHub environment with the maintainer as
  required reviewer; (2) generate the placeholders and publish each locally with the maintainer's
  2FA, `npm publish --tag bootstrap --access public`; (3) run the trust loop
  (`npm trust github …
  --file release.yml --repo setu-ts/setu-ts --env npm --allow-publish --yes`
  over the 51 names, npm ≥ 11.15.0); (4) within 2 days, tag `v0.9.0` — the first publish through
  each configuration, which validates it; (5) confirm with `npm trust list`, then deprecate every
  placeholder version, remove the `bootstrap` dist-tag, and set each package's publishing access to
  "Require two-factor authentication and disallow tokens", which npm documents as leaving trusted
  publishing working. If step 4 misses the window, or the 0.9.0 run stops part-way, the runbook says
  to re-run the publisher (it skips published versions) before the window closes, or else delete and
  recreate the expired configurations and publish within 2 days of that.
- **Why:** a placeholder is the smallest thing that can create a name, and it needs no provenance,
  so it can be published by hand. Configuring trust before the real release lets `0.9.0` validate
  the configurations and carry provenance, where publishing `0.9.0` first would leave every
  configuration unvalidated and expiring 2 days later (§1). It also removes the only npm token the
  previous design needed, together with the question of whether a token may create scoped packages.
- **Test home:** `test/unit/npm-placeholders.test.ts` (one placeholder per published member, no
  `dist`, `src` or `scripts` in it, the version string, the README naming the release); the
  remaining steps are one-time maintainer actions, and the cut's exit proof checks provenance on
  every `0.9.0` package and `latest` pointing at it.

### 3.7 `release:verify` re-pointed

- **Decision:** check 2 is replaced: every `@setu-ts/*` entry in a published member's shipped
  dependency fields must be `workspace:^`, the only form pnpm rewrites to the released caret. Check
  5 (`@module`-first) is retired: npm always renders `README.md`, so the JSR fallback it guarded
  does not exist there; it is replaced by "`README.md` exists and is non-empty". New check 11 runs
  `packedManifestProblems` over each member's SOURCE `package.json` with the `workspace:` rule
  relaxed (the packed form is checked at publish). The header comment is rewritten to describe the
  checks that exist.
- **Why:** check 2 currently checks nothing, and check 5 guards a JSR behaviour. Retiring them is
  stated in the header and the CHANGELOG, never silent.
- **Test home:** `test/unit/npm-release-gate.test.ts` (the shared rules); the CI job runs
  `release:verify` on every PR.

### 3.8 The pack-and-boot gate installs everything and bundles once

- **Decision:** `check-node-build.ts` installs all 51 tarballs (not the three-package closure) with
  plain `npm install`, and the fixture imports every package and asserts each exposes a surface, on
  Node 24, Node 22 and Bun. A new bundle leg runs esbuild (root devDependency, `0.28.2`) with
  `bundle: true` and tree shaking over a fixture importing one decorator, writes the bundle, and
  runs it on Node 24: the decorated controller must serve, which only holds if the bundle installs
  `Symbol.metadata` (Node 24 lacks it).
- **Why:** this is the pre-publish equivalent of `compat/`, run on every PR, and the one end-to-end
  proof that a bundled decorated application still installs its metadata carrier.
- **What the bundle leg does NOT prove (measured during implementation, 2026-10-12):** it cannot
  tell the declared retention list from `sideEffects: false`. Every module that defines a decorator
  also imports `requireDecoratorMetadata` from `metadata/symbol-metadata.ts` as a VALUE (directly,
  or through `metadata/context-bridge.ts:42`); the only effect-only importer,
  `decorators/response-status.ts`, defines no decorator. Any bundle that uses a decorator therefore
  keeps the module and its top-level `installSymbolMetadata(...)` statement under both declarations.
  With the renderer forced to `false` and the guard removed, all four legs passed. The retention
  list stays because it is the true statement about that module and protects a future effect-only
  importer, but it is enforced by the §3.2 audit and `checkDecoratorSideEffects` at generation, not
  by this leg.
- **Test home:** `test/unit/node-build-gate.test.ts` (any new pure helper); the CI `node-build` job.
  Negative control, applied to a scratch copy of the packed `decorator-plugin` and never committed:
  delete the top-level `installSymbolMetadata(...)` call from `dist/metadata/symbol-metadata.js` →
  the bundle leg fails on Node 24 with `DecoratorMetadataUnavailableError`, proving the leg detects
  a bundle that lost the install. The retention list's own control is unit level: the
  `sideEffects: false` rendering for `decorator-plugin` is refused by the generator guard
  (`test/unit/node-manifests.test.ts`).

### 3.9 `@since` is checked against npm for versions after the JSR line

- **Decision:** `check-since-tags.ts` gains a registry router: a tag naming `0.8.x` or earlier is
  checked against JSR as today; a later version is checked against npm. For npm it fetches the
  packument (`registry.npmjs.org/@setu-ts%2f<pkg>`), skips or reports an unpublished version by the
  existing rules, downloads the version's tarball, gunzips it with `DecompressionStream`, reads it
  with a new pure ustar reader (`scripts/tar-read.ts`), and reads the tag's file at
  `package/src/<path>.ts` — the source the tarball now ships (§3.1) — so `symbolPresent` reads the
  same text it reads from JSR today. Tarballs are cached per run like JSR files. The task's
  `--allow-net` grows to `registry.npmjs.org`. The ustar reader handles pax extended headers
  (`x`/`g`, whose `path` overrides the entry name) as well as the ustar prefix, since node-tar
  writes pax headers for paths it cannot split.
- **Why:** after `0.8.0` nothing reaches JSR, so every new tag would be skipped forever. Reading
  `dist` instead was considered and rejected: `DECLARATION` matches non-exported declarations, and a
  non-exported interface or type appears in neither `.d.ts` nor `.js`, so its tag would read as
  absent and fail the gate on a correct claim.
- **Test home:** `test/unit/check-since-tags.test.ts` (routing by version; npm present/absent/
  unpublished cases through the injected fetch); `test/unit/tar-read.test.ts` (headers, padding,
  long names via the ustar prefix and via a pax `path` record, truncated archive refused).

### 3.11 Release notes name the npm install

- **Decision:** `buildReleaseBody` in `scripts/release-notes.ts:50` emits
  `npm install @setu-ts/kernel@<version> @setu-ts/runtime@<version>` instead of
  `deno add jsr:@setu-ts/kernel@<version> jsr:@setu-ts/runtime@<version>`; its JSDoc's JSR rationale
  for pinning is replaced (the line stays pinned, so a reader of an older Release installs that
  release).
- **Why:** this line is part of the release machinery, not the documentation 111f owns. The `v0.9.0`
  cut precedes 111f, so left alone the first npm Release would tell readers to install a version JSR
  never receives.
- **Test home:** `test/unit/release-notes.test.ts` (the body names the npm line and no `jsr:`
  specifier; it currently pins `jsr:@setu-ts/kernel@0.1.0-alpha.9` at line 71).

### 3.10 CI dry run and compat switch to npm

- **Decision:** `ci.yml`'s `publish-dry-run` job keeps its id
  (`test/unit/release-notes.test.ts:270,290` pins `release:verify` inside it by that id) and becomes
  "npm publish dry-run": Node 24, pnpm, Deno, `deno task release:publish --dry-run`, then
  `release:verify` and `check:versions` as today. `publish:check` (`deno publish --dry-run`) is
  removed from `deno.json`: its slow-type rule is covered by `isolatedDeclarations` in the `tsc -b`
  build. `compat/package.json` depends on all 51 `@setu-ts/*` at `latest`; `.npmrc` is deleted;
  imports drop `@jsr/`; check 9 scans every installed package's `dist` for an `npm:`/`jsr:`
  specifier inside `import()` (the version guard goes, since npm never received the broken build).
  `compat.yml` gains a first step that requests `registry.npmjs.org/@setu-ts%2fcommon`: `404` sets
  `published=false` and the suite steps are skipped with a notice; `200` runs them; any other status
  fails the job.
- **Why:** both checks test the artifacts consumers install. The probe distinguishes "nothing
  published yet" from a registry fault, and arms itself on the first publish with no edit.
- **Test home:** `test/apps-gate.test.ts` (the probe step and its status handling are present); the
  compat suite itself after the cut.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No package `src/index.ts` changes; the only consumer-visible
change is the published manifest gaining `sideEffects`, recorded in the CHANGELOG.

| Exported symbol                                                                               | Kind     | Consumer / real code path that READS it                                                        |
| --------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| (no package barrel change)                                                                    | —        | —                                                                                              |
| `auditSideEffects`, `SIDE_EFFECT_MODULES` (`scripts/side-effects.ts`)                         | fn/const | `scripts/node-manifests.ts` (renders `sideEffects`, refuses findings).                         |
| `packedManifestProblems`, `packumentHasVersion`, `distTagFor` (`scripts/npm-release-gate.ts`) | fn       | `scripts/npm-publish.ts`; `scripts/verify-release.ts` check 11.                                |
| `placeholderFiles` (`scripts/npm-placeholders.ts`)                                            | fn       | `release:placeholders` task, run once at the cut (§3.6).                                       |
| `readTar` (`scripts/tar-read.ts`)                                                             | fn       | `scripts/check-since-tags.ts` npm path.                                                        |
| `REPOSITORY_URL` (`scripts/npm-release-gate.ts`)                                              | const    | `scripts/node-manifests.ts` (renders it) and `packedManifestProblems` (checks it): one source. |

### 4.1 Options — every option names its consumer

| Option                       | Consumer                 | Behavior (per implementation)                                                        |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------ |
| `release:publish --dry-run`  | CI `publish-dry-run` job | Packs, checks, looks each version up and `npm publish --dry-run`s all 51; no upload. |
| `GITHUB_ACTIONS` (env, read) | `scripts/npm-publish.ts` | `true` adds `--provenance`; otherwise none (a local publish cannot produce one).     |

## 5. Implementation files

| File                                                                                        | Purpose                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `scripts/node-manifests.ts`                                                                 | §3.1 fields, `LICENSE` copies, `sideEffects` from §3.2                                          |
| `scripts/side-effects.ts`                                                                   | §3.2 audit and table                                                                            |
| `scripts/npm-release-gate.ts`                                                               | §3.4 pure checks                                                                                |
| `scripts/npm-publish.ts` (replaces `scripts/publish-packages.ts`)                           | §3.3 orchestration                                                                              |
| `scripts/npm-placeholders.ts`                                                               | §3.6 placeholder generator; `release:placeholders` task in `deno.json`                          |
| `scripts/tar-read.ts`, `scripts/check-since-tags.ts`                                        | §3.9                                                                                            |
| `scripts/verify-release.ts`                                                                 | §3.7                                                                                            |
| `scripts/check-node-build.ts`, `scripts/fixtures/node-boot/**`                              | §3.8                                                                                            |
| `scripts/release-packages.ts`, `scripts/publication-hold.ts`                                | comments re-pointed at npm; list and hold logic unchanged                                       |
| `scripts/release-notes.ts`                                                                  | §3.11                                                                                           |
| `scripts/script-coverage.ts`                                                                | `side-effects.ts`, `npm-release-gate.ts`, `tar-read.ts`, `npm-placeholders.ts` added as targets |
| `packages/**/package.json`, `packages/**/LICENSE`                                           | regenerated                                                                                     |
| `deno.json`                                                                                 | `release:publish` → npm publisher; `publish:check` removed; since-tags net                      |
| `.github/workflows/release.yml`, `ci.yml`, `compat.yml`                                     | §3.5, §3.10                                                                                     |
| `compat/package.json`, `compat/compat.test.mjs`, `compat/README.md`; delete `compat/.npmrc` | §3.10                                                                                           |
| `docs/releasing.md`, `ROADMAP.md`, `CHANGELOG.md`, `CLAUDE.md`                              | C1–C5, Unreleased entry, status flip                                                            |
| `CLAUDE.md`, `AGENTS.md`, `apps/graphql-demo/README.md`, `scripts/version-sweep.ts`         | C6: every `publish:check` reference re-pointed at `release:publish --dry-run`                   |
| `test/unit/release-notes.test.ts`                                                           | §3.11 install line; the `publish-dry-run` pins kept                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

No package `src` file changes. Every new or changed pure script module is a `SCRIPT_TARGETS` entry
held to the 90% bar by `scripts/script-coverage.ts`; orchestration files (`npm-publish.ts`,
`check-node-build.ts`, `verify-release.ts`) stay out, as `check-apps.ts` does.

| Test file                                   | src covered                   | Key assertions                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/side-effects.test.ts`            | `scripts/side-effects.ts`     | expression statement, effect import, static block each found; masked string ignored; unlisted finding and stale entry refused.                                                              |
| `test/unit/npm-release-gate.test.ts`        | `scripts/npm-release-gate.ts` | one manifest per rule violated (`src` missing from `files` included); a valid manifest passes; packument lookup; `latest` vs `next`; npm `11.5.0` refused, `11.5.1` and `11.16.0` accepted. |
| `test/unit/npm-placeholders.test.ts`        | `scripts/npm-placeholders.ts` | one placeholder per published member; no code, `scripts` or `files` beyond README; version `0.0.0-bootstrap.0`; README names the first release.                                             |
| `test/unit/tar-read.test.ts`                | `scripts/tar-read.ts`         | multi-entry archive; ustar prefix names; 512-byte padding; truncated or corrupt header refused.                                                                                             |
| `test/unit/check-since-tags.test.ts` (ext.) | `scripts/check-since-tags.ts` | `0.8.x` routed to JSR, later to npm; symbol present and absent in the tarball's `src`, non-exported type included; unpublished version skipped or reported; cache reuse.                    |
| `test/unit/release-notes.test.ts` (ext.)    | `scripts/release-notes.ts`    | body carries the pinned `npm install` line and no `jsr:` specifier.                                                                                                                         |
| `test/unit/node-manifests.test.ts` (ext.)   | `scripts/node-manifests.ts`   | new fields; description refusal; `LICENSE` drift; `sideEffects` false vs list.                                                                                                              |
| `test/apps-gate.test.ts` (ext.)             | workflows                     | `id-token: write` only in `publish`; no `secrets.` reference and no `NODE_AUTH_TOKEN` assignment in `publish`; `--ignore-scripts`; environment `npm`; compat probe step.                    |

Negative controls (each observed failing, then reverted): drop `repository` from the renderer;
publish a packed manifest whose `@setu-ts` dependency is `^0.7.0`; delete the packed install call
from a scratch `decorator-plugin` tarball (bundle leg, §3.8); render `decorator-plugin`
`sideEffects: false` (refused by the generator guard); route `0.9.0` to JSR (`@since` npm cases);
put `id-token: write` back at workflow level (apps-gate). The `@since` routing control and the
removed-packument-lookup control must fail BEHAVIOURALLY: a mutation that fails type checking proves
nothing, so each is applied in a form that still type-checks.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m111c-npm-publish
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # root and script targets; ≥90% branch/function/line per file
pnpm test:coverage          # unchanged packages, still green
deno run -A scripts/node-manifests.ts --check
deno task check:node-build --require-all
deno task release:publish --dry-run
deno task release:verify 0.8.0
deno task check:docs
```

## 8. Risks & mitigations

1. **The 2-day trust window is missed, or the 0.9.0 run stops part-way** (§1). → The publisher is
   resumable and skips published versions, so a re-run inside the window validates the remaining
   configurations; past the window the runbook deletes and recreates the expired ones. Configuring
   trust is the last step before tagging, so the window is spent waiting only on CI.
2. **`repository.url`'s exact expected form is not spelled out** in the npm docs. → The value is one
   constant (§4); the first publish rejects a mismatch with a provenance error before any package
   goes live, and the publisher stops at the first failure.
3. **`npm publish` of a tarball with provenance or OIDC behaving differently from a directory
   publish.** → The CI dry run exercises the tarball path on every PR; the 0.9.0 publish does
   `common` first, so a failure costs nothing else.
4. **The `sideEffects` audit misses an effect** (a value initializer that mutates global state). →
   The bundle leg proves the one known effect; the table requires a reason per entry; `false` can be
   relaxed in a patch, since it only changes what bundlers may drop.
5. **The compat probe could hide a broken registry once packages exist.** → Only a `404` skips; any
   other status fails, and after the first publish the probe always answers `200`.
6. **`npm publish --dry-run --provenance` behaving differently without `id-token: write`** (the CI
   dry-run job has none, and the npm docs say nothing about provenance on a dry run). → Measured on
   the first CI run of the dry-run job; if npm refuses, the publisher omits `--provenance` only when
   `--dry-run` is set, and the `0.9.0` run is the one that exercises provenance.
7. **51 local placeholder publishes each asking for a 2FA code.** → A one-time cost, accepted; the
   runbook passes `--otp` per command. Whether the registry also points `latest` at a placeholder
   published under `--tag bootstrap` is unverified; the `0.9.0` publish under `--tag latest`
   overwrites it, and the exit proof checks `latest`.
8. **`--ignore-scripts` in the publish job could break the build** if a build step needs a native
   binary. → `tsc` is pure JavaScript; the CI dry run uses the same install flags.

## 9. Out of scope

- The `v0.9.0` bump, publish, trust configuration and live install proof — the cut, after 111d.
- `bin` for `setu` and Node-default generated projects — 111d.
- `resolved-set.json` from `pnpm-lock.yaml`, porting scripts to Node, removing Deno tooling — 111e.
- Install lines, `docs/upgrading.md`, JSR page sunset and the dormant JSR admin scripts — 111f.

## 10. Security design review

This milestone changes who can publish and with what credential, so it crosses a trust boundary and
needs a committed-tree security audit (`.roo/skills/security-audit/SKILL.md`) in a fresh context
before merge.

| Asset / boundary                    | Threat                                                         | Mitigation in this design                                                                                                |
| ----------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| npm publish credential (OIDC token) | Third-party install scripts or test code reach the token       | Only the `publish` job has `id-token: write`; it installs with `--ignore-scripts` and runs no tests (§3.5).              |
| Trusted-publisher claim             | Any workflow job in the repository can publish                 | Trust bound to `release.yml` and environment `npm`; the environment can carry required reviewers.                        |
| Placeholder publish                 | A placeholder ships code, or a token is created for it         | Generated README-only manifests (§3.6, tested); published by the maintainer with 2FA, no token at any point.             |
| Any npm token after the bootstrap   | A leaked or re-added token publishes outside `release.yml`     | Every package set to "Require 2FA and disallow tokens" after the trust loop; trusted publishing keeps working (§3.6).    |
| Lifecycle scripts at publish time   | A manifest script runs inside the job holding `id-token`       | `pnpm pack --ignore-scripts` and `npm publish --ignore-scripts` (§3.3), beside the install's `--ignore-scripts`.         |
| Published tarball content           | A dev dependency, test file or local path ships                | `files` limits the tarball; packed-manifest checks run on the exact bytes uploaded (§3.4); dry run lists contents in CI. |
| Dependency ranges in tarballs       | A stale or `workspace:` range installs the wrong or no version | `workspace:` and non-`^<version>` in-repo ranges refused before upload (§3.4).                                           |
| `@since` / compat network fetches   | Registry responses parsed as trusted                           | Read-only fetches; the tar reader bounds sizes and refuses malformed headers; nothing fetched is executed by the gates.  |

> **Correction — committed-tree security audit, 2026-10-12 (fixed on this branch, not re-audited at
> the maintainer's direction).** The audit of `c8f1f86d` failed on four findings this design review
> missed. F1 (Medium): trust is bound to `release.yml` and environment `npm` but NOT to a ref, and a
> `workflow_dispatch` with the dry-run input false made a real OIDC publish from any branch,
> skipping the tag-only checks. The publish and release jobs now run only on a pushed `v*` tag, a
> manual run rehearses the publisher inside the gates job, and the runbook restricts environment
> `npm` to `v*` tags (the control a branch cannot edit away). F2 (Medium): the publish job ran
> actions referenced by movable tags (`setup-deno@v2` is a branch); every action in `release.yml` is
> now pinned to a commit SHA. F3 (Low): the `@since` gate gunzipped registry tarballs without a
> bound; `gunzipBounded` caps output at 64 MiB. F4 (Low): "no npm token at any point" was false,
> since `npm login` stores a publish-capable session token; the runbook now logs out at the end of
> every step that logs in. All four carry a test that fails without the fix.
