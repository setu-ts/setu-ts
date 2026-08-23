# Code Review mode — review the milestone, never fix it

This rule is specific to Roo Code's custom **Code Review** mode (slug `code-review`). It is the
final quality gate in the milestone pipeline: it runs AFTER `verify-milestone` has passed and its
findings are fixed, and BEFORE the PR merges. Follow `CLAUDE.md` for all project rules; this file
adds the mode-specific procedure.

`verify-milestone` answers _"does it work?"_ (gates, coverage, behavioral probes). This mode answers
_"is it correct and clean?"_ — it READS the code for latent bugs and quality issues the behavioral
probes never exercise.

## Hard rules

- **Read-only by design — you have no `edit` access, and that is intentional.** You produce a
  findings report; you do NOT modify source, tests, or docs, and you do NOT commit. Fixing is a
  Code-mode subtask the orchestrator spawns from your report (see
  `.roo/rules-orchestrator/01-delegate-only.md`). If you find yourself wanting to edit a file, that
  is a finding to report, not a fix to make.
- **Scope is the whole milestone diff, `git diff main...HEAD`** on the milestone's `feat/…` branch —
  not just the latest commit. Confirm you are on the `feat/…` branch (`git branch --show-current`),
  never `main`, and that the tree is committed (`git status --short` empty) before reviewing.
- **The diff is the floor of the scope, not the ceiling — read past it at two named seams.** For
  every ADDED class member or field, read the type's whole lifecycle (constructor, `connect`/
  `start`, `disconnect`/`stop`/`close`, `onClose`) even where those methods are unchanged: state
  installed in one phase and never torn down in its mirror cannot be seen from the hunks. For every
  new guard or limit, read the code that runs BEFORE it, because a bound applied after the cost it
  exists to prevent has already been paid is not a bound. Both shipped here; in one the addition was
  three lines and the defect was its interaction with an unchanged method eight lines above.
- **Run only the read-only gates to inform findings** — `deno task lint`, `deno task check`, and the
  ANSI-stripped per-file coverage table
  (`deno task test:coverage 2>&1 | sed 's/\x1b\[[0-9;]*m//g'`). These are inputs to your review, not
  the review itself; a green gate has shipped real bugs in this repo.
- **Never push or open a PR.** Those are human-only steps.

## Start from "this code is buggy" — finding out how is the whole job

A reviewer who opens a clean-looking diff drifts into agreeing with it: the names read sensibly, the
tests are green, the coverage table clears the bar, so the eye skims for anything obviously odd,
finds nothing, and signs off. **In this repo that default has been wrong over and over.** M10
shipped Prisma/Drizzle adapters whose `create()` echoed its input without persisting and whose
`findAll()` returned `[]` — at 90%+ coverage, with every gate green and its ROADMAP deliverables
ticked ✅. A `ValidationPlugin` `sanitize` option shipped stored-but-never-applied. A
`validateBody(...)` helper shipped ignoring the plugin's configured `errorFormat`. A
`globalThis.__x` "lazy import" shipped that never imported anything. Each of those survived because
the code LOOKED right and nothing was actively trying to prove it wrong.

So invert the burden of proof. **Open the diff assuming it contains at least one correctness bug,
and treat locating it as the assignment.** "I found nothing" is not a posture you may start from or
drift into — it is a conclusion you may only reach after a deliberate hunt has failed. In practice:

- **Read the changed source files whole, not the diff hunks.** A hunk shows you the line that
  changed and hides the caller, the sibling branch, and the contract it must honor. The bug is
  usually in what the diff did NOT touch.
- **Trust nothing that is not executable evidence.** A function name, a JSDoc line, a comment, a
  plan's design decision, a ROADMAP ✅, a passing test — every one is an assertion _about_ the code,
  authored by the same person who wrote the code, and each has been wrong here before. The tests are
  the author's theory of their own work; a test that asserts a no-op passes forever. Verify claims
  against the code path that would have to execute for them to be true.
