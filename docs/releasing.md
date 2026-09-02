# Releasing to JSR

Packages are published to [JSR](https://jsr.io) under the `@setu-ts` scope. **JSR versions are
immutable** — a published version can be yanked, but never deleted or replaced. Every step below is
designed so that mistakes are caught before that point.

## One-time setup

These run once for the whole project, not once per release.

### 1. The scope

`@setu-ts` must exist. Create it at [jsr.io/new](https://jsr.io/new) — fill in the **Scope** box
only (`setu-ts`, without the `@`).

### 2. The packages

**Creating the scope is not enough. Every package must also exist before anything can be published
to it.**

This is the step that is easy to miss, because nothing warns you until a publish fails:

```
error: Following packages don't exist, follow the links and create them:
- https://jsr.io/new?scope=setu-ts&package=common&from=cli
```

`deno publish` will not create them for you. It can only print one creation link per package, and it
cannot even do that without a terminal — in CI it simply fails. At 35 packages, doing it by hand
means 35 web forms.

Instead, create them all through the JSR API:

```fish
# Create a personal access token at https://jsr.io/account/tokens
env JSR_TOKEN=jsrp_… deno task release:create-packages
```

The script is idempotent — packages that already exist are reported and skipped — so it is safe to
re-run after a partial failure. Pass `--dry-run` to see what it would create without a token.

#### The weekly package-creation quota

**A scope may create only 20 new packages per rolling 7-day window by default.** This release needs
35, so the first run stops two-thirds of the way through:

```
[21/35] FAILED @setu-ts/metrics-plugin — HTTP 400: {
  "code": "weeklyPackageLimitExceeded",
  "message": "Exceeded weekly limit of 20 new packages for scope."
}
```

No dry run can predict this — the quota is only evaluated on a real write.

Request an increase at `https://jsr.io/@setu-ts/~/settings` → **Quotas** → _Request scope quota
increase_. Choose **New packages per week** (not _Total packages_, which is a different quota) and
give a concrete reason: what the scope is, why it is many small packages, and the exact package
names still needed. Requests are reviewed by a human, so vague ones stall.

The scope's three quotas and what they mean for a 35-package release:

| Quota                     | Default | Relevance                                                     |
| ------------------------- | ------- | ------------------------------------------------------------- |
| Total packages            | 100     | Fine — 35 fits.                                               |
| New packages per week     | **20**  | **The constraint.** Blocks any release creating more than 20. |
| Publish attempts per week | 1000    | Fine — 35 versions is nothing.                                |

If the increase is declined, the window is rolling: packages created together free up together, so
waiting a week lets the remaining batch be created in one go.

### 3. Link the GitHub repository

For each package, or via scope settings, link `setu-ts/setu-ts` in JSR. This is what lets the
tag-triggered workflow publish using the runner's OIDC identity instead of a long-lived token.

Until this is done, publish from a workstation with `JSR_TOKEN` set (see below).

## Cutting a release

### 1. Prepare, on a `release/…` branch

- Bump `version` in every workspace member's `deno.json`.
- **Bump the cross-package specifiers to match.** 16 packages pin
  `jsr:@setu-ts/{common,kernel,runtime}@^<version>` explicitly. Under semver a `^0.1.0` range does
  **not** match a `0.1.0-alpha.1` prerelease, so a version bump that misses these publishes packages
  whose dependencies cannot resolve — and `deno publish` does not warn.
- **Grep the source, not only the manifests.** `packages/sdk` writes its `jsr:` specifier inline in
  four `src/**` files rather than through an import-map alias, and its manifest maps that exact
  specifier string to a pinned version — so the range in the source and both sides of the mapping
  must move together. A missed source specifier resolves against the previous release instead of the
  one being cut. `grep -rn '<old-version>' packages/*/src` must come back empty.
- **A release starting a new version LINE must widen `SHIPPED_VERSION_LINES`** in
  `scripts/check-docs.ts`. Both document version gates match against that alternation, so a new line
  it does not name makes them match nothing — every stale claim goes invisible while `check:docs`
  reports a clean pass. The failure mode is a silent green run, not a red one.
- Add the release's `CHANGELOG.md` entry.

### 2. Verify

```fish
deno task fmt:check; and deno task lint; and deno task check; and deno task test:coverage
deno task release:verify 0.2.0
deno task release:publish --dry-run
```

`release:verify` checks five things the test suite cannot: version agreement across all publishable
packages, cross-package specifier resolvability, that the published and unpublished lists together
account for every workspace member, that no stub is in the publish list, and that every entrypoint's
module JSDoc opens with `@module` so the package's README is what renders on jsr.io.

> **A green `--dry-run` is not proof the publish will succeed.** The dry run resolves modules from
> the workspace; a real publish builds the graph from the package tarball, where a sibling package
> is not on disk. A cross-package import written as a relative path —
> `"@setu-ts/common": "../common/src/index.ts"` — therefore passes `deno check`, the full test
> suite, and `deno publish --dry-run`, then fails on the real publish with:
>
> ```
> failed to build module graph: Module not found "file:///common/src/index.ts".
> ```
>
> `metrics-plugin` and `telemetry-plugin` both shipped this way and were caught only when the
> release reached package 21 of 35. `release:verify` now rejects any `@setu-ts/*` import that is not
> a `jsr:` specifier, so this class cannot reach a publish again — but only if you actually run it.

### 3. Merge, then publish

Open a PR, let CI pass, merge to `main`. Then from `main`:

```fish
git pull
deno task release:verify 0.2.0
env JSR_TOKEN=jsrp_… deno task release:publish
```

**Publish before tagging.** The tag is a record of what shipped; if the publish fails partway you do
not want a tag claiming otherwise. Once it succeeds:

> **`0.1.0-alpha.9` announcement note.** The release notes must state that `@setu-ts/grpc-plugin`
> now loads on Node and Bun (X7-3), and that the Connect/Protobuf-ES packages are installed with the
> host runtime's package manager — the plugin no longer bundles them. The native
> `application/grpc+proto` transport and the default `basePath` reachability are **not** claimed;
> those are M70i's decision (register rows X7-2 / X7-4).

```fish
git tag v0.2.0
git push origin v0.2.0
```

### Publishing from CI instead

Once the repository is linked (setup step 3), pushing a `v*` tag is sufficient —
`.github/workflows/release.yml` re-runs the four gates, checks the tag matches the package versions,
and publishes with OIDC provenance. No token secret is needed.

Note that a tag-triggered run uses the workflow and scripts **as they exist at the tagged commit**,
not on `main`.

> **The tag-triggered workflow could not publish until `v0.1.0-alpha.2`.** Its publish step ran
> `publish-packages.ts` with only `--allow-read --allow-run=deno`, so the script died on
> `Deno.env.get('JSR_TOKEN')` before touching a single package. All three runs before that fix
> failed the same way, and `v0.1.0-alpha.1` was published by hand from a terminal. A passing
> `--dry-run` does not catch it: the registry lookup that needs `--allow-net` is skipped under
> `--dry-run`, so the dry run exercises neither missing permission.

> **The release job needs the same backend containers as CI.** Its gates re-run the full suite, and
> `test/apps-gate.test.ts` asserts `REDIS_URL` is reachable whenever `CI` is set — which GitHub sets
> in **every** workflow, not only `ci.yml`. `release.yml` shipped without the `redis` and
> `elasticmq` services, so that assertion failed and the job died before publishing anything: it is
> what killed the `v0.1.0-alpha.5` run, which then had to be published by hand. Both workflows now
> declare the same `env` and `services` block, and `apps-gate.test.ts` pins it on `release.yml` as
> well, so the pair cannot drift apart again. Nothing local reproduces this — the assertion is
> deliberately vacuous off CI, so the first evidence is the tag run itself.

## Tokenless CI publishing needs each package linked to the repository

JSR accepts a GitHub Actions OIDC identity only for a package it knows belongs to the repository:

> To publish from GitHub Actions, you must first link your package to your GitHub repository from
> your package settings in JSR.

Without the link, `deno publish` gets as far as uploading and then fails with

```
error: Failed to publish @setu-ts/common@0.1.0-alpha.2
Caused by:
    The actor that this request was authenticated for is not authorized to
    access this resource. (actorNotAuthorized)
```

`v0.1.0-alpha.1` never hit this because it was published from a terminal with a token, where the
link is irrelevant. Linking is one web form per package, so:

```bash
env JSR_TOKEN=jsrp_… deno task release:link-repos
```

Idempotent, and it prints a settings URL for anything it could not link. Run it once; after that the
tag-triggered workflow is self-sufficient.

## Why publishing goes through a script

`deno publish` from the workspace root publishes **all 40 members**, including the `sdk` and starter
stubs that export nothing — and there is no per-package private flag. Since versions are immutable,
an accidental stub publish is permanent.

`scripts/publish-packages.ts` therefore walks the explicit allow-list in
`scripts/release-packages.ts`, one package at a time, in dependency order, halting on the first
failure so dependents never publish against a missing version.

## If a publish fails partway

Nothing needs undoing — re-run `deno task release:publish` and it resumes from where it stopped.

This works because the script asks the registry whether each package already carries the version
being released, and skips the ones that do:

```
[1/35] packages/common — already at 0.1.0-alpha.1, skipping
...
[21/35] packages/metrics-plugin
```

That check is load-bearing, not an optimisation. **JSR versions are immutable, so re-publishing an
existing one is an error, not a no-op** — without the skip, a resumed run would die on the first
already-published package and never reach the ones that still need publishing. A registry lookup
that fails for any other reason (network, 5xx) does _not_ skip: the package is published and
`deno publish` is left to be the authority, so a transient error can never silently drop a package
from a release.

A publish that stops because a package does not exist is the quota case above, not a defect: the
packages already published are complete and resolvable, provided nothing in the published set
depends on something in the unpublished set. Only `common` and `kernel` are depended upon in-repo,
and the publish order puts them first, so a partial run is always internally consistent.

## The GitHub Release object

The tag-triggered workflow creates it automatically, as the LAST step — after the publish, so a
failure there cannot cost the publish. The body comes from `scripts/release-notes.ts`, which lifts
this version's `CHANGELOG.md` section and wraps it in the two things a Releases-tab reader needs and
the changelog does not carry: a **pinned** install line (see the `latest` gotcha below — an unpinned
instruction installs nothing on a prerelease) and a note that the earlier tags have no Release
object. The `--prerelease` flag is derived from the version, so `1.0.0` stops being marked one
without anyone remembering to edit the workflow.

Tags `v0.1.0-alpha.1` … `v0.1.0-alpha.7` carry no Release object by decision and are not backfilled;
their notes live in `CHANGELOG.md`. `v0.1.0-alpha.8`'s was created by hand.

**If that step goes red, do NOT re-run the job.** The packages are already on JSR by then, versions
there are immutable, and a re-run fails on every package in the list. Create the object by hand:

```bash
version=0.1.0-alpha.9   # the version that just published — the ONLY line to edit
prerelease=$(case "$version" in *-*) echo --prerelease ;; esac)
mkdir -p .tmp &&
deno task release:resolved-set "$version" .tmp/resolved-set.json &&
deno run --allow-read scripts/release-notes.ts "$version" > .tmp/notes.md &&
gh release create "v$version" --verify-tag --title "v$version" \
  --notes-file .tmp/notes.md \
  .tmp/resolved-set.json#resolved-set.json \
  $prerelease
```

Everything after the first line is derived, deliberately: hardcoding the flag would mark the first
stable release a prerelease, and hardcoding the version in three places invites the one typo this
recovery path cannot afford. The `case` is the same idiom the workflow step uses, so the manual path
and the automatic one cannot disagree about what counts as a prerelease.

### Resolved dependency set

Every GitHub Release also carries `resolved-set.json`. It wraps the complete committed `deno.lock`
under the release version, including exact transitive versions and integrity hashes. That is the
framework's reproducibility guarantee: rebuilding the tagged framework tree with its lockfile uses
the reviewed resolution. It does **not** freeze an application's own dependency graph — Node/Bun
resolve JSR's npm-compatible dependencies with the application's package manager, and Deno resolves
the application's ranges with its lockfile.

The workflow creates the artifact before publish using:

```bash
deno task release:resolved-set <version> .tmp/resolved-set.json
```

The post-publish recovery command above runs the same task and attaches the same asset, so a
manually recovered release preserves this guarantee.

`release:verify` checks the workflow contract for both generation and attachment, so deleting either
side is a release-blocking error rather than a missing asset discovered after publication.

### Dependency drift

The scheduled **Dependency drift** workflow runs weekly. It resolves all workspace ranges with
`--reload` into a temporary lockfile, compares that lockfile's direct resolutions with the committed
one, then runs format, lint, type-check, and test gates against the fresh lock. It never modifies
`deno.lock` and cannot block a pull request or release. A changed resolution or failed gate creates
or updates one `dependency-drift` GitHub issue whose table names each package, specifier, and
committed→fresh version.

The `&&` is load-bearing rather than stylistic. The workflow step runs under `set -euo pipefail`; a
block pasted into an interactive shell does not, so without it a failed extraction still leaves a
truncated `/tmp/notes.md` behind and the next line publishes a release with empty notes.

`--verify-tag` matters more here than in the workflow: without it `gh release create` creates a
missing tag from the default branch, so a mistyped version would publish a release pointing at
whatever `main` happens to be rather than at the commit that was released.

The step is idempotent — it exits early when the release already exists — so a re-run for any other
reason will not collide with an object created this way.

## Prerelease gotchas

**These stopped applying at `v0.2.0`**, which dropped the prerelease suffix — see the CHANGELOG
entry for why. They are kept because they bite on any future `-alpha`/`-beta`/`-rc` release, and
because every tag from `v0.1.0-alpha.1` to `v0.1.0-alpha.10` shipped under them. Neither is a
defect.

The first no longer applies to a `0.x` release: JSR points `latest` at `0.2.0`, so a bare
`deno add jsr:@setu-ts/kernel` resolves. The second still applies to **every** release, prerelease
or not — Deno's dependency-age policy is about publication time, not version shape.

### `latest` is not set, so bare installs fail

JSR does not point a package's `latest` at a prerelease. `meta.json` shows `"latest": null` even
though the version is live, and consumers get:

```
error: jsr:@setu-ts/kernel has only pre-release versions available.
Try specifying a version: deno add jsr:@setu-ts/kernel@^0.1.0-alpha.3
```

Every install instruction for a prerelease must carry an explicit version. Check the README and
CHANGELOG before announcing a prerelease — unpinned examples are the easiest thing to get wrong.

### Deno refuses versions younger than 24 hours

Deno's minimum-dependency-age policy (default 24h) blocks freshly published versions:

```
A newer matching version was found, but it was not used because it was newer than the
specified minimum dependency date ... pass the --minimum-dependency-age flag
```

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

## Verifying a release actually works

A green publish is not proof the artifact is usable. After publishing, install from JSR into a
throwaway directory — never the workspace, whose import map resolves locally and would mask a broken
published dependency — and serve one request:

```fish
mkdir /tmp/relcheck; and cd /tmp/relcheck; and echo '{}' > deno.json
deno add --min-dep-age 0 jsr:@setu-ts/kernel@^0.1.0-alpha.3 jsr:@setu-ts/runtime@^0.1.0-alpha.3
```

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication({ plugins: [RuntimePlugin()] });
app.router.get('/hello', (ctx) => ctx.response.json({ ok: true }));
await app.start();
const res = await app.inject({ method: 'GET', url: '/hello' });
console.log(res.statusCode, res.body); // 200 {"ok":true}
await app.stop();
```
