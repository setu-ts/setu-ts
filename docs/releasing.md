# Releasing to npm

The npm publisher ships all 52 workspace members as `@setu-ts/*`. M111c builds the machinery; it
publishes nothing. `v0.9.0` was the first npm release. Existing versions through `0.8.0` remain on
JSR. npm versions cannot be reused.

## One-time setup — the first npm publish

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
   pnpm run release:placeholders
   for dir in .tmp/npm-placeholders/*
       set name (node -p "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8')).name" "$dir/package.json")
       npm view "$name" name >/dev/null 2>&1; and continue
       npm publish "$dir" --tag bootstrap --access public --ignore-scripts; or break
   end
   ```

   The placeholders only create names. Inspect the output first; it contains no framework code. The
   loop skips names that already exist, so rerunning it resumes a partial run.

   Lessons from the `v0.9.0` bootstrap (52 packages, 2026-10-13/14):

   - **npm limits each account to about 25 new packages per 24 hours.** Spacing the publishes out
     does not help. Plan to create the names over two days, or have a second organization member
     with publish rights create the remainder; remove that member from the organization afterwards.
     The limit applies only to creating a package, not to new versions of existing ones.
   - **With a passkey or security key as the second factor there is no one-time code.** npm opens a
     browser approval for each publish, so drop `--otp`. When the limit is hit, the approval is
     consumed by the refused attempt and npm reports `EOTP`; that `EOTP` hides a `429`, and retrying
     at once only fails again.
   - **A granular access token with "bypass 2FA" publishes without a browser approval per package.**
     Pass it through a config file rather than the environment, for example
     `npm publish … --userconfig /path/to/npmrc`, where the file holds
     `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`. Give it a one-day expiry and revoke it when
     the bootstrap ends. npm is restricting 2FA-bypassing tokens from August 2026, so do not rely on
     this path for later bootstraps. A publish with no credentials at all answers `404`, not `401`.
   - **npm adds a `0.0.0-stage` version to each new package.** Deprecate it with the placeholder in
     step 4.

2. Prepare the reviewed `0.9.0` release tree before configuring trust. Then configure all 52
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
       npm deprecate "$name@0.0.0-stage" 'Registry placeholder; install 0.9.0 or later.'
       npm dist-tag rm "$name" bootstrap; or break
   end
   ```

   The `0.0.0-stage` line has no `or break`: a package may not carry that version, and its absence
   is not a failure.

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
pnpm run release:bump 0.9.0 --dry-run
pnpm run release:bump 0.9.0
node scripts/node-manifests.ts --write
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
- **`release:bump` rewrites `test/deno-lane/deno.lock` in place, and you commit that result.** The
  lane lock records every workspace member under `workspace.links` at the shipping version (52
  `jsr:@setu-ts/<pkg>@<version>` keys), so it is the swept file that keeps the sweep's
  zero-reference guard meaningful. `pnpm-lock.yaml` records workspace members as `link:` entries
  with a `workspace:^` specifier and no version, so a bump does not change it and it is not swept;
  `pnpm install --frozen-lockfile` after the bump confirms that. The 15 tracked `apps/*/deno.lock`
  files this runbook used to bump are gone — M111e3 made the examples pnpm workspace members with no
  lockfile of their own.

  **Never regenerate the lane lock during a bump.** With the members bumped and the lock still
  naming the old version, Deno rebuilds the whole file and re-resolves every third-party range as
  well — cutting `v0.5.0` that way silently moved `@hono/hono` `4.13.5` → `4.13.7` plus several npm
  transitives across all 15 app locks. That is dependency drift riding into a release PR, which the
  weekly **Dependency drift** workflow exists to review separately. Prove the rewrite rather than
  assume it: normalise the `@setu-ts` version tokens on both sides and diff, and every remaining
  difference is drift you did not intend.

  ```fish
  grep -oE '@setu-ts/[a-z0-9-]+@[0-9][^"]*' test/deno-lane/deno.lock |
    sed -E 's#@setu-ts/[a-z0-9-]+@##' | sort -u
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
  label. `pnpm run deploy:render` rewrites them; `check:deploy` fails with
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
pnpm run fmt:check; and pnpm run lint; and pnpm run check; and pnpm run test:tooling:coverage
pnpm test:coverage
pnpm run release:verify 0.9.0
pnpm run check:versions
pnpm run check:node-build --require-all
pnpm run release:publish --dry-run
```

The npm dry run builds once, packs all 52 with scripts disabled, checks each exact packed manifest,
performs the packument lookup, and runs `npm publish <tarball> --dry-run`. It refuses publication
holds, stale internal ranges, missing metadata and missing `dist` or `src` file entries. Only HTTP
404 means a new package; registry errors fail the publisher. An existing version is skipped, so
retries resume. A prerelease uses tag `next`; an ordinary release uses `latest`.

`release:verify` checks version sites, source `workspace:^` ranges, release-list coverage, non-stub
exports, non-empty READMEs, manifest metadata, release assets, changelog PRs and release shape. The
changelog PR check exempts the release PR for the version being verified (`release/v<version>`): its
source changes are the version bump, and the section it would have to name is the release itself.
Without the exemption the check passes on the release PR, which is not merged yet, and fails on the
tag (#452). JSR's slow-type dry run is replaced by `tsc -b` with `isolatedDeclarations`; the
`@module`-first rule is retired because npm renders README.md. The `@since` gate reads JSR through
0.8.x and later claims from npm tarball `package/src/` sources. `check:versions` still catches stale
specifiers outside manifests; fixtures remain data.

### 3. Merge, tag, and let CI publish

Open the release PR into `main`, request the normal review, and merge with a merge commit. Tag the
merged commit, after confirming its SHA and running release verification there:

```fish
git tag v0.9.0 <reviewed-main-merge-sha>
git push origin v0.9.0
```

`release.yml` has four jobs. `gates` has `contents: read` and runs as nine parallel shards, split
like ci.yml's `node` job: static checks, three CLI shards, messaging, the other packages, the Deno
lane, tooling, and the release checks that verify the tag and upload `resolved-set.json`.
`cli-coverage` merges the three CLI shards' reports and enforces the per-file bar. Sharded, the
gates should take about as long as PR CI rather than the ~75 minutes one job took for `v0.11.0`, and
a failed shard can be re-run alone. `publish` needs every shard and `cli-coverage`, names
environment `npm`, and alone holds `id-token: write` (plus `contents: read`). It checks out without
credentials, installs with `--ignore-scripts`, builds, packs and publishes with scripts disabled,
and runs no tests. It uses OIDC alone; there is no npm token. `release` needs publish, holds
`contents: write`, downloads the resolved-set artifact and creates the GitHub Release. Both
`publish` and `release` run only for a pushed `v*` tag. A manual `workflow_dispatch` is always a
rehearsal: it runs the gates and then the publisher's dry run INSIDE the gates job, which cannot
request an OIDC token, and neither later job runs. Every action in the workflow is pinned to a full
commit SHA, with its version in a comment; update a pin by resolving the new tag to its commit,
never by switching back to a tag.

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
release with npm login and 2FA using `pnpm run release:publish`. This produces no provenance and
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
mkdir -p .tmp; and pnpm run release:resolved-set "$version" .tmp/resolved-set.json; and node scripts/release-notes.ts "$version" > .tmp/notes.md; and gh release create "v$version" --verify-tag --title "v$version" --notes-file .tmp/notes.md .tmp/resolved-set.json#resolved-set.json $prerelease
```

