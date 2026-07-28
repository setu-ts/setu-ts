# Releasing to JSR

Packages are published to [JSR](https://jsr.io) under the `@hono-enterprise` scope. **JSR versions
are immutable** — a published version can be yanked, but never deleted or replaced. Every step below
is designed so that mistakes are caught before that point.

## One-time setup

These run once for the whole project, not once per release.

### 1. The scope

`@hono-enterprise` must exist. Create it at [jsr.io/new](https://jsr.io/new) — fill in the **Scope**
box only (`hono-enterprise`, without the `@`).

### 2. The packages

**Creating the scope is not enough. Every package must also exist before anything can be published
to it.**

This is the step that is easy to miss, because nothing warns you until a publish fails:

```
error: Following packages don't exist, follow the links and create them:
- https://jsr.io/new?scope=hono-enterprise&package=common&from=cli
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
[21/35] FAILED @hono-enterprise/metrics-plugin — HTTP 400: {
  "code": "weeklyPackageLimitExceeded",
  "message": "Exceeded weekly limit of 20 new packages for scope."
}
```

No dry run can predict this — the quota is only evaluated on a real write.

Request an increase at `https://jsr.io/@hono-enterprise/~/settings` → **Quotas** → _Request scope
quota increase_. Choose **New packages per week** (not _Total packages_, which is a different quota)
and give a concrete reason: what the scope is, why it is many small packages, and the exact package
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

For each package, or via scope settings, link `dkpaul91/hono-enterprise` in JSR. This is what lets
the tag-triggered workflow publish using the runner's OIDC identity instead of a long-lived token.

Until this is done, publish from a workstation with `JSR_TOKEN` set (see below).

## Cutting a release

### 1. Prepare, on a `release/…` branch

- Bump `version` in every workspace member's `deno.json`.
- **Bump the cross-package specifiers to match.** 11 packages pin
  `jsr:@hono-enterprise/{common,kernel}@^<version>` explicitly. Under semver a `^0.1.0` range does
  **not** match a `0.1.0-alpha.1` prerelease, so a version bump that misses these publishes packages
  whose dependencies cannot resolve — and `deno publish` does not warn.
- Add the release's `CHANGELOG.md` entry.

### 2. Verify

```fish
deno task fmt:check; and deno task lint; and deno task check; and deno task test:coverage
deno task release:verify 0.1.0-alpha.1
deno task release:publish --dry-run
```

`release:verify` checks four things the test suite cannot: version agreement across all publishable
packages, cross-package specifier resolvability, that the published and unpublished lists together
account for every workspace member, and that no stub is in the publish list.

> **A green `--dry-run` is not proof the publish will succeed.** The dry run resolves modules from
> the workspace; a real publish builds the graph from the package tarball, where a sibling package
> is not on disk. A cross-package import written as a relative path —
> `"@hono-enterprise/common": "../common/src/index.ts"` — therefore passes `deno check`, the full
> test suite, and `deno publish --dry-run`, then fails on the real publish with:
>
> ```
> failed to build module graph: Module not found "file:///common/src/index.ts".
> ```
>
> `metrics-plugin` and `telemetry-plugin` both shipped this way and were caught only when the
> release reached package 21 of 35. `release:verify` now rejects any `@hono-enterprise/*` import
> that is not a `jsr:` specifier, so this class cannot reach a publish again — but only if you
> actually run it.

### 3. Merge, then publish

Open a PR, let CI pass, merge to `main`. Then from `main`:

```fish
git pull
deno task release:verify 0.1.0-alpha.1
env JSR_TOKEN=jsrp_… deno task release:publish
```

**Publish before tagging.** The tag is a record of what shipped; if the publish fails partway you do
not want a tag claiming otherwise. Once it succeeds:

```fish
git tag v0.1.0-alpha.1
git push origin v0.1.0-alpha.1
```

### Publishing from CI instead

Once the repository is linked (setup step 3), pushing a `v*` tag is sufficient —
`.github/workflows/release.yml` re-runs the four gates, checks the tag matches the package versions,
and publishes with OIDC provenance. No token secret is needed.

Note that a tag-triggered run uses the workflow and scripts **as they exist at the tagged commit**,
not on `main`.

## Why publishing goes through a script

`deno publish` from the workspace root publishes **all 40 members**, including the `cli`, `sdk`, and
starter stubs that export nothing — and there is no per-package private flag. Since versions are
immutable, an accidental stub publish is permanent.

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

## Prerelease gotchas

Both of these bite on any `-alpha`/`-beta`/`-rc` release and neither is a defect.

### `latest` is not set, so bare installs fail

JSR does not point a package's `latest` at a prerelease. `meta.json` shows `"latest": null` even
though the version is live, and consumers get:

```
error: jsr:@hono-enterprise/kernel has only pre-release versions available.
Try specifying a version: deno add jsr:@hono-enterprise/kernel@^0.1.0-alpha.2
```

Every install instruction for a prerelease must carry an explicit version. Check the README and
CHANGELOG before announcing a prerelease — unpinned examples are the easiest thing to get wrong.

### Deno refuses versions younger than 24 hours

Deno's minimum-dependency-age policy (default 24h) blocks freshly published versions:

```
A newer matching version was found, but it was not used because it was newer than the
specified minimum dependency date ... pass the --minimum-dependency-age flag
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
deno add --min-dep-age 0 jsr:@hono-enterprise/kernel@^0.1.0-alpha.2 jsr:@hono-enterprise/runtime@^0.1.0-alpha.2
```

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({ plugins: [RuntimePlugin()] });
app.router.get('/hello', (ctx) => ctx.response.json({ ok: true }));
await app.start();
const res = await app.inject({ method: 'GET', url: '/hello' });
console.log(res.statusCode, res.body); // 200 {"ok":true}
await app.stop();
```
