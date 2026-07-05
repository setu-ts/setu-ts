# Hono Enterprise — Project Rules (pointer)

The canonical, always-current project rules for ALL assistants live in **`/CLAUDE.md`** at the repo
root. This file is intentionally a thin pointer so the rules exist in exactly one place and cannot
drift out of sync.

**Before doing anything in this repo — and especially before starting a milestone — open and read
`/CLAUDE.md` in full, then follow it.** It covers:

- **Step 0 for every milestone: be on the milestone's feature branch.** `main` is protected — one
  `feat/[milestone]-[description]` branch per milestone holds ALL its work AND its fixes until it
  merges. Confirm with `git branch --show-current` BEFORE reading docs or writing code; resume the
  existing `feat/…` branch if work is in progress. Do NOT open a `fix/…` branch for an unmerged
  milestone — that is only for defects in already-merged `main`. Never work on or commit to `main`.
- the documentation you MUST read first (AI_GUIDELINES.md, ROADMAP.md, ARCHITECTURE.md,
  PUBLIC_API.md, and the `@hono-enterprise/common` interfaces you will implement);
- the verification gates (`deno task fmt:check` / `lint` / `check` / `test` / `test:coverage` /
  `audit`);
- the "Common pitfalls", "Self-review checklist", and "Before reporting a task done (evidence, not
  vibes)" sections;
- the current milestone status.

Do NOT add or duplicate project rules in this file — put them in `/CLAUDE.md` only. That is why
there is nothing else to update here.
