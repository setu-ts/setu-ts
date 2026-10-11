# Releasing to npm

The npm publisher ships all 51 workspace members as `@setu-ts/*`. M111c builds the machinery; it
publishes nothing. The first real npm release, `v0.9.0`, waits for M111d's npm scaffolding. Existing
versions through `0.8.0` remain on JSR. npm versions cannot be reused.

## One-time setup — at the cut, after M111d

The `@setu-ts` npm organization was claimed on 2026-10-10 by `dkpaul91`. Create the GitHub `npm`
environment with the maintainer as required reviewer, and set its deployment branches and tags to
**Selected** with the single tag rule `v*`. Add a repository tag ruleset that lets only the
maintainer create or move `v*` tags. The environment rule is the control that matters: a manual
`workflow_dispatch` runs the dispatched branch's own copy of `release.yml`, so the workflow's
tag-only guard on the publish job can be edited away on a branch, while the environment refuses to
hand an OIDC token to anything but a `v*` tag. Use Node ≥22.14.0 and npm ≥11.15.0 for the trust
commands (publishing itself requires npm ≥11.5.1). Never create an npm access token and never add an
npm authentication secret to a workflow.

`npm login` is the one exception to "no token": it stores a session token in `~/.npmrc` that can
publish `@setu-ts` packages until it is revoked. Log in at the start of each step below that needs
it and run `npm logout` (which revokes that token on the registry) at the end of the same step, so
no session outlives a sitting.

1. Run `npm login` locally with the maintainer account and 2FA, then generate and publish the
   README-only `0.0.0-bootstrap.0` placeholders, and run `npm logout` when the loop finishes:

   ```fish
   deno task release:placeholders
   for dir in .tmp/npm-placeholders/*
       read -P "2FA code for $dir: " otp
       npm publish "$dir" --tag bootstrap --access public --ignore-scripts --otp "$otp"; or break
   end
   ```

   The placeholders only create names. Inspect the output first; it contains no framework code. A
   partial run can be resumed by publishing only missing names, checked with `npm view`.

2. Prepare the reviewed `0.9.0` release tree before configuring trust. Then configure all 51
   packages immediately before tagging. npm's 2FA skip window covers a scripted trust loop:

   ```fish
   for dir in .tmp/npm-placeholders/*
       set name (node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).name" "$dir/package.json")
       npm trust github "$name" --file release.yml --repo setu-ts/setu-ts --env npm --allow-publish --yes; or break
   end
   ```

   Log in before the loop and run `npm logout` after it. A new configuration expires unless its
   first successful publish THROUGH that configuration completes within two days. Saving it does not
   validate it. Preserve `release.yml`'s filename and environment `npm`, since both are part of the
   trust claim.

3. Within two days, push the reviewed `v0.9.0` tag. This is the first real publish, through OIDC,
   and validates every configuration while generating provenance. Follow the verification below.
   Confirm each configuration with `npm trust list <package>`.

4. Deprecate every placeholder and remove its tag:

   ```fish
   for dir in .tmp/npm-placeholders/*
       set name (node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).name" "$dir/package.json")
       npm deprecate "$name@0.0.0-bootstrap.0" 'Name placeholder; install 0.9.0 or later.'; or break
       npm dist-tag rm "$name" bootstrap; or break
   end
   ```

   In every package's publishing-access settings, select **Require two-factor authentication and
   disallow tokens**. This leaves trusted publishing working. Then run `npm logout`. From here on no
   token, session or otherwise, can publish; only `release.yml` on a `v*` tag in environment `npm`
   can.

The procedure follows [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) and
[npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust).

## Cutting a release

### 1. Prepare on a release branch

Cut a `release/vX.Y.Z` branch from `develop` in an isolated worktree. `main` holds only the last
release. From `0.9.0`, a patch is normal; a minor carries batched breaking changes. Read the
shipping CHANGELOG section: a `BREAKING` entry requires a minor. `release:verify` refuses a breaking
patch or a quiet minor unless `--allow-quiet-minor` is deliberate.

```fish
deno task release:bump 0.9.0 --dry-run
deno task release:bump 0.9.0
deno run -A scripts/node-manifests.ts --write
```

