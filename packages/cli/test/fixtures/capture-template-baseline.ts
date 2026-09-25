// deno-lint-ignore-file no-console -- a capture script reports what it wrote
/**
 * Captures the template byte-identity baseline for M99e §3.7.
 *
 * This is the ONLY way `template-baseline.json` is (re)generated. It renders
 * every baseline (host, runtime) pair through the same `resolveHost` +
 * `projectFiles` path the `new` command uses, SHA-256s each emitted file, and
 * writes the map. Run it from the repository root BEFORE any template change
 * you want the baseline to reflect:
 *
 *   deno run --allow-read --allow-write packages/cli/test/fixtures/capture-template-baseline.ts
 *
 * It is NOT a gate: no task runs it. A stale fixture is only a problem if a
 * template's output changed and the fixture was not re-captured — and that is
 * exactly what the test that reads the fixture
 * (`test/unit/templates/style-baseline.test.ts`) is there to catch.
 *
 * The enumeration ({@linkcode BASELINE_PAIRS}) and the host table
 * ({@linkcode BASELINE_HOSTS}) are exported so the test re-renders exactly the
 * pairs this script captured; the two cannot drift because the test imports
 * them rather than re-listing them.
 *
 * @module
 */
import { TARGET_RUNTIMES, type TargetRuntime } from '../../src/constants.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { CLASS_BASED_TEMPLATE } from '../../src/templates/class-based.ts';
import { MICROSERVICE_TEMPLATE } from '../../src/templates/microservice.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import type { TemplateHost } from '../../src/templates/registry.ts';

/** The fixed project name every baseline render uses, so the README is stable. */
export const BASELINE_NAME = 'baseline';

/**
 * The hosts the baseline pins, keyed by the name the pair keys and the test use.
 *
 * The three styleable templates each pin all four runtimes; the no-template
 * (`minimal`) host pins the default `deno` runtime, which is what a bare
 * `setu new <name>` produces.
 */
export const BASELINE_HOSTS: Readonly<Record<string, TemplateHost>> = {
  rest: REST_TEMPLATE,
  microservice: MICROSERVICE_TEMPLATE,
  'class-based': CLASS_BASED_TEMPLATE,
  minimal: MINIMAL_HOST,
};

/** The (host, runtime) pairs the baseline covers, in capture order. */
export const BASELINE_PAIRS: readonly (readonly [host: string, runtime: TargetRuntime])[] = (() => {
  const pairs: [string, TargetRuntime][] = [];
  for (const host of ['rest', 'microservice', 'class-based']) {
    for (const runtime of TARGET_RUNTIMES) pairs.push([host, runtime]);
  }
  pairs.push(['minimal', 'deno']);
  return pairs;
})();

/**
 * The SHA-256 of a file's contents, hex-encoded.
 *
 * `crypto.subtle` rather than a Node import: the CLI is Deno-first and the
 * baseline must hash identically on every runtime this repository tests.
 *
 * @param text - The file contents to hash
 * @returns The lowercase hex digest
 */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Renders every baseline pair and writes the fixture.
 *
 * @returns The number of pairs captured
 */
async function capture(): Promise<number> {
  const baseline: Record<string, Record<string, string>> = {};
  for (const [hostName, runtime] of BASELINE_PAIRS) {
    const host = BASELINE_HOSTS[hostName];
    if (host === undefined) throw new Error(`Unknown baseline host: ${hostName}`);
    const files = projectFiles(BASELINE_NAME, runtime, resolveHost(host, runtime));
    const hashes: Record<string, string> = {};
    for (const file of files) hashes[file.path] = await sha256Hex(file.contents);
    baseline[`${hostName}/${runtime}`] = hashes;
  }
  const out = new URL('./template-baseline.json', import.meta.url);
  await Deno.writeTextFile(out, `${JSON.stringify(baseline, null, 2)}\n`);
  return Object.keys(baseline).length;
}

// Runs only when executed directly (`deno run …`), never when the test imports
// this module for its exports.
if (import.meta.main) {
  const count = await capture();
  console.log(`Captured ${count} (host, runtime) pairs → ${import.meta.url}`);
}
