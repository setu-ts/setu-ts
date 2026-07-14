# Roo-specific rule — start every milestone in Architect mode, plan-only

This rule is specific to Roo Code and its mode system (Architect / Code / Orchestrator / …). It does
not override `CLAUDE.md` — it says _how_ Roo must approach the plan-first workflow that CLAUDE.md
already mandates.

## The rule

**When you begin work on a NEW milestone, you MUST be in Architect mode.** If you are in Code (or
any other) mode and the task is "start milestone N", switch to Architect mode first. Do not start a
milestone from Code mode.

In Architect mode, for a milestone start, do exactly this and nothing more:

1. Complete Step 0 from `CLAUDE.md` — be on the milestone's `feat/[milestone]-[description]` branch
   (`git branch --show-current`), never `main`.
2. Read the mandatory docs in the order `CLAUDE.md` lists (AI_GUIDELINES.md, the ROADMAP milestone
   section, ARCHITECTURE.md, PUBLIC_API.md, the `@hono-enterprise/common` source you implement, and
   the source of any package you extend).
3. Copy `plans/TEMPLATE.md` to `plans/milestone-<N>-<desc>.md`, fill every `<FILL: …>`, and run
   `deno task check:plan` until it lints clean. Apply the prose judgment in the CLAUDE.md "Writing a
   milestone plan" section (contracts verified from SOURCE, a test file for every `src/` file, real
   npm specifiers, token grammar, resolved doc conflicts, no dead options/surface).
4. **STOP.** Hand back the plan path + the clean `deno task check:plan` output + a short summary of
   the key design decisions, and wait for review/approval.

## Hard constraints during a milestone-start pass

- **Produce the ONE plan file only.** Do NOT write, edit, or scaffold any `src/` or `test/` code,
  and do NOT create a `deno.json`, a broker/service class, or a test file in this pass. (Architect
  mode's markdown-only editing is intentional — respect it; do not switch to Code mode to get around
  it.)
- **Do NOT switch to Code mode or begin implementing** until the plan has been reviewed and
  approved. A plan that fails the checklist is fixed as a plan first, never "fixed during
  implementation."
- Only ONE plan file per milestone at `plans/` root (`plans/milestone-<N>-<desc>.md`). Continuation
  notes, fix-round prompts, and hand-off scratch go in a scratch dir, NEVER under `plans/` and never
  `git add`-ed.
- Do NOT push and do NOT open a PR (those are human-only steps).

Only after the plan is approved do you switch to Code mode and implement — still on the same
`feat/…` branch, still following `CLAUDE.md`.