`--verify-tag` prevents a mistyped version from creating a new tag. The workflow checks whether the
Release already exists before creating it. `resolved-set.json` records the resolved set read from
the committed `pnpm-lock.yaml`: the release `version`, the lock's `lockfileVersion`, and a
`packages` map keyed `<name>@<version>` that holds each package's registry `integrity` where the
lock carries one, sorted by key. It reproduces the framework build, while an application still
resolves its own dependency graph. `release:verify` requires generation, upload, download and
attachment across the jobs.

### Dependency drift

The scheduled **Dependency drift** workflow runs weekly. It keeps a copy of the committed
`pnpm-lock.yaml`, deletes the working copy, and runs `pnpm install --lockfile-only` so every
declared range resolves fresh; `dependency:drift` then compares that resolution's packages with the
committed lock, and the job installs the fresh lock with `--frozen-lockfile` and runs the format,
lint, type-check and test gates against it. It never modifies the committed lockfile and cannot
block a pull request or release. A changed resolution or failed gate creates or updates one
`dependency-drift` GitHub issue whose table names each package, specifier, and committed→fresh
version.

The job declares the same backend containers as ci.yml's `node` job, and must: it re-runs that job's
suite, so a backend it does not start is a guarded suite that skips there while passing on every PR
— and `REDIS_URL`'s reachability assertion fires in every workflow, so a job without the container
reports a `test` failure that has nothing to do with drift. `test/unit/release-notes.test.ts`
derives that requirement from ci.yml for every workflow that runs the suite.

