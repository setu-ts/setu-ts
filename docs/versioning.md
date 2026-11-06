# Versioning policy

Setu-TS is pre-1.0, and the version number says exactly what that means:

| Bump                         | What it carries                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| **Minor** — `0.5` → `0.6`    | Breaking changes. Every one is listed in [CHANGELOG.md](../CHANGELOG.md) with migration text. |
| **Patch** — the third number | Fixes and additions only. Safe to take without reading anything.                              |

Under semver a `^0.11.0` range means `>=0.11.0 <0.12.0`, so a caret pin absorbs patches and stops at
the next breaking release. That is the intended way to depend on this project today.

<!-- version:history -->

From `0.9.0` the **patch is the normal release** and breaking changes are batched into an occasional
minor: a change that would break a caller or an implementor ships behind its old behaviour first (a
flag, an optional member, a deprecation) and the removal waits for the next minor. Two gates hold
the line — a milestone plan must state what it breaks and which minor carries it, and
`release:verify` refuses a patch whose changelog carries a `BREAKING` entry.

<!-- version:history -->

Releases up to `v0.1.0-alpha.10` used a prerelease suffix instead. Dropping it is a change of label,
not of policy — `0.x` already grants exactly the same licence to break, and it drops the JSR
prerelease penalty that forced every install line to be pinned by hand.

**1.0 is the API freeze**, and it is gated on Milestone 40: benchmarks, a security audit, and the
Node/Bun compatibility suites as release gates. Until then, read the CHANGELOG before a minor bump.