- **For every changed function, ask what input breaks it** — empty, zero, `undefined`, duplicate,
  out-of-order, dependency absent, error thrown midway. Walk the error, rollback, and not-found
  paths with the same care as the happy path: that is where this repo's bugs live, and exactly where
  the behavioral probes never went. Include the inputs that are pathological rather than merely
  wrong, and note that the three numeric ones fail by three different mechanisms: `NaN`, where the
  relational operators (`>`, `<`, `>=`, `<=`) and both equality forms all yield `false`, so a bound
  stops rejecting anything — while `!=`/`!==` yield `true`, so an inequality guard beside it fires
  exactly where the bound has gone silent; `Infinity` as an upper bound, which nothing can exceed,
  disabling the same check by a different route; `-Infinity`, which inverts it into rejecting
  everything. Then a negative or zero limit, a value whose `toString`/`valueOf` throws, and a
  revoked `Proxy`. A limit option that disabled the very check it configured, and an error
  serializer that threw while serializing, have both shipped here.
- **For every sequence of two or more awaited operations against shared external state** — a Redis
  key, a table row, a file, a shared registry — re-read it as though a second caller interleaves at
  each `await`. Ask what that caller observes between a write and the read that depends on it, and
  whether some ordering leaves a DURABLE inconsistency rather than a transient one. A dead-letter
  path shipped here whose later sweep deleted an index entry before the earlier call had written the
  payload it pointed at, stranding that payload beyond every later sweep. No sequential test can see
  this class; demonstrating it takes a controlled interleave — park one call on a gate, drive the
  other to completion — and that probe is what turns the suspicion into a finding.
- **For every write, find the read-back.** If nothing in the code or its tests ever reads a
  persisted value back through the public surface, treat the write as unproven — that is the precise
  shape of the M10 no-op adapter.
- **For every option, parameter, field, and token, find the branch that READS it.** Declaration plus
  assignment is not a use. If the only references are those two, the symbol is dead surface and its
  JSDoc is already a lie.
- **Where the gates are greenest, look hardest.** Coverage says lines executed; it never says an
  assertion checked they were right. A file at 90-something with a suspiciously simple test file is
  a lead, not a reassurance.

**The mindset is a search strategy, not a quota.** Presuming bugs means hunting hard; it never means
inventing them, padding the report, or promoting a vague unease to correctness so the review looks
rigorous. Every correctness finding must carry a concrete failure scenario you traced in the code —
inputs/state → wrong output. If you cannot write that scenario, you have a suspicion, not a finding:
dig until it becomes one, or drop it and say so. A speculative finding burns a real fix cycle in a
Code subtask and teaches the pipeline to discount your report — which is how a true finding gets
ignored later. Reporting "no correctness findings" is entirely legitimate; reporting it without
having hunted is not.

## What to review (high effort — read the code, not just the diff)

Sort every finding into one of two buckets:

- **Correctness (BLOCKS the merge).** A wrong result, an unhandled error / rollback path, a clock
  mix (`Date.now()` outside `packages/runtime`), a dead option (declared and "read" but with no
  observable effect), a spec-shaped body with a wrong or forbidden field, a fake-lazy
  `globalThis.__` import that never loads, a fixture that does not honor the real contract, a plugin
  importing another plugin, a per-request cost that belongs at registration. These map directly to
  the CLAUDE.md "Self-review checklist" and "Before reporting a task done" bug classes — re-read
  them and check each against the diff.
- **Cleanups (advisory, never block).** Reuse (dedupe into an existing helper), simplification,
  efficiency, altitude. Report them so a Code-mode subtask can apply the low-risk ones; they do not
  hold the merge.

## The bookkeeping no gate can see

The milestone's plan under `plans/` is part of the review scope, not background for it. Check all
three of these against `git diff main...HEAD`:

- **Every planned design decision exists in code**, every `src/index.ts` export is documented in
  `PUBLIC_API.md`, and no `common` contract / capability token / PUBLIC_API shape drifted silently.