**Acting on the report.** Drift is diagnostic, not a queue to drain: a table with no advisory behind
it and green gates needs no action. When a bump is warranted, re-resolve the same way the job does
rather than by hand — remove `pnpm-lock.yaml`, run `pnpm install --lockfile-only`, read the diff the
refreshed lockfile produces, and commit it; `pnpm install --frozen-lockfile` then confirms the tree
installs against the resolution you reviewed.

## Prereleases and installation timing

Prereleases publish under `next`, keeping `latest` on the ordinary release. Install a prerelease
with an explicit version or `@next`. Release notes always pin the version. Deno's dependency-age
policy can still block a just-published dependency on the Deno path; the maintainer's immediate
smoke check can use `--min-dep-age 0`.

## API documentation

The repository uses a reproducible TypeDoc generator and a JSDoc lint ratchet. The generated HTML is
ignored (not committed), but must be rebuilt before any release artifact is published so the release
notes and changelog can reference the current API surface.

```fish
# Rebuild the static API site (ignored output)
pnpm run docs:api

# Run the JSDoc lint ratchet (must be green before release)
pnpm run check:api-docs

# Run both together (Markdown checks + API lint)
pnpm run check:docs
```

The JSDoc ratchet runs **TypeDoc 0.28.20**, pinned exactly in the generated root `package.json`.
`typedoc.check.json` requires documentation from every published package and validates missing
documentation and unexported references; invalid-link validation is disabled. The source graph uses
`tsconfig.docs.json` and workspace source paths.

`DOC_LINT_BASELINE = 237` and `DOC_LINT_BASELINE_TYPEDOC = '0.28.20'` record the M111e2 measurement.
TypeDoc reported 554 warnings; 317 of them are missing comments on members of anonymous object types
(`Foo.__type.bar`), which the former documentation tool never required, so `inRatchetScope` leaves
them out. The earlier Deno count of 496 measures a different diagnostic model and is not comparable.
The 31 `CLEAN_PACKAGES` were re-derived from zero in-scope diagnostics and include every package the
Deno ratchet kept clean. Any diagnostic in a clean package fails independently of the total.

A count above the baseline fails. A count below it also fails and instructs you to lower the
constant in the same commit; do not raise it to accommodate new debt. A TypeDoc version mismatch
fails before comparing counts and never advises changing the baseline. When the pin changes,
re-measure the count and clean set with the same source graph and validation scope in the same
change.

`docs:api` and `release:docs` generate TypeDoc HTML. The Deno version no longer governs the JSDoc
ratchet.

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
all 52 names: provenance must exist and `latest` must name `0.9.0`. Confirm descriptions, repository
links and README on npm. The weekly compat suite installs/imports all 52 and serves real sockets on
Node/Bun. Before the first publish, its explicit scope probe reports HTTP 404 and skips; HTTP 200
arms the suite, and any other status fails.

## JSR sunset

JSR retains 0.8.0 and earlier; nothing new is published there. Published version READMEs are
immutable. The package description is mutable and leads with the npm migration pointer. The 49-name
inventory in `scripts/jsr-sunset.ts` excludes the three npm-only additions. Descriptions for npm
continue to use the original metadata.

After this milestone merges, a maintainer performs the one-time metadata update:

```fish
node scripts/set-jsr-metadata.ts --dry-run
env JSR_TOKEN=jsrp_… pnpm run release:set-metadata
```

The dry run lists all 49 descriptions and makes no network requests. The real run needs a maintainer
personal access token and resumes safely after a partial failure: matching descriptions and runtime
flags are skipped independently. Do not archive the packages: that would hide the pointer from
search and block a possible security patch.
