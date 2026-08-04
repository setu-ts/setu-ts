# Hono Enterprise — Agent Rules (pointer)

The canonical, always-current project rules for **all** assistants live in **`CLAUDE.md`** at the
repo root. This file is intentionally a thin pointer, for the same reason `.roo/rules/01-project.md`
is: the rules exist in exactly one place and cannot drift out of sync.

`AGENTS.md` is the cross-vendor instruction file (Codex, Cursor, Cline, Windsurf, Gemini CLI all
read it), so this file is what those agents load. Roo loads `.roo/rules/`. Claude Code loads
`CLAUDE.md`. All three routes end at the same document.

**Before doing anything in this repo — and especially before starting a milestone — open and read
`CLAUDE.md` in full, then follow it.** Everything below is either a pointer into it or a stated
delta for agents that are not Claude Code.

## Read these first, in this order

1. **`CLAUDE.md`** — in full. Milestone workflow, verification gates, "Common pitfalls",
   "Self-review checklist", "Before reporting a task done", and the current milestone status.
2. **`AI_GUIDELINES.md`** — in full. Every rule is mandatory (SOLID, no `any`, no runtime-specific
   APIs outside `packages/runtime`, capability tokens from `CAPABILITIES`, `IXxx` interface naming).
3. **`ROADMAP.md`** — the section for the milestone you are starting, and the Progress Tracking
   table.
4. **`ARCHITECTURE.md`** — the sections for the package you are touching. It explains why.
5. **`PUBLIC_API.md`** — for `@hono-enterprise/common` and any package you depend on, so you consume
   existing interfaces instead of inventing new ones.
6. **The milestone's plan** under `plans/milestone-<N>-<desc>.md`. If none exists, write one from
   `plans/TEMPLATE.md` and run `deno task check:plan` before implementing.

Do NOT add or duplicate project rules in this file — put them in `CLAUDE.md` only.

## Step 0 — be on the milestone's feature branch

`main` is protected. This is the single most common way work goes wrong here, so confirm it before
reading docs or writing code:

```bash
git branch --show-current
```

One `feat/[milestone]-[description]` branch holds ALL of a milestone's work **and its fixes** until
it merges. Do not open a `fix/…` branch for an unmerged milestone — `fix/…` is only for a defect in
already-merged `main`. Never commit to `main`.

## Verification gates

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage      # read the ANSI-stripped PER-FILE table; the exit code is NOT the check
```

A milestone that adds or changes a package also runs, on a **committed** tree:

```bash
deno task publish:check
deno task release:verify <version>
```

`deno task test:coverage` exits 0 with a file under the bar. Read the per-file table yourself and
confirm every `src` file is ≥90% on branch, function, AND line.

## Paths are workspace-relative — never absolute

Every path in these rules, in `CLAUDE.md`, and in any subtask instruction is relative to the
workspace root: `CLAUDE.md`, `plans/…`, `packages/…`, `.roo/…`. Write and read them with **no
leading slash**. A leading slash resolves to the machine's filesystem root, so a doc read that comes
back "not found" is almost always this — retry without the slash.

## Scratch files go to `.tmp/`

Write every temporary, scratch, or intermediate file to `.tmp/` at the workspace root. Never `/tmp`,
never `/var/tmp`, never anywhere outside the workspace. `.tmp/` is git-ignored; never `git add`
anything in it.

This is genuine scratch only — continuation prompts, review dumps, working notes, throwaway scripts.
A milestone's canonical plan still lives at `plans/milestone-<N>-<desc>.md`, and **a milestone
commits exactly ONE plan file**. Committing a `fix-round-*.md` or a hand-off prompt under `plans/`
is a defect (M10 shipped four).

## Where `CLAUDE.md` is Claude Code-specific and does NOT apply to you

`CLAUDE.md` is written for Claude Code and mentions harness features other agents do not have.
Ignore these and use the stated substitute:

| `CLAUDE.md` says                                  | For Codex / Cursor / Cline / Gemini                                |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| Use the Skill tool / `/slash-commands`            | No equivalent. Follow the written procedures below.                |
| Write scratch to the session scratchpad directory | Use `.tmp/` (above). That path does not exist outside Claude Code. |
| The Agent / Workflow / Task tools                 | No equivalent. Do the work inline.                                 |

Everything else in `CLAUDE.md` — the branch rule, the gates, the coverage bar, the pitfalls, the
self-review checklist, the evidence requirements — applies to you unchanged.

## Procedures that replace "skills"

These are plain markdown and tool-agnostic; read and follow them directly.

- **Verify a finished milestone:** `.roo/skills/verify-milestone/SKILL.md` — gates, ANSI-stripped
  per-file coverage, forbidden-construct grep, contract fidelity, a real behavioral exercise, and
  the tracking-table checks. It defers to `CLAUDE.md` as source of truth and is the step-by-step
  procedure.
- **Review before merge:** `.roo/rules-code-review/01-review-only.md` for the policy. Scope is
  `git diff main...HEAD` on the milestone's `feat/…` branch. Correctness findings block the merge;
  reuse / simplification / efficiency cleanups are advisory.
- **Commit before reporting done:** `.roo/rules-code/01-commit-before-done.md`.

## Evidence, not vibes

Passing gates is necessary but not sufficient. Before reporting anything done:

- A no-op change passes every gate. For a bug fix, confirm the test **fails without the fix** and
  passes with it. For a config or flag change, show the before→after behavioral difference.
- Grep for what the gates miss:
  `grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/<pkg>/src`
  must come back empty (comments excepted).
- Paste the ANSI-stripped per-file coverage table, the grep result, and the exit status of both
  publish gates. "Done" without that evidence is not done.

## Pushing and opening PRs

Do not `git push` or open a PR unless the human explicitly asks in that turn. Commit on the
milestone's `feat/…` branch and hand back the exact command to run.
