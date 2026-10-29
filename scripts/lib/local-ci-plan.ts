import { parse } from 'yaml';
import { stripVTControlCharacters } from 'node:util';

/** The required CI matrix shards. */
export const SHARDS = [
  'static',
  'cli-1',
  'cli-2',
  'cli-3',
  'messaging',
  'packages',
  'tooling',
] as const;
/** A required shard or an explicitly requested extra job. */
export type Shard =
  (typeof SHARDS)[number] | 'cli-coverage' | 'deno-lane' | 'compat' | 'node-build';
/** Validated command-line selection. */
export interface ILocalOptions {
  shards: Shard[];
  keep: boolean;
  parallel?: number;
  cpus?: string;
}
/**
 * Conservative peak reservation per shard: the CLI runner (3,961 MiB) plus its backend peaks
 * (2,843 MiB) is 6.6 GiB, and the tooling runner, which has no backends, gets an 8 GiB cap
 * because it peaked at 6,136 MiB under the earlier 6 GiB cap and was OOM-killed at 6,144 MiB.
 */
export const SHARD_BUDGET_BYTES = 8 * 1024 ** 3;
/** The budget in whole GiB, for messages. */
const SHARD_BUDGET_GIB = SHARD_BUDGET_BYTES / 1024 ** 3;

/**
 * Deferred jobs run alone after the shared shards. CLI coverage consumes all three
 * completed blobs. `node-build` rewrites the worktree's shared install via
 * `scripts/check-node-build.ts`, which runs `pnpm install --frozen-lockfile` and `tsc -b`,
 * which the workflow-step filter cannot see; run beside a test shard, it deleted vitest under
 * that shard mid-run. These run one at a time, after every shared shard has finished.
 */
export const EXCLUSIVE_SHARDS: readonly Shard[] = ['cli-coverage', 'node-build'];

/** The runner container's memory cap: tooling needs more and carries no backends. */
export function runnerMemory(shard: Shard): string {
  return shard === 'tooling' ? '8g' : '6g';
}
/** Share this invocation's blob directory with every CLI runner; logs and coverage stay outside it. */
export function cliReportMounts(directory: string, root: string, shard: Shard): string[] {
  if (!shard.startsWith('cli-')) return [];
  // Coverage is NOT mounted: a mount point cannot be removed, and Vitest empties
  // its reports directory first (EBUSY). Each shard writes coverage-node/cli/shard-<i>.
  return ['-v', `${directory}/vitest-reports:${root}/.vitest-reports`];
}
/** Standard validation remains available without this optional accelerator. */
export const NORMAL_GATES =
  'pnpm run fmt:check, pnpm run lint, pnpm run check, pnpm test:coverage, pnpm run test:tooling:coverage';
/** Read-only host probes, separated from preflight decisions for testing. */
export interface IHostResources {
  platform: string;
  dockerCli: boolean;
  dockerDaemon: boolean;
  freeMemory: number;
  threads: number;
}

/** Choose a bounded worker count, reserving two threads and 8 GiB per shard. */
export function chooseParallelism(freeMemory: number, threads: number, requested?: number): number {
  return Math.max(
    1,
    Math.min(
      5,
      requested ?? Math.min(Math.floor(freeMemory / SHARD_BUDGET_BYTES), Math.floor(threads / 2)),
    ),
  );
}

/** Refuse before creating any resources, always pointing to the normal gates. */
export function preflight(host: IHostResources, requested?: number): string | undefined {
  const reason =
    host.platform !== 'linux'
      ? 'Linux is required'
      : !host.dockerCli
        ? 'the Docker CLI is unavailable'
        : !host.dockerDaemon
          ? 'the Docker daemon is unavailable'
          : host.freeMemory < SHARD_BUDGET_BYTES
            ? `available memory is below the ${SHARD_BUDGET_GIB} GiB budget for one shard`
            : requested !== undefined && requested * SHARD_BUDGET_BYTES > host.freeMemory
              ? `--parallel ${requested} requires ${requested * SHARD_BUDGET_GIB} GiB available memory`
              : undefined;
  return reason === undefined
    ? undefined
    : `Optional local CI accelerator refused: ${reason}. Use the always-available standard gates: ${NORMAL_GATES}. CI and those gates remain the source of truth.`;
}

