// deno-lint-ignore-file no-console -- a gate must print actionable findings.
/**
 * Executable prose-assertion gate.
 *
 * A rendered Markdown table following an `assert:js` marker names JavaScript
 * expressions and their expected JSON values. This gate evaluates the claims
 * in a permission-denied subprocess, so a mechanical statement in prose is
 * checked by CI instead of relying on an author's recollection.
 *
 * @module
 */

/** Marker placed in a comment block immediately before a claim table. */
export const MARKER = 'assert:js';

/** Documentation roots scanned when no file arguments are supplied. */
export const SCAN_ROOTS: readonly string[] = ['.', 'docs', 'packages', 'apps', 'compat', '.roo'];

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'build', '.wrangler', 'dist']);
const DEFAULT_TIMEOUT_MS = 10_000;

/** A marked Markdown-table block and its first source line. */
export interface ClaimBlock {
  readonly text: string;
  readonly firstLine: number;
}

/** One expression and its expected JSON value. */
export interface Claim {
  readonly expression: string;
  readonly expected: unknown;
  readonly line: number;
}

/** The sandbox's result for one claim. */
export type ClaimResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

/** A failed or unverified assertion in a document. */
export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

interface SourceBlock {
  readonly text: string;
  readonly firstLine: number;
}

function splitBlocks(source: string): readonly SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let lines: string[] = [];
  let firstLine = 1;

  const flush = (): void => {
    if (lines.length > 0) blocks.push({ text: lines.join('\n'), firstLine });
    lines = [];
  };

  for (const [index, line] of source.split('\n').entries()) {
    if (/^\s*$/.test(line)) {
      flush();
      firstLine = index + 2;
      continue;
    }
    lines.push(line);
  }
  flush();
  return blocks;
}

function hasMarker(block: SourceBlock): boolean {
  const escapedMarker = MARKER.replace(':', '\\:');
  return new RegExp(
    `<!--\\s*${escapedMarker}\\s*-->|^\\s*(?:#|//)\\s*${escapedMarker}\\s*$`,
    'im',
  ).test(block.text);
}

/**
 * Finds the blocks immediately following an `assert:js` marker.
 *
 * @param source - Markdown source to inspect
 * @returns Every marked block, retaining its source line for diagnostics
 */
export function findClaimBlocks(source: string): readonly ClaimBlock[] {
  const blocks = splitBlocks(source);
  const found: ClaimBlock[] = [];
  for (const [index, block] of blocks.entries()) {
    if (!hasMarker(block)) continue;
    const claimed = blocks[index + 1];
    if (claimed !== undefined) found.push(claimed);
  }
  return found;
}

function tableCells(line: string): readonly string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells: string[] = [];
  let cell = '';
  let escaped = false;
  for (const character of trimmed.slice(1, -1)) {
    if (escaped) {
      cell += character === '|' ? '|' : `\\${character}`;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += character;
    }
  }
  if (escaped) cell += '\\';
  cells.push(cell.trim());
  return cells;
}