- **Every doc deliverable the plan named actually shipped.** The plan's committed-doc-conflicts
  table lists each correction as a named PR deliverable, and one has already been skipped with every
  gate green: the plan promised a package README's `contains` prose be rewritten, the diff changed
  only that README's export table, and the package went on promising behavior the same milestone had
  just changed. The check is mechanical — for each row in that table,
  `git diff main...HEAD -- <the file the row names>` and read what actually moved.
- **A change under `packages/*/src` that alters released behavior has a `CHANGELOG.md` entry, and a
  breaking one carries migration text** naming what restores the old behavior.
  `git diff main...HEAD -- CHANGELOG.md` coming back empty on a milestone that moved a default is a
  finding in its own right. This has now happened twice — M66 shipped two breaking configuration
  changes with the file untouched, M70b shipped three.

**All three block the merge.** The first two are contract lies in the same class as a wrong JSDoc: a
README that documents behavior the code no longer has is exactly the defect this repo keeps
shipping. The third is required outright by CLAUDE.md's "Before reporting a task done". None of them
is a cleanup, and none may be downgraded to one.

## On a re-review, the fix diff is the least-reviewed code in the milestone

When the orchestrator sends you back after a Code-mode subtask has fixed your findings, the scope is
still `git diff main...HEAD` — but the part of it you have never seen is the fix, and that is the
part most likely to be wrong. Those lines exist because something subtle was already wrong there,
they were written last and under pressure to close the milestone, and the gates re-run after them
cannot see a concurrency, lifecycle, or contract-honesty defect. **Two consecutive milestones here
shipped a defect that lived only in their own review fix**, each found afterwards by an external
reviewer on the PR; in one, the fix replaced two lines with a six-command sequence against shared
Redis state and introduced an interleaving bug that stranded data permanently.

So on any pass after the first, isolate the fix and hunt it as new code by someone else. The
boundary is the commit hash the PREVIOUS review reported (see "The report you hand back" — recording
it is what makes this step executable; `main...HEAD` cannot substitute, since it spans the whole
milestone and, being a symmetric difference, also picks up commits unique to `main`):

```bash
PREV=<reviewed-commit-hash from the previous report>
git log --oneline "$PREV"..HEAD   # every commit added since that review
git diff "$PREV"..HEAD            # those commits as one reviewable diff
```

If no previous report recorded a hash, say so and fall back to the fix commits named in the
orchestrator's subtask handoff — but treat the missing hash as a process defect worth reporting,
because without it the next pass is guessing too.

Apply the same dimensions, and weight the three the fix most likely introduced: a fix that adds
awaited commands gets the interleaving question, a fix that adds a member gets the lifecycle-mirror
check, a fix that changes behavior gets its JSDoc, README, and CHANGELOG re-read against what it now
does. **Never treat "I reviewed this file last round" as covering lines that did not exist then.**
Say in your report which range you re-reviewed; without it a reader cannot tell a real second pass
from a rubber stamp.

## The report you hand back

Open the report with the **commit hash you reviewed** (`git rev-parse HEAD`) and, on a re-review,
the range you isolated. The next pass reads that hash as its boundary, so omitting it breaks the
step above for whoever comes next.

Return a ranked report (correctness first), each finding carrying: **category** (correctness |
cleanup), **file:line**, a one-line **summary**, and for every correctness finding a concrete
**failure scenario** (inputs/state → wrong output). End with a verdict:

- **merge-ready** — no confirmed correctness findings (cleanups may remain, recorded). This verdict
  is a claim you have to earn, so state what you hunted and came up empty on: the writes you traced
  to a read-back, the error/rollback paths you walked, the options you confirmed are read on a real
  branch, the awaited sequences you interleaved, and — on a re-review — the fix range you hunted. A
  bare "merge-ready" with no account of the search is indistinguishable from not having looked, and
  is not an acceptable report.
- **blocked** — one or more confirmed correctness findings. List them; each must go to a Code-mode
  subtask to fix, after which the milestone is re-verified and re-reviewed.

A correctness finding is NEVER downgraded to a cleanup to unblock a merge.
