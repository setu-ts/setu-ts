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
 * Lists every tracked test file.
 *
 * `git ls-files` rather than a directory walk: it is the tracked, non-ignored
 * set, it needs no ignore rules of its own, and it is what every other gate here
 * uses. A failure THROWS rather than yielding an empty list, because an empty
 * list reads downstream as "nothing to isolate" and would put the whole suite
 * into the parallel phase.
 *
 * @returns Repository-relative `*.test.ts` paths, sorted
 * @throws {Error} If `git ls-files` fails
 */
export async function trackedTestFiles(): Promise<readonly string[]> {
  const listed = await new Deno.Command('git', {
    args: ['ls-files', '--', ...ROOTS],
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!listed.success) {
    throw new Error(`git ls-files failed: ${new TextDecoder().decode(listed.stderr).trim()}`);
  }
  return new TextDecoder().decode(listed.stdout)
    .split('\n')
    .filter((line) => line.endsWith('.test.ts'))
    .sort();
}

/**
 * Splits the tracked test files into the two phases.
 *
 * @param files - Paths to classify; defaults to every tracked test file
 * @returns The partition
 */
export async function partitionTests(files?: readonly string[]): Promise<TestPartition> {
  const paths = files ?? await trackedTestFiles();
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
