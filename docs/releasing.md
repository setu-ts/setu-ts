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

Nothing needs undoing. Already-published versions are skipped on a re-run, so fix the cause and run
`deno task release:publish` again — it resumes from where it stopped.