The bump refuses a dirty tree. Read its diff and residual sweep; never bump an `@since` tag. Member
manifests carry `workspace:^` internal dependencies. pnpm rewrites them to the current `^<version>`
only during pack, and the publisher checks the packed result before upload. New members need their
own placeholder and trust configuration before their first real release.

- **`release:bump` moves the SDK's `SDK_VERSION` literal** in
  `packages/sdk/src/http/observed-fetch.ts` (M98n). It is the version the observed-fetch
  registration plugin reports, written as a literal because the browser-portable SDK does not import
  its own manifest; `observed-fetch-plugin.test.ts` pins it to `packages/sdk/deno.json`, so a missed
  bump fails the suite rather than shipping.
- **Package sources carry no registry specifier.** Before M111a, `packages/sdk` wrote
  `jsr:@setu-ts/common` inline in its sources and pinned it in its manifest, so a release had to
  move both. Sources now import bare package names, and `scripts/npm-specifier-audit.ts` refuses any
  `npm:` or `jsr:` specifier under `packages/*/src`, so there is nothing to grep for. **Never bump
  an `@since` tag**: it records when a symbol appeared, so moving it makes it a lie.
- **Move the version in the 15 tracked `apps/*/deno.lock` files, and do it with `sed`, not by
  regenerating.** Each records its workspace members under `workspace.links` — a site no gate sees,
  because every example maps `@setu-ts/*` at `../../packages/<name>/src` and nothing installs from
  these locks. Rewrite the `@setu-ts` version tokens in place (both the full `@0.4.0` and the bare
  `@0.4` forms appear), then run the same entry points `check:apps` uses to confirm Deno accepts the
  result **unchanged** — `main.ts smoke.ts`, plus `worker.ts` where it exists.

  **Do not reach for `deno check` alone to regenerate them.** With the members bumped and the lock
  still naming the old version, Deno rebuilds the whole file and re-resolves every third-party range
  as well — cutting `v0.5.0` that way silently moved `@hono/hono` `4.13.5` → `4.13.7` plus several
  npm transitives across all 15 locks. That is dependency drift riding into a release PR, which the
  weekly **Dependency drift** workflow exists to review separately. Rewritten in place the locks
  already agree with the tree, so `deno check` re-resolves nothing and leaves them byte-identical.
  Prove it rather than assume it: normalise the `@setu-ts` version tokens on both sides and diff,
  and every remaining difference is drift you did not intend. `apps/full-stack/deno.lock` is
  gitignored and needs nothing.

  The ROOT `deno.lock` carries them too — 96 tokens at this writing, in its workspace-member
  dependency lists, in both the `@<minor>` and the full `@<version>` forms. Unlike the app locks it
  is rewritten automatically by the first `deno task` you run after bumping the manifests, so it
  usually moves without being asked; do not rely on that. Check it explicitly and commit the result:

  ```fish
  grep -oE '@setu-ts/[a-z0-9-]+@[0-9][^"]*' deno.lock | sed -E 's#@setu-ts/[a-z0-9-]+@##' | sort -u
  ```

  Every line it prints must name the version being released.

- **Widening `SHIPPED_VERSION_LINES` surfaces doc references the specifier sweep cannot see.**
  `check:versions` matches `@setu-ts` SPECIFIERS; the document gates match version CLAIMS, and they
  only match lines the alternation names. So the widening in the step above is what first reports
  every install line pinning the previous version in the guides — 44 of them when `v0.7.0` was cut.
  Bump those, then read the diff rather than trusting it: two of the 44 were HISTORICAL (a claim
  about what a past release turned on, and an upgrading-guide heading naming the docs a broken
  example was copied from), and bumping them made them false. Those get a `version:history` marker
  instead. A comment that genuinely tracks the current release — the Dockerfile's quoted resolution
  error, the chart's `appVersion` note — is bumped, which is what `VERSIONED_ARTIFACTS` in
  `scripts/check-docs.ts` documents.

- **A version bump must not rewrite both ends of a RANGE.** README's Versioning section explains the
  caret with a worked range — `^0.6.0` means `>=0.6.0 <0.7.0` — where the second number is the UPPER
  bound and is one minor AHEAD of the release. A line-oriented sweep rewrites both, producing
  `>=0.7.0 <0.7.0`, an empty range that can install nothing. Cutting `v0.7.0` did exactly this and a
  reviewer caught it; `check:docs` cannot, because both numbers name shipped lines and are
  individually correct. After bumping, grep for a range whose bounds are equal:

  ```fish
  grep -rn '>=<version> <<version>' --include='*.md' .
  ```