/** Prefer Linux's reclaimable available memory, falling back to os.freemem(). */
export function availableMemory(meminfo: string, fallback: number): number {
  const value = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return value === null ? fallback : Number(value[1]) * 1024;
}

/**
 * Run at most n shards concurrently; each worker releases resources before taking another.
 * Shards in {@linkcode EXCLUSIVE_SHARDS} start only after every shared shard has finished, one at
 * a time. Results keep the selection order. CLI merging depends on completed blobs;
 * node-build's exclusivity is isolation, not a dependency: a shard
 * that finished with a nonzero exit code still lets an exclusive shard run, as CI's `node-build`
 * job (which has no `needs:`) runs whatever the test shards report. Only a rejected worker, which
 * may still hold resources, stops it.
 */
export async function scheduleShards<T>(
  shards: readonly Shard[],
  parallel: number,
  task: (shard: Shard) => Promise<T>,
): Promise<T[]> {
  const results: T[] = new Array(shards.length);
  const indexes = shards.map((_, index) => index);
  const shared = indexes.filter((index) => !EXCLUSIVE_SHARDS.includes(shards[index]!));
  const exclusive = EXCLUSIVE_SHARDS.flatMap((shard) =>
    indexes.filter((index) => shards[index] === shard),
  );
  let next = 0;
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(parallel, shared.length) }, async () => {
      while (next < shared.length) {
        const index = shared[next++]!;
        results[index] = await task(shards[index]!);
      }
    }),
  );
  // A cleanup failure must not let the caller remove resources while another
  // worker is still starting or using them.
  const failure = workers.find((worker) => worker.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  for (const index of exclusive) results[index] = await task(shards[index]!);
  return results;
}
/** One CI command and its step-scoped environment. */
export interface ICommand {
  run: string;
  env: Record<string, string>;
}
/** Explicit backend listeners, launch options and readiness proof. */
export interface IBackend {
  name: string;
  image: string;
  ports: number[];
  memory: string;
  args: string[];
  env: Record<string, string>;
  probe: string[];
  init?: string[];
  mount?: string;
}
interface IWorkflow {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      steps: { run?: string; if?: string; env?: Record<string, string> }[];
      services?: Record<string, { image: string }>;
    }
  >;
}

/** Reject unknown flags and shard names before starting any resources. */
export function parseOptions(args: readonly string[]): ILocalOptions {
  const options: ILocalOptions = { shards: [], keep: false };
  const extras: Shard[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--keep') options.keep = true;
    else if (flag === '--parallel') {
      const value = args[++i];
      if (value === undefined || !/^[1-5]$/.test(value))
        throw new Error(`Invalid --parallel: ${value} (expected 1-5)`);
      options.parallel = Number(value);
    } else if (flag === '--cpus') {
      const value = args[++i];
      if (
        value === undefined ||
        !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(value) ||
        value.split(',').some((range) => {
          const [start, end = start] = range.split('-').map(Number);
          return start! > end!;
        })
      )
        throw new Error(`Invalid --cpus: ${value}`);
      options.cpus = value;
    } else if (flag === '--shard' || flag === '--include') {
      const value = args[++i];
      if (flag === '--shard' && value === 'cli') {
        options.shards.push('cli-1', 'cli-2', 'cli-3');
        continue;
      }
      const allowed: readonly string[] =
        flag === '--shard' ? SHARDS : ['deno-lane', 'compat', 'node-build'];
      if (value === undefined || !allowed.includes(value))
        throw new Error(`Invalid ${flag}: ${value}`);
      (flag === '--shard' ? options.shards : extras).push(value as Shard);
    } else throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.shards.length === 0) options.shards.push(...SHARDS);
  options.shards = [...new Set([...options.shards, ...extras])];
  if (['cli-1', 'cli-2', 'cli-3'].every((shard) => options.shards.includes(shard as Shard)))
    options.shards.push('cli-coverage');
  return options;
}

/** Read CI's environment verbatim; no host environment can override a CI endpoint. */
export function ciEnvironment(source: string, shard: Shard = 'packages'): Record<string, string> {
  const workflow = parse(source) as IWorkflow;
  const job = (SHARDS as readonly string[]).includes(shard)
    ? 'node'
    : shard === 'compat'
      ? 'boundary-compatibility'
      : shard;
  return { ...workflow.jobs[job]!.env };
}

