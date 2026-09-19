/**
 * Which test suites must run alone, and which may run in parallel.
 *
 * The decidable half of the two-phase suite runner, split out from
 * `test-partition.ts` for the reason `package-exports.ts` is split from its own
 * subprocess wrapper: the classification is what has to be right, so it carries
 * the per-file coverage bar, while the runner around it is a thin process seam a
 * test cannot drive without spawning the whole suite.
 *
 * This classifier's failure mode is a SILENT PASS. A signal dropped from
 * {@linkcode isolationReason} moves a hazardous suite into the parallel phase,
 * nothing goes red, and the cost appears later as an intermittent failure in
 * some unrelated suite — which is what got the first attempt at this reverted
 * (PR #339). `test/unit/test-partition.test.ts` asserts the property that no
 * parallel-phase file carries any known signal.
 *
 * @module
 */

/** Test-file roots, matching what `deno task test` passed positionally. */
export const ROOTS = ['packages', 'test'] as const;

/**
 * Environment variables that guard a suite against a shared external backend.
 *
 * Presence of any of these in a file's source means the suite talks to a
 * service another suite could be talking to at the same time. Matched as plain
 * substrings, so a mention in a comment isolates the file too — over-isolation
 * costs a little time, while under-isolation costs a flaky pipeline.
 */
const BACKEND_VARIABLES = [
  'REDIS_URL',
  'RABBITMQ_URL',
  'S3_ENDPOINT_URL',
  'SMTP_URL',
  'MONGODB_URI',
  'DYNAMODB_ENDPOINT',
  'BIGTABLE_EMULATOR_ENDPOINT',
  'NATS_URL',
  'KAFKA_BROKERS',
  'SQS_ENDPOINT_URL',
  'COSMOS_',
  'PUBSUB_EMULATOR',
  'SERVICEBUS_',
  'POSTGRES',
] as const;

/** Signals that a suite binds a real socket. */
const PORT_SIGNAL = /unusedPort|Deno\.listen|Deno\.serve|\.listen\(|\.start\(\{\s*port/;

/**
 * Why a suite must run alone, or `null` when it may run in parallel.
 *
 * The order is deliberate: the reason reported is the first that applies, and
 * the cheapest, most structural test comes first.
 *
 * @param path - Repository-relative path to a `*.test.ts` file
 * @param source - That file's contents
 * @returns A short reason, or `null` when the suite is hermetic
 */
export function isolationReason(path: string, source: string): string | null {
  // By convention an e2e suite drives the real thing — a scaffolded project, a
  // booted server, a socket. Every one of them is isolated regardless of what
  // its source happens to mention.
  if (path.includes('/test/e2e/') || path.endsWith('-e2e.test.ts')) {
    return 'e2e';
  }
  const variable = BACKEND_VARIABLES.find((name) => source.includes(name));
  if (variable !== undefined) {
    return `shared backend (${variable})`;
  }
  // A subprocess competes for CPU with the test workers rather than for a named
  // resource, which surfaces as a timeout in whichever suite is least patient.
  // `Deno.Command` also covers every suite that drives `docker`.
  if (source.includes('Deno.Command')) {
    return 'spawns a subprocess';
  }
  if (PORT_SIGNAL.test(source)) {
    return 'binds a port';
  }
  return null;
}

/** The two phases, with a reason recorded for every isolated suite. */
export interface TestPartition {
  /** Suites that must run alone, in a stable order. */
  readonly isolated: readonly string[];
  /** Suites that may run in parallel, in a stable order. */
  readonly hermetic: readonly string[];
  /** Isolated path to the reason it is isolated. */
  readonly reasons: ReadonlyMap<string, string>;
}

/**
 * Every file name shape `deno test` treats as a test file.
 *
 * Deno runs `*.test.*`, `*_test.*` and a file named exactly `test.*`, so all
 * three are matched. Classifying only `*.test.ts` left the other two shapes
 * unclassified AND still enumerated by phase 2 — that is, running in parallel
 * whatever they touched.
 */
const TEST_FILE = /(\.test\.[tj]sx?|_test\.[tj]sx?|(^|\/)test\.[tj]sx?)$/;

/** Directories a walk never descends into. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'coverage', 'build', 'dist']);

/**
 * Lists every test file under {@linkcode ROOTS} by walking the filesystem.
 *
 * A walk rather than `git ls-files`, which is what every other gate here uses,
 * and the difference is load-bearing in both directions. `git ls-files` names
 * files that may not EXIST — an unstaged `rm` or `mv` leaves an index entry
 * whose read throws, and since this runs before the suite it took down
 * `deno task test` entirely with a bare `NotFound`. And it omits UNTRACKED
 * files, which `deno test` still enumerates: a new suite written but not yet
 * staged was therefore classified by neither phase and ran in parallel
 * regardless of what it touched, which also made this module's own claim that a
 * suite is "isolated the moment it is written" false until it was staged.
 *
 * Walking the same roots `deno test` is given makes the classified set the set
 * that actually runs, which is the only version of this that can be correct.
 *
 * @returns Repository-relative test-file paths, sorted
 */
export async function discoverTestFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (entry.isFile && TEST_FILE.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const root of ROOTS) {
    await walk(root);
  }
  return found.sort();
}

/**
 * Splits the discovered test files into the two phases.
 *
 * @param files - Paths to classify; defaults to every discovered test file
 * @returns The partition
 */
export async function partitionTests(files?: readonly string[]): Promise<TestPartition> {
  const paths = files ?? await discoverTestFiles();
  const isolated: string[] = [];
  const hermetic: string[] = [];
  const reasons = new Map<string, string>();
  for (const path of paths) {
    const reason = isolationReason(path, await Deno.readTextFile(path));
    if (reason === null) {
      hermetic.push(path);
    } else {
      isolated.push(path);
      reasons.set(path, reason);
    }
  }
  return { isolated, hermetic, reasons };
}