- **Re-render `k8s/manifests/` after bumping `k8s/chart/Chart.yaml`.** The chart is the single
  authored source and the rendered manifests are committed beside it (M39), so bumping `appVersion`
  without re-rendering leaves eight manifests carrying the previous `app.kubernetes.io/version`
  label. `deno task deploy:render` rewrites them; `check:deploy` fails with
  `k8s/manifests/ is out of date with k8s/chart/` if you forget. Nothing else sees it — the four
  ordinary gates, both publish gates and `check:versions` all pass over the drift, because the label
  is not an `@setu-ts` specifier and the manifests are not TypeScript. Cutting `v0.5.0` found this
  the only way it can be found: a red **Docker / Kubernetes** job on the release PR.

- **A release starting a new version LINE must widen `SHIPPED_VERSION_LINES`** in
  `scripts/check-docs.ts`. Both document version gates match against that alternation, so a new line
  it does not name makes them match nothing — every stale claim goes invisible while `check:docs`
  reports a clean pass. The failure mode is a silent green run, not a red one. The lines are
  enumerated one minor at a time on purpose: a general `\d+\.\d+\.\d+` also claims third-party
  versions in the corpus (Drizzle's `0.45.2`, the Prometheus text format's `0.0.4`). **Add the
  matching cases to `test/docs-gate.test.ts` in the same change** — both checkers read that regex
  separately, so each needs its own, and a widening nothing asserts can be narrowed back later
  without a single test going red.
- Add the release's `CHANGELOG.md` entry.
- **A release that carries reader action adds a `docs/upgrading.md` entry.** The CHANGELOG records
  what the framework changed; the guide records what a reader must change in their own project. The
  two answer different questions, and an entry that demands reader action — a breaking change to
  published or generated output, a required member added to a public interface, a manifest or
  compiler-option edit — belongs in the guide, not buried in a feature entry. A release with none
  needs no entry.
- **Rename `docs/upgrading.md`'s `## Unreleased` heading to the version being cut**, the same way
  the CHANGELOG's is renamed. Milestones file their reader actions under `Unreleased` as they land,
  so this step is a rename rather than a recall — which is the point: reconstructing what several
  milestones demanded of a reader, at cut time, is how the guide's first two entries ended up under
  the wrong releases (M90h). `test/docs-gate.test.ts` refuses a heading with no matching CHANGELOG
  section, so a forgotten rename fails the suite rather than shipping.

### 2. Verify the committed tree

```fish
deno task fmt:check; and deno task lint; and deno task check; and deno task test:coverage
pnpm test:coverage
deno task release:verify 0.9.0
deno task check:versions
deno task check:node-build --require-all
deno task release:publish --dry-run
```

The npm dry run builds once, packs all 51 with scripts disabled, checks each exact packed manifest,
performs the packument lookup, and runs `npm publish <tarball> --dry-run`. It refuses publication
holds, stale internal ranges, missing metadata and missing `dist` or `src` file entries. Only HTTP
404 means a new package; registry errors fail the publisher. An existing version is skipped, so
retries resume. A prerelease uses tag `next`; an ordinary release uses `latest`.

`release:verify` checks version sites, source `workspace:^` ranges, release-list coverage, non-stub
exports, non-empty READMEs, manifest metadata, release assets, changelog PRs and release shape.
JSR's slow-type dry run is replaced by `tsc -b` with `isolatedDeclarations`; the `@module`-first
rule is retired because npm renders README.md. The `@since` gate reads JSR through 0.8.x and later
claims from npm tarball `package/src/` sources. `check:versions` still catches stale specifiers
outside manifests; fixtures remain data.

### 3. Merge, tag, and let CI publish

Open the release PR into `main`, request the normal review, and merge with a merge commit. Tag the
merged commit, after confirming its SHA and running release verification there:

```fish
git tag v0.9.0 <reviewed-main-merge-sha>
git push origin v0.9.0
```