function codeCell(cell: string, label: string): string {
  const match = /^`([^`]+)`$/.exec(cell);
  if (match === null) throw new Error(`${label} must be one inline-code span`);
  return match[1] as string;
}

/**
 * Parses a visible two-column assertion table.
 *
 * @param block - The Markdown block following an assertion marker
 * @returns Parsed claims with their source lines
 * @throws {Error} When the block is not the required table grammar
 */
export function parseClaimTable(block: ClaimBlock): readonly Claim[] {
  const lines = block.text.split('\n');
  if (lines.length < 3) throw new Error('must contain a header, separator, and at least one claim');
  const header = tableCells(lines[0] as string);
  const separator = tableCells(lines[1] as string);
  if (header?.[0] !== 'Expression' || header[1] !== 'Value' || header.length !== 2) {
    throw new Error('must start with an Expression and Value header');
  }
  if (
    separator === null || separator.length !== 2 ||
    !separator.every((cell) => /^:?-+:?$/.test(cell))
  ) {
    throw new Error('must contain a two-column Markdown table separator');
  }

  const claims: Claim[] = [];
  for (let index = 2; index < lines.length; index += 1) {
    const cells = tableCells(lines[index] as string);
    if (cells === null || cells.length !== 2) {
      throw new Error(`row ${index + 1} must have exactly two cells`);
    }
    const expression = codeCell(cells[0] as string, 'Expression');
    const expectedText = codeCell(cells[1] as string, 'Value');
    try {
      claims.push({
        expression,
        expected: JSON.parse(expectedText) as unknown,
        line: block.firstLine + index,
      });
    } catch {
      throw new Error(`Value in row ${index + 1} must be a JSON literal`);
    }
  }
  return claims;
}

/**
 * Builds the permission-denied program that evaluates a document's claims.
 *
 * @param claims - Expressions to evaluate
 * @returns TypeScript source that emits one JSON line per expression
 */
export function buildProgram(claims: readonly Claim[]): string {
  return claims.map((claim) =>
    `try {
  const value = (${claim.expression});
  console.log(JSON.stringify({ ok: true, value }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.name + ': ' + error.message : String(error) }));
}`
  ).join('\n');
}

/**
 * Parses sandbox output and rejects incomplete or malformed batches.
 *
 * @param stdout - JSON-lines output from the sandbox
 * @param expected - Number of results the program must emit
 * @returns Results when every expected line is valid, otherwise null
 */
export function parseResults(stdout: string, expected: number): readonly ClaimResult[] | null {
  const lines = stdout.trim().length === 0 ? [] : stdout.trim().split('\n');
  if (lines.length !== expected) return null;
  const results: ClaimResult[] = [];
  for (const line of lines) {
    try {
      const decoded: unknown = JSON.parse(line);
      if (typeof decoded !== 'object' || decoded === null || !('ok' in decoded)) return null;
      const record = decoded as Record<string, unknown>;
      if (record.ok === true && 'value' in record) {
        results.push({ ok: true, value: record.value });
      } else if (record.ok === false && typeof record.error === 'string') {
        results.push({ ok: false, error: record.error });
      } else {
        return null;
      }
    } catch {
      return null;
    }
  }
  return results;
}

/**
 * Evaluates a document's claims in a no-permissions Deno subprocess.
 *
 * @param claims - Claims in one document
 * @param timeoutMs - Maximum time permitted for the complete batch
 * @returns Results, or null when the batch is unverified
 */
export async function evaluateClaims(
  claims: readonly Claim[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<readonly ClaimResult[] | null> {
  const child = new Deno.Command('deno', {
    args: ['run', '--no-prompt', '--ext=ts', '-'],
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const outputPromise = child.output();
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(buildProgram(claims)));
    await writer.close();
  } catch {
    return null;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const output = await Promise.race([
    outputPromise,
    new Promise<null>((resolve) => {
      timeoutId = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (output === null) {
    child.kill('SIGKILL');
    await outputPromise;
    return null;
  }
  if (!output.success) return null;
  return parseResults(new TextDecoder().decode(output.stdout), claims.length);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) =>
        jsonValuesEqual(value, right[index])
      );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  return leftKeys.length === Object.keys(rightRecord).length &&
    leftKeys.every((key) =>
      Object.hasOwn(rightRecord, key) && jsonValuesEqual(leftRecord[key], rightRecord[key])
    );
}

/**
 * Compares one expected claim value with a sandbox result.
 *
 * @param claim - Declared expression and expected value
 * @param result - Sandbox result for that expression
 * @returns A finding when the claim is false or unverified, otherwise null
 */
export function compareClaim(claim: Claim, result: ClaimResult | undefined): Finding | null {
  if (result === undefined) {
    return { line: claim.line, file: '', message: 'Unverified: sandbox batch was incomplete.' };
  }
  if (!result.ok) {
    return { line: claim.line, file: '', message: `Failed: ${result.error}` };
  }
  if (!jsonValuesEqual(result.value, claim.expected)) {
    return {
      line: claim.line,
      file: '',
      message: `Expected ${JSON.stringify(claim.expected)}, received ${
        JSON.stringify(result.value)
      }.`,
    };
  }
  return null;
}

/**
 * Checks every marked table in one document.
 *
 * @param file - File name used in findings
 * @param source - Markdown source to check
 * @param timeoutMs - Per-document sandbox timeout
 * @returns Findings for malformed, failed, or unverified assertions
 */
export async function checkDocument(
  file: string,
  source: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const claims: Claim[] = [];
  for (const block of findClaimBlocks(source)) {
    try {
      claims.push(...parseClaimTable(block));
    } catch (error) {
      findings.push({
        file,
        line: block.firstLine,
        message: `Malformed ${MARKER} table: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
  }
  if (claims.length === 0) return findings;

  const results = await evaluateClaims(claims, timeoutMs);
  if (results === null) {
    for (const claim of claims) {
      findings.push({ file, line: claim.line, message: 'Unverified: sandbox batch failed.' });
    }
    return findings;
  }
  for (const [index, claim] of claims.entries()) {
    const finding = compareClaim(claim, results[index]);
    if (finding !== null) findings.push({ ...finding, file });
  }
  return findings;
}

/**
 * Collects Markdown documents under one configured scan root.
 *
 * @param root - Directory to walk
 * @returns Markdown files found beneath the root
 */
export async function collectMarkdown(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(directory)) entries.push(entry);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const path = directory === '.' ? entry.name : `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        if (directory !== '.') await walk(path);
      } else if (entry.name.endsWith('.md')) {
        found.push(path);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * Runs the gate for command-line arguments without printing or exiting.
 *
 * @param args - Positional file paths and an optional `--timeout=<ms>` flag
 * @returns All findings, including invalid arguments and unreadable files
 */
export async function run(args: readonly string[]): Promise<readonly Finding[]> {
  const timeoutArgument = args.find((argument) => argument.startsWith('--timeout='));
  const timeoutMs = timeoutArgument === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(timeoutArgument.slice('--timeout='.length));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return [{
      file: 'arguments',
      line: 1,
      message: 'The --timeout value must be a positive number of milliseconds.',
    }];
  }
  const argumentsFiles = args.filter((argument) => !argument.startsWith('--'));
  const files = argumentsFiles.length > 0
    ? argumentsFiles
    : [...new Set((await Promise.all(SCAN_ROOTS.map(collectMarkdown))).flat())].sort();
  const findings: Finding[] = [];
  for (const file of files) {
    try {
      findings.push(...await checkDocument(file, await Deno.readTextFile(file), timeoutMs));
    } catch (error) {
      findings.push({
        file,
        line: 1,
        message: `Cannot read document: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const findings = await run(Deno.args);
  if (findings.length === 0) Deno.exit(0);
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: ${finding.message}`);
  }
  Deno.exit(1);
}
