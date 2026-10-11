import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Counts = Record<string, string[]>;
export type Coverage = Record<string, readonly [number, number, number]>;
export type GainCause = 'deno-uncounted' | 'added-proof' | 'registration';
const clean = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');

/** Suite summary lines are parents, never additional leaf tests. */
export function parseDenoLeaves(log: string): Counts {
  const entries: Counts = {};
  let file: string | undefined;
  const stack: string[] = [];
  const sequential: Counts = {};
  const pending = new Set<string>();
  for (const line of clean(log).split('\n')) {
    // `s`: a test name may carry U+2028/U+2029, which `.` does not match; lines are already split on \n.
    const match = /^\s*\.\/(packages\/.+?\.test\.tsx?) => (.+) \.\.\. (?:ok|ignored)\b/s.exec(line);
    if (match) (entries[match[1]!] ??= []).push(match[2]!);
    const module = /^running \d+ tests? from \.\/(.+?\.test\.tsx?)$/.exec(line);
    if (module) { file = module[1]!.startsWith('packages/') ? module[1] : undefined; stack.length = 0; pending.clear(); continue; }
    if (line.startsWith('./')) file = undefined;
    if (/^\s*(?:ok|ignored) \(/.test(line)) pending.delete(stack.join(' ... '));
    const step = /^( *)(.+?) \.\.\./s.exec(line);
    if (file && step && !match) {
      const depth = step[1]!.length / 2;
      stack.length = depth;
      stack.push(step[2]!);
      const name = stack.join(' ... ');
      const names = sequential[file] ??= [];
      const completed = /\.\.\. (?:ok|ignored)\b/.test(line);
      if (!completed || !pending.delete(name)) names.push(name);
      if (!completed) pending.add(name);
    }
  }
  for (const [path, names] of Object.entries(sequential)) if (!entries[path]) entries[path] = names;
  return Object.fromEntries(Object.entries(entries).map(([file, names]) => [file,
    names.filter((name) => !names.some((child) => child.startsWith(name + ' ... '))),
  ]));
}

/** The JSON reporter includes skipped leaves, so guards do not conceal collection losses. */
export function parseVitestReports(reports: readonly { testResults: readonly {
  name: string; assertionResults: readonly { fullName: string }[];
}[] }[], root: string): Counts {
  const files: Counts = {};
  for (const report of reports) for (const file of report.testResults) {
    const path = file.name.replace(root + '/', '');
    if (!path.startsWith('packages/')) continue;
    (files[path] ??= []).push(...file.assertionResults.map((test) => test.fullName));
  }
  return files;
}

export interface CountRow { file: string; deno: number; node: number; cause?: GainCause }
export interface DropRow { file: string; before: readonly number[]; after: readonly number[]; deno: number; node: number }
export interface SwapReport { counts: CountRow[]; drops: DropRow[]; failures: string[] }

/** Compare each original suite, including wholly ignored suites counted from source. */
export function compareSwap(
  baseline: Counts, converted: Counts, before: Coverage, after: Coverage,
  options: { fallback?: Record<string, number>; gains?: Record<string, GainCause>; denoOnly?: readonly string[]; denoLane?: Counts } = {},
): SwapReport {
  const counts: CountRow[] = []; const failures: string[] = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(converted), ...Object.keys(options.fallback ?? {})])) {
    const deno = options.fallback?.[file] ?? baseline[file]?.length ?? 0;
    const retained = options.denoOnly?.includes(file);
    const names = retained ? options.denoLane?.[file] ?? [] : converted[file] ?? [];
    if (retained && !options.denoLane?.[file]) failures.push(`${file}: missing retained Deno collection`);
    const node = names.length;
    const cause = options.gains?.[file];
    counts.push({ file, deno, node, ...(cause ? { cause } : {}) });
    if (node < deno) failures.push(`${file}: lost ${deno - node} leaf test(s)`);
    if (node > deno && !cause) failures.push(`${file}: unclassified gain of ${node - deno}`);
    if (node > deno && cause === 'registration') failures.push(`${file}: duplicate registration`);
    const frequencies = (values: readonly string[]) => {
      const result = new Map<string, number>();
      for (const value of values) {
        const normalized = value.replaceAll(' ... ', ' ');
        result.set(normalized, (result.get(normalized) ?? 0) + 1);
      }
      return result;
    };
    const priorNames = frequencies(baseline[file] ?? []);
    if ([...frequencies(names)].some(([name, count]) => count > 1 && count > (priorNames.get(name) ?? 0))) {
      failures.push(`${file}: repeated collected names`);
    }
  }
  const drops: DropRow[] = [];
  for (const [file, previous] of Object.entries(before)) {
    const current = after[file];
    if (!current) { failures.push(`${file}: missing coverage row`); continue; }
    if (current.some((value, index) => value < previous[index]!)) {
      const member = file.split('/src/')[0]!;
      const relevant = counts.filter((row) => row.file.startsWith(member + '/test/'));
      drops.push({ file, before: previous, after: current,
        deno: relevant.reduce((n, row) => n + row.deno, 0), node: relevant.reduce((n, row) => n + row.node, 0) });
    }
  }
  return { counts: counts.sort((a, b) => a.file.localeCompare(b.file)), drops, failures };
}