`release.yml` has three jobs. `gates` has `contents: read`, runs every test lane and release gate,
and uploads `resolved-set.json`. `publish` needs gates, names environment `npm`, and alone holds
`id-token: write` (plus `contents: read`). It checks out without credentials, installs with
`--ignore-scripts`, builds, packs and publishes with scripts disabled, and runs no tests. It uses
OIDC alone; there is no npm token. `release` needs publish, holds `contents: write`, downloads the
resolved-set artifact and creates the GitHub Release. Both `publish` and `release` run only for a
pushed `v*` tag. A manual `workflow_dispatch` is always a rehearsal: it runs the gates and then the
publisher's dry run INSIDE the gates job, which cannot request an OIDC token, and neither later job
runs. Every action in the workflow is pinned to a full commit SHA, with its version in a comment;
update a pin by resolving the new tag to its commit, never by switching back to a tag.

The publisher requires npm ≥11.5.1 and adds `--provenance` on GitHub Actions. A local dry run cannot
establish OIDC or live provenance; the first tag run supplies that proof. Back-merge `main` into
`develop` with a merge commit after the release, preserving reviewed history.

## If publishing stops partway

Re-run the workflow against the same reviewed tag. The publisher skips versions already in the
packument and stops on the first failure. Retry inside the two-day trust window during bootstrap. If
an unused trust configuration expires, delete it in npm's package settings, recreate it with
`npm trust github`, then complete its first OIDC publish within two days. Do not regenerate trust
for packages whose first publish already validated it.

As a last-resort recovery when CI cannot be restored, the maintainer may locally publish the real
release with npm login and 2FA using `deno task release:publish`. This produces no provenance and
therefore does not satisfy the cut's provenance exit criterion. It is a fallback requiring an
explicit maintainer decision, never the normal bootstrap path.

## The GitHub Release object

The final job derives its body from the version's CHANGELOG section. It carries a pinned
`npm install @setu-ts/kernel@<version> @setu-ts/runtime@<version>` line so an older Release installs
its own version, and derives prerelease status from the version. Historical alpha tags without
Release objects remain unfilled.

If only this job fails, recover it without republishing:

```fish
set version 0.9.0
set prerelease
if string match -q '*-*' "$version"
    set prerelease --prerelease
end
mkdir -p .tmp; and deno task release:resolved-set "$version" .tmp/resolved-set.json; and deno run --allow-read scripts/release-notes.ts "$version" > .tmp/notes.md; and gh release create "v$version" --verify-tag --title "v$version" --notes-file .tmp/notes.md .tmp/resolved-set.json#resolved-set.json $prerelease
```

`--verify-tag` prevents a mistyped version from creating a new tag. The workflow checks whether the
Release already exists before creating it. `resolved-set.json` wraps committed `deno.lock` with the
release version; M111e will move it to pnpm. It reproduces the framework build, while an application
still resolves its own dependency graph. `release:verify` requires generation, upload, download and
attachment across the jobs.

### Dependency drift

The scheduled **Dependency drift** workflow runs weekly. It resolves all workspace ranges with
`--reload` into a temporary lockfile — the workspace manifests first, then the tracked source graph,
because a source-only resolution produces a lockfile `deno ci` refuses to install and mis-attributes
the peer versions that fall out with it — compares that lockfile's direct resolutions with the
committed one, then runs format, lint, type-check, and test gates against the fresh lock. It never
modifies `deno.lock` and cannot block a pull request or release. A changed resolution or failed gate
creates or updates one `dependency-drift` GitHub issue whose table names each package, specifier,
and committed→fresh version.

The job declares the same backend containers as ci.yml's `deno` job, and must: it re-runs that job's
suite, so a backend it does not start is a guarded suite that skips there while passing on every PR
— and `REDIS_URL`'s reachability assertion fires in every workflow, so a job without the container
reports a `test` failure that has nothing to do with drift. `test/unit/release-notes.test.ts`
derives that requirement from ci.yml for every workflow that runs the suite.

**Acting on the report.** Drift is diagnostic, not a queue to drain: a table with no advisory behind
it and green gates needs no action. When a bump is warranted, re-resolve the same way the job does
rather than by hand — `rm deno.lock && deno install --frozen=false`, then `deno cache` over the
tracked sources, then `deno ci` to confirm the result installs frozen. Resolving only one of those
two halves produces a lockfile that passes `deno check` and fails `deno ci`.

