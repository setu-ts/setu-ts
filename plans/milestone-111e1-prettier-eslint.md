# Milestone 111e1 — Prettier and ESLint replace `deno fmt` and `deno lint` (repository tooling)

> **Status:** Planning. Branch: `feat/m111e1-prettier-eslint`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M111e moves the repository's own tooling off the `deno` binary. The maintainer split it into three
PRs (2026-10-14): **111e1** (this plan) swaps the formatter and linter, **111e2** ports the scripts
and root tests to Node, and **111e3** rewrites CI, moves `apps/*` to pnpm and removes the root
`deno.json`/`deno.lock`. 111e1 makes Prettier and ESLint the repository's formatter and linter, with
the rules the current gates enforce carried across, while every other gate keeps running on Deno.

- **In scope:** Prettier and ESLint (flat config, `@eslint/js` + `typescript-eslint`, not
  type-checked) as root dev dependencies; their configs and ignore files; the one-time reformat as
  its own commit, listed in `.git-blame-ignore-revs`; a committed codemod converting every
  `deno-lint-ignore` directive to its ESLint form; fixing what ESLint's recommended sets newly flag;
  `deno task fmt`/`fmt:check`/`lint` re-pointed at the new tools so every workflow and doc that
  names them stays true; root `package.json` scripts `format`, `format:check`, `lint`, written by
  the manifest generator; the two hand edits the swap forces (the drift workflow's format and lint
  guards, §3.5, and the health-indicator audit's line references, §3.1); the ROADMAP split of 111e
  into 111e1/111e2/111e3.
- **NOT this milestone:** porting `scripts/*.ts` and root `test/` to Node (111e2); `deno check` and
  the `deno doc`-based gates (111e2); rewriting the workflows and removing `deno.json`/`deno.lock`
  (111e3); `apps/compiled-binary` (111e3, decided by a Node SEA probe); the formatter a GENERATED
  project uses — CLI templates and the SDK's emitted client keep targeting `deno fmt` for Deno
  projects (unchanged; see §3.4); governing-document rewrites (111f).

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                                                                                                                                                             | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current formatter settings       | `deno.json` `fmt`                                                                                                                                                                                              | `lineWidth: 100`, `indentWidth: 2`, `singleQuote: true`, `semiColons: true`; excludes `pnpm-lock.yaml`, `docs/api`, `.verify`, `.verify-milestone`, `k8s/chart/templates`, `k8s/manifests`, `website`                                                                                                                                                                                                                                                                                                                                            |
| Current lint settings            | `deno.json` `lint`                                                                                                                                                                                             | tags `recommended` + `no-eval`, `no-sync-fn-in-async-fn`, `no-console`, `verbatim-module-syntax`; excludes `website`, `scripts/codemods`, `vitest.config.ts`, `test/node`                                                                                                                                                                                                                                                                                                                                                                        |
| Global excludes                  | `deno.json` `exclude`                                                                                                                                                                                          | `apps/full-stack/build`, `packages/*/dist`, `packages/starters/*/dist`, `scripts/codemods`                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `deno lint` and underscore names | measured, 2026-10-14                                                                                                                                                                                           | `deno lint` passes the tree while a no-escape ESLint `no-unused-vars` reports 1,381 `_`-prefixed names — deno's rule ignores a leading `_`. Today's gate PERMITS the escape (see C1)                                                                                                                                                                                                                                                                                                                                                             |
| Prettier vs `deno fmt`           | measured: Prettier 3.9.10 with the settings above, `--list-different` over 3,369 tracked files                                                                                                                 | 1,857 files differ (1,677 `.ts`, 83 `.md`, 74 `.json`, 7 `.tsx`, 14 YAML, 2 `.mjs`). Sampled diffs are algorithm differences (joining a wrapped parameter list that fits; breaking a member chain), not settings — no option set removes them                                                                                                                                                                                                                                                                                                    |
| Ignore directives                | `git grep deno-lint-ignore`, measured                                                                                                                                                                          | 429 lines in 212 files, 140 file-level. Rule names: `require-await` 234, `no-explicit-any` 106, `no-console` 81, `no-control-regex` 4, `ban-types` 3, `no-unused-vars` 1, `no-this-alias` 1, plus `ban-unused-ignore` 2 (deno-only, dropped)                                                                                                                                                                                                                                                                                                     |
| Draft ESLint run                 | measured: recommended sets + the four carried rules, before directive conversion                                                                                                                               | 2,955 findings; after excluding `_`-names and directive-suppressed rules the residue is ~70 genuinely new findings (`no-useless-assignment` 12, `ban-ts-comment` 13, `preserve-caught-error` 9, `no-this-alias` 5, …) to fix or justify                                                                                                                                                                                                                                                                                                          |
| Byte-compared generated fixtures | `packages/sdk/test/unit/openapi-codegen.test.ts:1013,1076`                                                                                                                                                     | `expect(generated).toBe(fixture)` over `packages/sdk/test/fixtures/*-client.ts`; all five `*-client.ts` fixtures are in Prettier's differing set, and the generator is written to `deno fmt`'s output (M70m X11-9)                                                                                                                                                                                                                                                                                                                               |
| Workflow steps naming the tasks  | `.github/workflows/ci.yml:423`, `release.yml:373`, `drift.yml:453`, `website.yml:77`                                                                                                                           | each runs `deno task fmt:check` / `deno task lint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Test pinning those steps         | `test/dependency-drift-gate.test.ts:146-151`                                                                                                                                                                   | asserts `run: deno task fmt:check` and `run: deno task lint` appear in `drift.yml`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| deno-lint → ESLint rule map      | docs.deno.com/lint/rules + `deno lint --rules --json` (deno 2.9.6: 124 rules, 87 recommended); ESLint `eslint-recommended.js`; typescript-eslint `configs/flat/recommended.ts` and `eslint-recommended-raw.ts` | Not a clean cover: typescript-eslint's override turns OFF core rules TypeScript is assumed to report, `no-unreachable` among them, which deno enforces (a probe passed unreachable code deno rejects). Also uncovered: `adjacent-overload-signatures`, `require-await`, `no-window`, deprecated import assertions, `no-empty-enum`, blanket `/* eslint-disable */`. No equivalent: `no-sync-fn-in-async-fn`, `no-sloppy-imports`, `no-unversioned-import`, `no-deprecated-deno-api`. Eleven recommended `jsx-*` rules need `eslint-plugin-react` |
| ESLint `no-unused-vars` default  | ESLint rule docs; probed by Codex review                                                                                                                                                                       | `args` defaults to `after-used`: an unused parameter BEFORE a used one passes, where `deno lint` reports it                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `no-console` scope today         | `deno.json` `lint.exclude`; `packages/cli/deno.json:12`                                                                                                                                                        | Only `packages/cli` is exempt (its own config). `scripts/**` is NOT: scripts carry `deno-lint-ignore-file no-console` with a reason (e.g. `scripts/plan-lint.ts:1`)                                                                                                                                                                                                                                                                                                                                                                              |
| Ignored-file inheritance         | ESLint and Prettier ignore docs; probed                                                                                                                                                                        | Prettier reads the root `.gitignore`; ESLint flat config does not, so `.tmp/` and `.claude/worktrees/` would be linted                                                                                                                                                                                                                                                                                                                                                                                                                           |
| JavaScript globals               | `scripts/fixtures/node-boot/boot.mjs:21`                                                                                                                                                                       | `.mjs` files use `console` and `process`; the recommended config reports both as undefined unless Node globals are declared                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Generated-manifest gate          | `scripts/node-manifests.ts:750-758,854`; `.github/workflows/ci.yml:524`                                                                                                                                        | `--check` compares every generated file BYTE-FOR-BYTE: member `package.json`/`tsconfig.json`/`deno.json`/`LICENSE`, root `package.json`, `tsconfig.json`, `tsconfig.base.json`, `pnpm-workspace.yaml`. Prettier rewrites 52 of them; `renderRootPackageJson` (`:553`) would drop hand-added scripts and dependencies                                                                                                                                                                                                                             |
| Line-number audit                | `test/health-indicator-audit.test.ts:70-77`                                                                                                                                                                    | builds `file:line` for every `ctx.health.register` site and requires each in `docs/health-indicators.md`; the reformat moves 21 of them                                                                                                                                                                                                                                                                                                                                                                                                          |
| Workflow text pins               | 9 root test files read `.github/workflows/*` (29 references in `test/apps-gate.test.ts` alone)                                                                                                                 | Prettier rewraps YAML; e.g. `ci.yml:48` splits an expression `test/apps-gate.test.ts:93` pins as one substring                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Drift workflow guards            | `.github/workflows/drift.yml:226-232,448-458`; `test/dependency-drift-gate.test.ts:154-160`                                                                                                                    | the Node install is `continue-on-error`, while the format and lint steps guard only on the Deno resolution; the test pins exactly four such guards                                                                                                                                                                                                                                                                                                                                                                                               |
| SDK fixture check needs settings | measured                                                                                                                                                                                                       | `deno fmt --check packages/sdk/test/fixtures/*-client.ts` passes; with `--no-config` all five fail. The `fmt` block in `deno.json` supplies quote style and width                                                                                                                                                                                                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                            | Doc deliverable (same PR)                                                               |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| C1  | ROADMAP M111e says to keep "unused-variable errors with no underscore escape", while the gate it describes (`deno lint`) allows a leading `_`, and 1,381 sites rely on it                            | The measured behaviour wins: ESLint ignores `^_` args, vars and caught errors, exactly as `deno lint` does. Removing the escape is a separate decision that would touch 1,381 sites | ROADMAP M111e bullet corrected                                                          |
| C2  | ROADMAP describes M111e as one milestone; the maintainer split it into three PRs                                                                                                                     | The split wins                                                                                                                                                                      | ROADMAP gains 111e1/111e2/111e3 sub-sections and progress rows                          |
| C3  | CLAUDE.md "Common pitfalls" says `no-console` applies everywhere except `packages/cli` and `scripts/`, while `deno.json` exempts only `packages/cli` and every script carries a file-level directive | The configuration wins: scripts stay linted for `no-console`, with their directives converted                                                                                       | Pitfall line corrected in 111f with the other governing-document wording (listed in §9) |

## 3. Design decisions

### 3.1 Prettier configuration

- **Decision:** `.prettierrc.json` = `printWidth 100`, `tabWidth 2`, `singleQuote`, `semi`,
  `trailingComma "all"`, `proseWrap "always"`, `endOfLine "lf"` — the `deno fmt` settings
  (maintainer decision 2026-10-14). `.prettierignore` carries every current `fmt.exclude` and global
  `exclude` entry, plus three groups whose bytes another mechanism owns: the five SDK `*-client.ts`
  fixtures (§3.4); every file `node-manifests` generates (§1), whose `--check` already enforces
  exact bytes; and `.github/workflows/`, which 111e3 rewrites and nine root tests pin by text. The
  one-time reformat is a commit containing nothing but formatter output, and its SHA goes in
  `.git-blame-ignore-revs`. Not carried: Deno's exclusions of `scripts/codemods`, `vitest.config.ts`
  and `test/node`, which exist because Deno cannot resolve that Node code — Prettier and ESLint can,
  so both cover it. The commit after it reconciles what the reformat moved: the 21 `file:line`
  references in `docs/health-indicators.md`.
- **Why:** the residual diff is algorithmic; isolating it in one commit keeps `git blame` useful and
  review of the real changes separate. Formatting a generated file or a pinned workflow would only
  trade one byte gate's failure for another's.
- **Test home:** `pnpm format:check` clean; `prettier --debug-check` over the reformatted tree
  (fails on any file whose output parses to a different AST); `node-manifests.ts --check` (the
  `ci.yml:524` command) clean; the full suites green after the reconciliation commit.

### 3.2 ESLint configuration

- **Decision:** flat `eslint.config.mjs`: `js.configs.recommended` + `tseslint.configs.recommended`
  (not type-checked, as `deno lint` is not), then an explicit layer that restores what deno enforces
  and the override removes or never had:
  - `no-console` everywhere except `packages/cli/**` (C3); `no-eval`; `require-await`;
    `@typescript-eslint/consistent-type-imports` (for `verbatim-module-syntax`);
    `@typescript-eslint/adjacent-overload-signatures`; `no-restricted-globals` for `window`.
  - `@typescript-eslint/no-unused-vars` with `args: 'all'`, `caughtErrors: 'all'`, and `^_`
    `argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern` (C1) — `args: 'all'` because
    the default would pass an unused parameter before a used one, which deno reports.
  - `no-unreachable` re-enabled after the typescript-eslint override, since no type check runs in
    the lint gate.
  - `no-restricted-syntax` banning the `Function` constructor (a gain — deno never caught it) and
    empty enums (deno's `no-empty-enum`). Deprecated import assertions are NOT carried here: an
    `assert` import and a `with` import parse to the identical ESTree node, so no selector can tell
    them apart, and TypeScript 6 refuses `assert` with TS2880 in both `deno check` and `tsc -b`
    (measured), so the type-check gate already owns that rule. Likewise `no-await-in-sync-fn`: no
    ESLint rule exists, and both checkers refuse it with TS1308 (measured).
  - `consistent-type-imports` with `disallowTypeAnnotations: false`: the default forbids
    `typeof import('ioredis')`, the pattern for typing a lazily loaded optional dependency (245
    sites, all permitted by deno's `verbatim-module-syntax`).
  - `no-empty-object-type` with `allowInterfaces: 'with-single-extends'`, for named contracts such
    as `interface CqrsCommand<T> extends CqrsRequest<T> {}`.
  - `@eslint-community/eslint-comments/no-unlimited-disable` refusing a blanket
    `/* eslint-disable */` (deno's `ban-untagged-ignore`), and
    `linterOptions.reportUnusedDisableDirectives: 'error'` (deno's `ban-unused-ignore`).
  - The core rules typescript-eslint's preset switches off for TypeScript on the grounds that a type
    check reports them (`no-dupe-keys`, `no-const-assign`, `getter-return`,
    `no-new-native- nonconstructor` and eleven more), restored for every file — deno lint enforced
    them and nothing type-checks `.js`/`.mjs`. `no-dupe-class-members` and `no-redeclare` stay off
    for TypeScript only (they misfire on overloads and declaration merging; `tsc` reports the real
    cases). `valid-typeof` with `requireStringLiterals: true` and `no-inner-declarations` with
    `blockScopedFunctions: 'disallow'`, matching deno's stricter forms. Found by the code review.
  - Node globals (the `globals` package) and JSX parsing for `**/*.{js,jsx,mjs,cjs}`.
  - Global ignores from `.gitignore` via `includeIgnoreFile` (`@eslint/compat`), plus `website/` and
    `apps/full-stack/build/` (§3.1 says why the Node-code exclusions are not carried).

  Dropped, and listed in the PR: `no-sync-fn-in-async-fn` (its targets are the `Deno.*Sync` calls
  111e2 removes) and the Deno-only `no-sloppy-imports`, `no-unversioned-import`,
  `no-deprecated-deno-api`. The eleven `jsx-*` rules are dropped: `eslint-plugin-react` 7.37.5, the
  current release, declares no ESLint 10 support (`peerDependencies.eslint` ends at `^9.7`).
  Recommended rules `deno lint` did not enforce stay ON; their ~70 findings are fixed, or disabled
  inline with a reason where the code is deliberate.

- **Why:** the gate must keep everything it enforces today; a recommended preset is not that, as the
  override's `no-unreachable` shows.
- **Test home:** `test/node/eslint-config.test.ts` lints planted snippets through the ESLint Node
  API with the real config and asserts each carried rule reports: `console.log` in a plugin (and not
  in `packages/cli`), `eval`, `new Function`, an untyped type-only import, an unused non-`_`
  parameter both before and after a used one, an unused caught error, unreachable code after
  `throw`, an empty enum, a blanket disable, an unused disable directive, `window`; a `_`-prefixed
  name passes; a file under `.tmp/` is ignored; a `.mjs` file using `process` passes.

### 3.3 Directive conversion

- **Decision:** a committed codemod `scripts/codemods/deno-lint-ignore-to-eslint.ts` rewrites
  `// deno-lint-ignore <rules> [-- reason]` to `// eslint-disable-next-line <mapped> [-- reason]`
  and `// deno-lint-ignore-file` to `/* eslint-disable <mapped> */`, using the map `require-await` →
  `require-await`, `no-explicit-any` → `@typescript-eslint/no-explicit-any`, `no-console` →
  `no-console`, `no-control-regex` → same, `no-unused-vars` / `no-this-alias` → the
  `@typescript-eslint/` form, `ban-types` → `@typescript-eslint/no-unsafe-function-type` (all three
  sites type a bare `Function`, `packages/react-router-plugin/test`), and `ban-unused-ignore`
  dropped. Directives are found from comment ranges of a real `ts.createSourceFile` parse: a bare
  scanner loses sync after a regular expression or a template literal (measured: it missed 107 of
  427), and could read string content as a comment. A comma- or space-separated rule list maps
  element-wise; an unmapped rule is refused with its file and line, never guessed. The configured
  `reportUnusedDisableDirectives: 'error'` then catches any converted directive that suppresses
  nothing.
- **Why:** 429 mechanical edits; a deterministic script is reviewable and rerunnable.
- **Test home:** `scripts/codemods/deno-lint-ignore-to-eslint.test.ts` (Node tooling target, so the
  codemod is coverage-measured with the other codemods); after conversion
  `git grep -n 'deno-lint-ignore' -- packages scripts test apps ':!scripts/codemods'` is empty.

### 3.4 Formatter for generated output stays `deno fmt`

- **Decision:** the five `packages/sdk/test/fixtures/*-client.ts` fixtures are excluded from
  Prettier and keep a `deno fmt --check` over exactly those files, folded into the re-pointed
  `fmt:check` task, until 111e3 decides the SDK's target formatter. `deno.json` keeps its `fmt`
  settings block for that check (width, quotes, semicolons — without it all five fail); only its
  `exclude` list goes, since the check names its files. CLI templates are untouched.
- **Why:** they are generator output byte-compared by tests, and the generator's contract is
  `deno fmt`'s output. Reformatting them would break the tests and quietly change that contract.
- **Test home:** the existing fixture-equality tests stay green; a planted misformat in a fixture
  fails `fmt:check`.

### 3.5 Task and workflow continuity

- **Decision:** `deno.json` keeps tasks `fmt`, `fmt:check`, `lint`, now running
  `pnpm exec prettier --write .` / `pnpm exec prettier --check .` plus §3.4's check /
  `pnpm exec eslint .`; its `lint` block goes. Root `package.json` gains `format`, `format:check`,
  `lint` and the five dev dependencies through `renderRootPackageJson`, so the generator stays the
  file's one source. One workflow edit is unavoidable: in `drift.yml` the format and lint steps now
  need the Node install, so both guards add `&& steps.node-resolve.outcome == 'success'` and the
  comment above them (which says these tools read no lockfile) is corrected. Every other workflow
  step is untouched until 111e3.
- **Why:** every workflow step, test pin and doc that names `deno task fmt:check` / `lint` stays
  true without editing them twice. Without the guard, a failed fresh resolution would report as a
  format or lint failure.
- **Test home:** `test/dependency-drift-gate.test.ts` keeps its four task-name pins, and its guard
  assertion is updated to expect the Node guard on exactly the format and lint steps;
  `test/unit/node-manifests.test.ts` covers the new root scripts and dependencies.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no package source surface changes.

| Exported symbol | Kind | Consumer / real code path that READS it                          |
| --------------- | ---- | ---------------------------------------------------------------- |
| None (checked)  | —    | 111e1 changes repository tooling only; no `src/index.ts` changes |

### 4.1 Options — every option names its consumer

| Option         | Consumer | Behavior (per implementation)      |
| -------------- | -------- | ---------------------------------- |
| None (checked) | —        | no plugin or package options added |

## 5. Implementation files

| File                                             | Purpose                                                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.prettierrc.json`, `.prettierignore`            | §3.1                                                                                                                                                                             |
| `eslint.config.mjs`                              | §3.2                                                                                                                                                                             |
| `scripts/codemods/deno-lint-ignore-to-eslint.ts` | §3.3                                                                                                                                                                             |
| `.git-blame-ignore-revs`                         | §3.1                                                                                                                                                                             |
| `scripts/node-manifests.ts`                      | §3.5 — root scripts and dev dependencies `prettier`, `eslint`, `@eslint/js`, `typescript-eslint`, `@eslint/compat`, `@eslint-community/eslint-plugin-eslint-comments`, `globals` |
| `package.json`, `pnpm-lock.yaml`                 | regenerated / installed                                                                                                                                                          |
| `deno.json`                                      | §3.4, §3.5 — tasks re-pointed; `lint` block and `fmt.exclude` removed                                                                                                            |
| `.github/workflows/drift.yml`                    | §3.5 guards                                                                                                                                                                      |
| `docs/health-indicators.md`                      | §3.1 reconciliation                                                                                                                                                              |
| `ROADMAP.md`                                     | C1, C2                                                                                                                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                             | src covered                                      | Key assertions                                                                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/codemods/deno-lint-ignore-to-eslint.test.ts` | `scripts/codemods/deno-lint-ignore-to-eslint.ts` | each directive form converts; reason preserved; file-level form; multi-rule list mapped element-wise; `ban-types` → `no-unsafe-function-type`; `ban-unused-ignore` dropped; unmapped rule refused naming file and line; idempotent |
| `test/node/eslint-config.test.ts`                     | `eslint.config.mjs` (behaviour)                  | §3.2 test home: every carried rule reports on its planted snippet; the `_` escape, ignores and `.mjs` globals hold                                                                                                                 |
| `test/unit/node-manifests.test.ts`                    | `scripts/node-manifests.ts`                      | root `package.json` carries the three scripts and seven dev dependencies                                                                                                                                                           |
| `test/dependency-drift-gate.test.ts`                  | `drift.yml`                                      | updated guard assertion (§3.5)                                                                                                                                                                                                     |
| existing full suites (Node, Deno lane, root)          | everything reformatted                           | green after the reconciliation commit — the evidence that formatting changed no behaviour                                                                                                                                          |

## 7. Verification gates

```bash
git branch --show-current   # feat/m111e1-prettier-eslint
deno task check:plan
deno task fmt:check         # now Prettier + the SDK fixture deno fmt check
deno task lint              # now ESLint
deno task check
deno run --allow-read --allow-env scripts/node-manifests.ts --check   # as ci.yml:524
deno task test
deno task test:coverage     # root tooling, per-file
pnpm test:coverage
deno task test:deno-lane
deno task check:docs        # markdown tables reformatted by Prettier still parse
deno task release:publish --dry-run
deno task release:verify 0.9.0
```

All of it runs after the reconciliation commit, never between it and the reformat.

## 8. Risks & mitigations

- A reformat of 1,857 files conflicts with every open branch → land it when no milestone branch is
  in flight; record the rebase recipe (`prettier --write` on the branch, then rebase) in the PR.
- Prettier rewraps markdown tables and prose that `check:docs` parses (`assert:js` tables, anchors)
  → run `check:docs` and the prose-assertion gate after the reformat, before anything else.
- A byte- or line-dependent check not found here → the full Node, Deno-lane and root suites run
  after the reconciliation commit; any failure caused purely by moved bytes is reconciled in that
  commit, never by editing the reformat commit.

## 9. Out of scope

- Scripts, root tests, `deno check`, `deno doc` gates on Node — 111e2.
- Workflow rewrites, `apps/*` on pnpm, `apps/compiled-binary`, removing `deno.json`/`deno.lock`, the
  SDK generator's target formatter — 111e3.
- Governing documents — 111f. Found stale by the M111e1 code review: `CLAUDE.md` "Common pitfalls"
  (the `verbatim-module-syntax` rule name, `deno-lint-ignore` directives, the scripts exemption
  (C3), "do not underscore-prefix" while `^_` is the kept escape, "run `deno fmt`"), its note that
  the gates cannot catch `new Function` (the restricted-syntax rule now does), and
  `AI_GUIDELINES.md` §11–§12's formatter/linter naming and `deno-lint-ignore` instructions. Comments
  that describe the SDK generator's `deno fmt` target stay true and are left alone.
- The website workflow and `website/` keep their own Deno `fmt`/`lint` tasks (`website.yml:37`,
  `website/deno.json:16`) until the website moves.