/** Render every suite and every coverage regression, with explicit gain dispositions. */
export function renderSwap(report: SwapReport): string {
  return [ '# M111b test-suite swap evidence', '',
    `Failures: **${report.failures.length}**. Coverage columns: branch / function / line.`, '',
    ...report.failures.map((failure) => `- ${failure}`), '',
    '| Test file | Deno leaves | Converted leaves | Gain cause |', '| --- | ---: | ---: | --- |',
    ...report.counts.map((row) => `| ${row.file} | ${row.deno} | ${row.node} | ${row.cause ?? '—'} |`), '',
    'Coverage drops show the leaf counts of the owning member, since a source file can be reached by several suites.', '',
    '| Source file | Deno % | Converted % | Deno member leaves | Converted member leaves |', '| --- | --- | --- | ---: | ---: |',
    ...report.drops.map((row) => `| ${row.file} | ${row.before.join(' / ')} | ${row.after.join(' / ')} | ${row.deno} | ${row.node} |`), '',
  ].join('\n');
}

/** CLI input is the preserved pre-swap Deno log, coverage baseline, and reviewed gain dispositions. */
export function main(args: readonly string[], root = process.cwd()): number {
  if (args.length !== 4) throw new Error('Usage: swap-report.ts deno-log baseline-coverage dispositions output');
  const [logPath, coveragePath, dispositionsPath, outputPath] = args;
  const baseline = parseDenoLeaves(readFileSync(resolve(root, logPath!), 'utf8'));
  const previous: Coverage = JSON.parse(readFileSync(resolve(root, coveragePath!), 'utf8'));
  const options = JSON.parse(readFileSync(resolve(root, dispositionsPath!), 'utf8'));
  if (options.denoLaneLog) options.denoLane = parseDenoLeaves(readFileSync(resolve(root, options.denoLaneLog), 'utf8'));
  const directory = resolve(root, 'coverage-node');
  const reports = []; const after: Coverage = {};
  for (const member of readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const path = resolve(directory, member.name);
    reports.push(JSON.parse(readFileSync(resolve(path, 'tests.json'), 'utf8')));
    const summary = JSON.parse(readFileSync(resolve(path, 'coverage-summary.json'), 'utf8'));
    for (const [file, value] of Object.entries(summary)) {
      if (file === 'total') continue;
      const row = value as { branches: { pct: number }; functions: { pct: number }; lines: { pct: number } };
      after[file.replace(root + '/', '')] = [row.branches.pct, row.functions.pct, row.lines.pct];
    }
  }
  Object.assign(after, options.denoCoverage ?? {});
  const report = compareSwap(baseline, parseVitestReports(reports, root), previous, after, options);
  writeFileSync(resolve(root, outputPath!), renderSwap(report));
  return report.failures.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