## Prereleases and installation timing

Prereleases publish under `next`, keeping `latest` on the ordinary release. Install a prerelease
with an explicit version or `@next`. Release notes always pin the version. Deno's dependency-age
policy can still block a just-published dependency on the Deno path; the maintainer's immediate
smoke check can use `--min-dep-age 0`.

## API documentation

M38 added a reproducible `deno doc` generator and a JSDoc lint ratchet. The generated HTML is
ignored (not committed), but must be rebuilt before any release artifact is published so the release
notes and changelog can reference the current API surface.

```fish
# Rebuild the static API site (ignored output)
deno task docs:api

# Run the JSDoc lint ratchet (must be green before release)
deno task check:api-docs

# Run both together (Markdown checks + API lint)
deno task check:docs
```

The ratchet (`DOC_LINT_BASELINE = 497`) is frozen in `scripts/generate-api-docs.ts`. If the total
diagnostic count drops below the baseline, the script prints a message instructing you to lower the
constant in the same commit — do not ship a lower count without updating the constant, and do not
raise the constant to accommodate new debt. The ten `CLEAN_PACKAGES` are permanently exempt: any
finding in those packages fails the gate regardless of the baseline.

**The count is only comparable on the Deno version that produced it.** `deno doc --lint` emits a
different number per version, and not marginally so: one identical tree reported 752 diagnostics on
Deno 2.9.5 and 496 on 2.9.6, a 256 difference from the toolchain alone. So the baseline is paired
with `DOC_LINT_BASELINE_DENO`, which tracks the `deno-version` pin in `.github/workflows/ci.yml`. On
any other version the gate reports the count and **skips** the comparison rather than failing,
because failing would block every contributor whose toolchain differs from CI's; clean-package
findings still fail. Never lower the constant from a run whose output says `SKIPPED`.

The pin is currently **2.9.6**, chosen to match the version developers run, so the ratchet is
comparable in an ordinary local run and a new diagnostic is visible before a push. While the two
disagreed it was not: a local run said `SKIPPED`, a contributor learned of a new diagnostic only
from a red CI job, and finding out _which symbol_ meant reproducing CI's reading in a container. If
your toolchain differs from the pin, that container is still the way to reproduce it:

```bash
docker run --rm -v "$PWD":/w -w /w -e DENO_DIR=/tmp/dc denoland/deno:2.9.6 \
  run --allow-read --allow-run --allow-env --allow-write=/tmp/dc \
  scripts/generate-api-docs.ts --check
```

When the CI pin moves, re-measure and update both constants in the same change — and say in the
commit whether a change in the count is paid-down debt or just the new toolchain, because the two
are indistinguishable from the number alone.

Generated output lives under `docs/api/`, which is gitignored. Verify it is not tracked:

```fish
git status --short --ignored docs/api
# Should show only ignored output, no tracked files
```

To smoke-test a release immediately, pass `--min-dep-age 0`. This resolves itself after a day, so it
affects only the maintainer verifying the release, not ordinary users — but it will surprise you
every time if it is not written down.

## Verifying the real npm release

A green publish does not prove the artifact works. In an empty directory under `.tmp/`, install with
plain npm, then run a request on Node 24 and Bun. Keep this outside the workspace import map.

```fish
mkdir -p .tmp/npm-release-proof; and cd .tmp/npm-release-proof
npm init -y
npm install @setu-ts/kernel @setu-ts/runtime
```

Save `proof.mjs` with:

```javascript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
const app = createApplication({ plugins: [RuntimePlugin()] });
app.router.get('/hello', (ctx) => ctx.response.json({ ok: true }));
await app.start();
const response = await app.inject({ method: 'GET', url: '/hello' });
console.log(response.statusCode, response.body);
await app.stop();
```

Run `node proof.mjs` and `bun proof.mjs`; require 200 and `{"ok":true}`. Inspect
`npm view <package>@0.9.0 dist.attestations --json` and `npm view <package> dist-tags --json` for
all 51 names: provenance must exist and `latest` must name `0.9.0`. Confirm descriptions, repository
links and README on npm. The weekly compat suite installs/imports all 51 and serves real sockets on
Node/Bun. Before the first publish, its explicit scope probe reports HTTP 404 and skips; HTTP 200
arms the suite, and any other status fails.
