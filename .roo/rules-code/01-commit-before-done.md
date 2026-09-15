# Code mode — your work is not finished until it is committed

This rule is specific to Roo Code's **Code** mode. Follow `CLAUDE.md` for the branch and commit
conventions (one `feat/…` branch per milestone; conventional commit messages; never work on or
commit to `main`; push and PRs are human-only). This file adds the mode-specific gate: leaving the
tree dirty when you switch out of Code is the single most common way work gets lost, because **no
other mode can commit it for you**.

## Hard rules

- **You are not done until your changes are committed.** Before you switch out of Code mode — and
  before you end the task — commit the work you produced on the current `feat/…` branch with a
  conventional message (`feat(scope): …`, `fix(scope): …`, `docs: …`).
- **Check the tree state as your last action.** Run `git status --porcelain` at the very end and
  read it. Empty output is the signal that you actually finished; a non-empty tree means you are
  still in Code mode's job and must not move on.
- **A dirty tree blocks both gates.** Verify Milestone and Code Review each refuse to run over
  uncommitted changes, and refusing is correct — an uncommitted change can mask the exact defect
  they are hunting. So committing is not bookkeeping; it is what makes the next step possible.
- **Commit only — never push or open a PR.** Those are human-only steps (see
  `.roo/rules-orchestrator/01-switch-modes.md`).

## Notes

- Commit as you finish each unit of work rather than deferring to "later": the point at which you
  switch modes is exactly the point at which an uncommitted change becomes invisible.
- If you genuinely changed nothing (e.g. a read-only audit), say so explicitly instead of
  committing; an empty `git status --porcelain` still confirms it.
