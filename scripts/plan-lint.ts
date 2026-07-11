// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Milestone-plan linter — enforces the plan structure CLAUDE.md mandates,
 * mechanically, so a plan (human- or model-authored) cannot silently omit a
 * defect-prone section. A check the gate runs beats a rule the author must
 * remember and apply.
 *
 * Each check maps to a class of miss that shipped green before:
 *   - Required sections — the "Contracts verified from SOURCE" and "Exported
 *     surface" tables force the name-vs-source and dead-surface accounting that
 *     missed the M10 `IOrmAdapter` seam, the M12 `@EventHandler` claim, and the
 *     M12 `isIntegrationEvent` dead marker.
 *   - Unresolved alternatives — an undecided seam left for implementation time
 *     (the M12 `DomainEvent` construction, written as three alternatives with
 *     no choice) gets improvised or dropped. Warned, not failed: the markers are
 *     heuristic.
 *   - Template placeholders — a copied TEMPLATE whose `<FILL: …>` blanks were
 *     never filled. Failed: an unfilled plan is not a plan.
 *   - Non-canonical files at plans/ root — continuation / fix-round / hand-off
 *     prompts committed beside the one canonical plan (M10 shipped four).
 *
 * Usage:
 *   deno run --allow-read scripts/plan-lint.ts                  # all plans/*.md at root
 *   deno run --allow-read scripts/plan-lint.ts plans/x.md ...   # specific files
 *
 * Exits 1 on any ERROR. Warnings print but do not fail the run.
 */

interface Finding {
  readonly file: string;
  readonly line: number | null;
  readonly message: string;
}

const PLANS_DIR = 'plans';

/** Files that live at plans/ root but are not themselves plans to lint. */
const NON_PLAN = /^(?:TEMPLATE|README)\.md$/;

/** The only file names permitted at plans/ root. Anything else is scratch. */
const CANONICAL_ROOT = /^(?:milestone-\d+-[a-z0-9.-]+|TEMPLATE|README)\.md$/;

/** Every plan must contain a heading matching each of these. */
const REQUIRED_SECTIONS: readonly { readonly label: string; readonly match: RegExp }[] = [
  { label: 'Objective & scope', match: /objective/i },
  { label: 'Contracts verified from SOURCE', match: /contracts verified from source/i },
  { label: 'Committed-doc conflicts', match: /committed-doc conflicts/i },
  { label: 'Design decisions', match: /design decisions/i },
  { label: 'Exported surface (symbol → consumer)', match: /exported surface/i },
  { label: 'Implementation files', match: /implementation files/i },
  { label: 'Test plan', match: /test plan/i },
  { label: 'Verification gates', match: /verification gates/i },
  { label: 'Out of scope', match: /out of scope/i },
];

/** Markers of an undecided seam left for implementation time (warning). */
const UNRESOLVED_MARKERS: readonly { readonly label: string; readonly match: RegExp }[] = [
  { label: 'all-caps "OR" — undecided alternative', match: /\bOR\b/ },
  { label: '"either …"', match: /\beither\b/i },
  { label: 'TBD', match: /\bTBD\b/ },
  { label: 'TODO / FIXME', match: /\b(?:TODO|FIXME)\b/ },
  { label: 'placeholder "???"', match: /\?\?\?/ },
];

/** Unfilled template blanks (error). */
const PLACEHOLDER = /<FILL[:>]|TODO\(plan\)/;

/** Remove `inline code spans` so a signature like `A | B` never trips a marker. */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

function lintText(file: string, text: string): { errors: Finding[]; warnings: Finding[] } {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const headings: string[] = [];
  let inFence = false;

  text.split('\n').forEach((raw, i) => {
    const lineNo = i + 1;
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;

    if (/^#{1,6}\s/.test(raw)) headings.push(raw);

    const prose = stripInlineCode(raw);

    if (PLACEHOLDER.test(prose)) {
      errors.push({ file, line: lineNo, message: `unfilled template placeholder: ${raw.trim()}` });
    }
    for (const m of UNRESOLVED_MARKERS) {
      if (m.match.test(prose)) {
        warnings.push({
          file,
          line: lineNo,
          message: `possible unresolved seam (${m.label}): ${raw.trim()}`,
        });
      }
    }
  });

  const headingBlob = headings.join('\n');
  for (const s of REQUIRED_SECTIONS) {
    if (!s.match.test(headingBlob)) {
      errors.push({ file, line: null, message: `missing required section: "${s.label}"` });
    }
  }

  return { errors, warnings };
}

/** Repo-hygiene: only canonical plan files may sit at plans/ root. */
async function rootHygiene(): Promise<Finding[]> {
  const findings: Finding[] = [];
  for await (const entry of Deno.readDir(PLANS_DIR)) {
    if (!entry.isFile || !entry.name.endsWith('.md')) continue;
    if (!CANONICAL_ROOT.test(entry.name)) {
      findings.push({
        file: `${PLANS_DIR}/${entry.name}`,
        line: null,
        message: 'non-canonical file at plans/ root — only milestone-<N>-<desc>.md, ' +
          'TEMPLATE.md, README.md are permitted. Scratch (continuation / fix-round / ' +
          'hand-off / review) belongs in the session scratchpad, never committed here.',
      });
    }
  }
  return findings;
}

async function defaultTargets(): Promise<string[]> {
  const targets: string[] = [];
  for await (const entry of Deno.readDir(PLANS_DIR)) {
    if (entry.isFile && entry.name.endsWith('.md')) targets.push(`${PLANS_DIR}/${entry.name}`);
  }
  return targets.sort();
}

function format(f: Finding): string {
  const loc = f.line === null ? f.file : `${f.file}:${f.line}`;
  return `  ${loc}  ${f.message}`;
}

const args = Deno.args;
const scanningDefault = args.length === 0;
const targets = scanningDefault ? await defaultTargets() : args;

const errors: Finding[] = [];
const warnings: Finding[] = [];

// Directory-level invariant: run only when scanning the default root set.
if (scanningDefault) errors.push(...await rootHygiene());

let planCount = 0;
for (const file of targets) {
  const base = file.split('/').pop() ?? file;
  if (NON_PLAN.test(base)) continue; // TEMPLATE.md / README.md are not plans
  planCount++;
  let content: string;
  try {
    content = await Deno.readTextFile(file);
  } catch (err) {
    errors.push({
      file,
      line: null,
      message: `cannot read: ${err instanceof Error ? err.message : String(err)}`,
    });
    continue;
  }
  const result = lintText(file, content);
  errors.push(...result.errors);
  warnings.push(...result.warnings);
}

if (warnings.length > 0) {
  console.warn(`\n⚠  ${warnings.length} warning(s):`);
  for (const w of warnings) console.warn(format(w));
}

if (errors.length > 0) {
  console.error(`\n✖  ${errors.length} error(s):`);
  for (const e of errors) console.error(format(e));
  console.error('\nplan-lint failed. Fix the errors above before implementing.');
  Deno.exit(1);
}

const suffix = warnings.length > 0 ? ` (${warnings.length} warning(s))` : '';
console.log(`✓ plan-lint: ${planCount} plan(s) OK${suffix}`);
