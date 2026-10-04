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

/**
 * The only file names permitted at plans/ root. Anything else is scratch.
 *
 * The milestone number carries an optional letter suffix, because a lettered
 * sub-milestone (`14b`, `52c`, `70a`) is this repo's established unit for an
 * addition to a shipped package — see the ROADMAP Progress Tracking table. A
 * digits-only pattern rejected every one of them, so no sub-milestone plan
 * could ever lint clean.
 */
const CANONICAL_ROOT = /^(?:milestone-\d+[a-z]?-[a-z0-9.-]+|TEMPLATE|README)\.md$/;

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

/**
 * The compatibility statement every plan's "Exported surface" section must
 * carry, decided at PLAN time rather than discovered at cut time.
 *
 * From `0.9.0` a patch release is the norm and breaking changes are batched
 * into an occasional minor (ROADMAP "Versioning policy from 0.9.0"). Most of
 * the breaks the minors before it carried were REQUIRED members added to a
 * published interface — "breaking for implementors" — decided inside a
 * milestone with no release in view. So a plan states it: either `none`, or
 * what breaks AND the minor that will carry it, so the release that ships the
 * milestone is chosen when the break is designed. `verify-release` check 10
 * is the other half, at cut time.
 */
const BREAKING_MARKER = /^\*\*Breaking for implementors:\*\*\s*(.*)$/i;
const TARGET_MINOR = /\b\d+\.\d+\.0\b|\bnext minor\b|\ba minor\b/i;

/** Remove `inline code spans` so a signature like `A | B` never trips a marker. */
function stripInlineCode(line: string): string {
  return line.replace(/`[^`]*`/g, '');
}

export function lintText(file: string, text: string): { errors: Finding[]; warnings: Finding[] } {
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

  // The statement is a PARAGRAPH: `deno fmt` reflows prose, so the minor it
  // names may sit on the line after the marker. Read to the next blank line.
  const breakingStatement = (() => {
    const lines = text.split('\n');
    const start = lines.findIndex((line) => BREAKING_MARKER.test(line.trim()));
    if (start === -1) return null;
    const paragraph: string[] = [BREAKING_MARKER.exec(lines[start].trim())?.[1] ?? ''];
    for (let i = start + 1; i < lines.length && lines[i].trim() !== ''; i += 1) {
      paragraph.push(lines[i].trim());
    }
    return { line: start + 1, value: paragraph.join(' ').trim() };
  })();

  if (breakingStatement === null) {
    errors.push({
      file,
      line: null,
      message:
        'missing compatibility statement: the "Exported surface" section must carry a line ' +
        '`**Breaking for implementors:** none` or `**Breaking for implementors:** <what>, ships in ' +
        'minor <X.Y.0>` — the release that carries a break is chosen when the break is designed.',
    });
  } else if (
    !/^none\b/i.test(breakingStatement.value) && !TARGET_MINOR.test(breakingStatement.value)
  ) {
    errors.push({
      file,
      line: breakingStatement.line,
      message: 'the compatibility statement names a break but no minor release to carry it — add ' +
        '"ships in minor <X.Y.0>" (a patch may not carry a BREAKING entry; verify-release check 10 ' +
        'refuses one).',
    });
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

if (import.meta.main) await main(Deno.args);

/** The command: lint the given files, or every plan at `plans/` root. */
async function main(args: readonly string[]): Promise<void> {
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
}
