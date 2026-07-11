# Milestone <N> — <Package> (`@hono-enterprise/<pkg>`)

<!--
  PLAN TEMPLATE. Copy to plans/milestone-<N>-<desc>.md and replace every <FILL: ...>.
  `deno task check:plan` FAILS while any <FILL: ...> placeholder or required section is
  missing, and warns on undecided-alternative markers and non-canonical plans/ files —
  a plan that does not lint clean is not ready to implement.

  Read CLAUDE.md "Writing a milestone plan" first. Each section below exists because its
  absence let a real defect ship green. Do not delete sections; if a table genuinely does
  not apply, write "None (checked)" and say why — never leave it blank.
-->

> **Status:** Planning. Branch: `feat/m<N>-<desc>`. `main` is protected — all work (implementation +
> fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

<FILL: one paragraph — the capability this milestone provides and where its boundary sits.>

- **In scope:** <FILL>
- **NOT this milestone:** <FILL — name the milestone that owns each deferred concern.>

## 1. Contracts verified from SOURCE (not names)

<!--
  EVERY external reference the design leans on: a committed interface/type, a capability
  token, a runtime service, AND any claim that another package/milestone "already ships X"
  or that you "build on Y". Verify each by opening the source and cite file:line. A name
  you did not read is not verified. (Misses: M10 assumed IOrmAdapter carried data access
  when it is lifecycle-only; M12 claimed M9 ships an @EventHandler decorator — it has none.)
-->

| Reference      | Source (file:line)      | Verified surface / fact                    |
| -------------- | ----------------------- | ------------------------------------------ |
| <FILL: `IXxx`> | <FILL: `packages/…:NN`> | <FILL: the methods/fields it ACTUALLY has> |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

<!--
  When two committed docs disagree (PUBLIC_API.md vs the committed source, ROADMAP vs
  ARCHITECTURE, ...), pick a side IN this plan and list the doc correction as a named PR
  deliverable — never inherit the conflict, never fix it silently at build time. If there
  are genuinely none, write a single row "None found (checked <docs>)".
-->

| #  | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| -- | -------- | ------------------------ | ------------------------- |
| C1 | <FILL>   | <FILL>                   | <FILL>                    |

## 3. Design decisions

<!--
  Every behavior a planned test asserts needs a decision here (no test may assert behavior
  the design did not specify). Resolve each seam to exactly ONE mechanism. A decision that
  lists two candidates without choosing — a slash between mechanisms, "decide later" — is an
  unresolved seam that gets improvised at implementation time; plan-lint flags the markers.
  (Miss: M12 left DomainEvent construction as three candidate mechanisms with no choice.)
-->

### 3.1 <FILL: seam name>

- **Decision:** <FILL: the single chosen mechanism — no alternatives left open.>
- **Why:** <FILL.>
- **Test home:** <FILL: which planned test asserts this.>

## 4. Exported surface — every symbol names its consumer

<!--
  List EVERY symbol exported from src/index.ts. A symbol whose only reader is its own test,
  or a field/marker no code branches on, is dead surface: wire it into a real path or cut it
  BEFORE implementing. (Misses: M12 isIntegrationEvent marker read by nothing; a helper only
  its own test called.) Options get their own sub-table so each names its consumer too.
-->

| Exported symbol | Kind                        | Consumer / real code path that READS it        |
| --------------- | --------------------------- | ---------------------------------------------- |
| <FILL: `Xxx`>   | <FILL: class/fn/type/token> | <FILL: who calls/reads it beyond its own test> |

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| ------ | -------- | ----------------------------- |
| <FILL> | <FILL>   | <FILL>                        |

## 5. Implementation files

| File               | Purpose                |
| ------------------ | ---------------------- |
| `src/index.ts`     | <FILL: barrel exports> |
| <FILL: `src/….ts`> | <FILL>                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

<!--
  Every src/ file above needs a named test file (the per-file 90% branch/function/line bar
  is decided here, not discovered later). For each planned test, confirm its call type-checks
  against the planned signature from §1/§4 — a test that publishes "two event types" against a
  single-<T> signature is a plan defect. External-dep code additionally needs one guarded
  REAL-import test, with the branching around the import unit-tested via an injection seam.
-->

| Test file | src covered | Key assertions (and the signature each call type-checks against) |
| --------- | ----------- | ---------------------------------------------------------------- |
| <FILL>    | <FILL>      | <FILL>                                                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m<N>-<desc>, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

<!-- Risks only. A DECISION does not belong here — it belongs in §3. -->

- <FILL: risk → mitigation.>

## 9. Out of scope

- <FILL: something a reader might expect here but that is deferred, and the milestone that owns it.>