/** Read shard commands and step environments directly from the workflow. */
export function shardCommands(source: string, shard: Shard): ICommand[] {
  const workflow = parse(source) as IWorkflow;
  const job =
    workflow.jobs[
      shard === 'compat'
        ? 'boundary-compatibility'
        : shard === 'deno-lane' || shard === 'node-build' || shard === 'cli-coverage'
          ? shard
          : 'node'
    ]!;
  return job.steps
    .filter((step) => {
      if (step.run === undefined) return false;
      if ((SHARDS as readonly string[]).includes(shard))
        return step.if === `matrix.shard == '${shard}'`;
      return step.run !== 'corepack enable' && !step.run.startsWith('pnpm install');
    })
    .map((step) => ({ run: step.run!, env: { ...step.env } }));
}

/** CI's backend specifications, with host-port remaps translated to listeners. */
export function backendSpecs(shard: Shard): IBackend[] {
  const spec = (
    name: string,
    image: string,
    ports: number[],
    probe: string[],
    args: string[] = [],
    env: Record<string, string> = {},
    memory = '512m',
  ): IBackend => ({ name, image, ports, memory, args, env, probe });
  const redis = spec('redis', 'redis:7', [6379], ['redis-cli', 'ping']);
  if (shard === 'static') return [redis];
  if (
    shard === 'tooling' ||
    shard === 'deno-lane' ||
    shard === 'compat' ||
    shard === 'node-build' ||
    shard === 'cli-coverage'
  )
    return [];
  return [
    spec(
      'postgres',
      'postgres:16',
      [5433],
      ['pg_isready', '-U', 'postgres', '-p', '5433'],
      ['-c', 'port=5433'],
      { POSTGRES_PASSWORD: 'postgres' },
    ),
    spec(
      'mongo',
      'mongo:7',
      [27017],
      ['mongosh', '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok'],
    ),
    redis,
    spec(
      'elasticmq',
      'softwaremill/elasticmq-native:1.7.1',
      [9324, 9325],
      ['nc', '-z', 'localhost', '9324'],
    ),
    spec(
      'rabbitmq',
      'rabbitmq:4-management-alpine',
      [4369, 5672, 15672, 15692, 25672],
      // An immediate root probe can create a root-owned Erlang cookie before
      // the server does. CI's delayed healthcheck does not hit that startup race.
      ['su-exec', 'rabbitmq', 'rabbitmq-diagnostics', '-q', 'ping'],
      [],
      {},
      '1g',
    ),
    spec('mailpit', 'axllent/mailpit:v1.20.4', [1025, 8025], ['/mailpit', 'readyz']),
    spec(
      'dynamodb',
      'amazon/dynamodb-local:3.3.1',
      [8000],
      [
        'curl',
        '-sf',
        '-X',
        'POST',
        '-H',
        'X-Amz-Target: DynamoDB_20120810.ListTables',
        '-H',
        'Content-Type: application/x-amz-json-1.0',
        '-H',
        'Authorization: AWS4-HMAC-SHA256 Credential=ci/20260101/us-east-1/dynamodb/aws4_request',
        '-d',
        '{}',
        'http://localhost:8000/',
      ],
      [],
      {},
      '1g',
    ),
    {
      ...spec(
        'keycloak',
        'quay.io/keycloak/keycloak:26.4',
        [8180, 9100],
        ['@http', 'http://localhost:8180/realms/setu/.well-known/openid-configuration'],
        ['start-dev', '--import-realm', '--http-port=8180', '--http-management-port=9100'],
        { KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin' },
        '3g',
      ),
      mount: 'packages/auth-plugin/test/fixtures/keycloak:/opt/keycloak/data/import:ro',
    },
    spec(
      'bigtable',
      'gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators',
      [8086],
      ['bash', '-c', 'echo > /dev/tcp/127.0.0.1/8086'],
      ['gcloud', 'beta', 'emulators', 'bigtable', 'start', '--host-port=0.0.0.0:8086'],
      {},
      '1g',
    ),
    spec('nats', 'nats:2-alpine', [4222], ['nc', '-z', '127.0.0.1', '4222'], ['-js']),
    spec(
      'kafka',
      'apache/kafka:4.0.0',
      [9092, 9093],
      ['/opt/kafka/bin/kafka-broker-api-versions.sh', '--bootstrap-server', 'localhost:9092'],
      [],
      {},
      '1536m',
    ),
    {
      ...spec(
        'mongo-rs',
        'mongo:7',
        [27018],
        [
          'mongosh',
          '--port',
          '27018',
          '--quiet',
          '--eval',
          'if (!db.hello().isWritablePrimary) quit(1)',
        ],
        ['--replSet', 'rs0', '--port', '27018', '--bind_ip_all'],
        {},
        '1g',
      ),
      init: [
        'mongosh',
        '--port',
        '27018',
        '--quiet',
        '--eval',
        "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] })",
      ],
    },
    spec(
      'minio',
      'cgr.dev/chainguard/minio@sha256:bd014394a80898e68c149f2311fdf8d5a2c2f3bb2c33b9327ae6d02b4b065ae1',
      [9000],
      ['@http', 'http://localhost:9000/minio/health/ready'],
      ['server', '/data'],
      { MINIO_ROOT_USER: 'minioadmin', MINIO_ROOT_PASSWORD: 'minioadmin' },
    ),
  ];
}

/** Reject duplicate claimed ports before creating the shard's namespace. */
export function assertUniquePorts(specs: readonly IBackend[]): void {
  const owners = new Map<number, string>();
  for (const spec of specs)
    for (const port of spec.ports) {
      if (owners.has(port))
        throw new Error(`Port ${port} claimed by ${owners.get(port)} and ${spec.name}`);
      owners.set(port, spec.name);
    }
}

/** Names include the invocation id, so concurrent invocations cannot share a namespace. */
export function containerName(run: string, shard: Shard, role: string): string {
  return `setu-ci-${run}-${shard}-${role}`;
}

/**
 * The `setu.ci.shard` label value and the `SETU_CI_SHARD` the runner exports. It carries the
 * invocation id so an outage suite's lookup cannot match another invocation's backend, whether
 * from a concurrent run in another worktree or from a run killed before its cleanup.
 */
export function shardLabel(run: string, shard: Shard): string {
  return `${run}-${shard}`;
}

/** Shared resource limits and ownership labels; nothing publishes a host port. */
export function containerArgs(
  run: string,
  shard: Shard,
  role: string,
  memory: string,
  cpus?: string,
): string[] {
  return [
    'run',
    '-d',
    '--name',
    containerName(run, shard, role),
    '--label',
    `setu.ci.run=${run}`,
    '--label',
    `setu.ci.shard=${shardLabel(run, shard)}`,
    '--label',
    `setu.ci.role=${role}`,
    '--memory',
    memory,
    ...(cpus === undefined ? [] : ['--cpuset-cpus', cpus]),
  ];
}

/** Translate a backend spec into a Docker argv without invoking a shell. */
export function backendArgs(
  spec: IBackend,
  run: string,
  shard: Shard,
  root: string,
  cpus?: string,
): string[] {
  return [
    ...containerArgs(run, shard, spec.name, spec.memory, cpus),
    '--network',
    `container:${containerName(run, shard, 'net')}`,
    ...spec.ports.flatMap((port) => ['--label', `setu.ci.port.${port}=1`]),
    ...Object.entries(spec.env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
    ...(spec.mount === undefined ? [] : ['-v', `${root}/${spec.mount}`]),
    spec.image,
    ...spec.args,
  ];
}

/** Extract Vitest test totals once per member, ignoring suite/assertion output. */
export function parseSummary(log: string): {
  passed: number;
  skipped: number;
  failed: number;
  ignored: number;
} {
  const totals = { passed: 0, skipped: 0, failed: 0, ignored: 0 };
  const plain = stripVTControlCharacters(log);
  for (const line of plain.split('\n')) {
    if (!/^\s*Tests\s+/.test(line)) continue;
    for (const key of ['passed', 'skipped', 'failed', 'ignored'] as const) {
      totals[key] += Number(line.match(new RegExp(`(\\d+) ${key}`))?.[1] ?? 0);
    }
  }
  return totals;
}

/** Parse docker stats' memory units to bytes for per-shard peak totals. */
export function memoryBytes(value: string): number {
  const match = value.match(/^([\d.]+)(B|KiB|MiB|GiB)\s*\//);
  if (match === null) throw new Error(`Invalid docker memory sample: ${value}`);
  return Number(match[1]) * { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2]!]!;
}
