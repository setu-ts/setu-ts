import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  assertUniquePorts,
  availableMemory,
  backendArgs,
  backendSpecs,
  ciEnvironment,
  cliReportMounts,
  containerArgs,
  containerName,
  shardLabel,
  chooseParallelism,
  memoryBytes,
  parseOptions,
  parseSummary,
  preflight,
  scheduleShards,
  EXCLUSIVE_SHARDS,
  runnerMemory,
  SHARD_BUDGET_BYTES,
  NORMAL_GATES,
  SHARDS,
  shardCommands,
} from '../../scripts/lib/local-ci-plan.ts';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');

describe('local CI plan', () => {
  it('shares blobs only within the invocation and isolates each CLI coverage writer', () => {
    for (const shard of ['cli-1', 'cli-2', 'cli-3'] as const)
      expect(cliReportMounts('/work/.tmp/run', '/work', shard)).toEqual([
        '-v',
        '/work/.tmp/run/vitest-reports:/work/.vitest-reports',
      ]);
    expect(cliReportMounts('/work/.tmp/run', '/work', 'cli-coverage')).toEqual([
      '-v',
      '/work/.tmp/run/vitest-reports:/work/.vitest-reports',
    ]);
    expect(cliReportMounts('/work/.tmp/run', '/work', 'packages')).toEqual([]);
    expect(cliReportMounts('/work/.tmp/other', '/work', 'cli-coverage')[1]).not.toBe(
      cliReportMounts('/work/.tmp/run', '/work', 'cli-coverage')[1],
    );
  });
  it('sizes 16 GiB / 8-thread and 8 GiB / 4-thread hosts conservatively', () => {
    expect(chooseParallelism(16 * 1024 ** 3, 8)).toBe(2);
    expect(chooseParallelism(8 * 1024 ** 3, 4)).toBe(1);
    expect(chooseParallelism(64 * 1024 ** 3, 32)).toBe(5);
    expect(chooseParallelism(64 * 1024 ** 3, 4)).toBe(2);
    expect(chooseParallelism(64 * 1024 ** 3, 1)).toBe(1);
    expect(chooseParallelism(0, 1)).toBe(1); // preflight refuses before scheduling
    expect(chooseParallelism(64 * 1024 ** 3, 32, 2)).toBe(2);
    expect(availableMemory('MemTotal: 16 kB\nMemAvailable:     8192 kB\n', 123)).toBe(8192 * 1024);
    expect(availableMemory('', 123)).toBe(123);
  });

  it('refuses unsupported platforms, missing Docker and insufficient memory before starting', () => {
    const host = {
      platform: 'linux',
      dockerCli: true,
      dockerDaemon: true,
      freeMemory: SHARD_BUDGET_BYTES,
      threads: 4,
    };
    expect(preflight(host)).toBeUndefined();
    expect(preflight(host, 1)).toBeUndefined();
    for (const [change, reason] of [
      [{ platform: 'darwin' }, 'Linux is required'],
      [{ dockerCli: false }, 'Docker CLI is unavailable'],
      [{ dockerDaemon: false }, 'Docker daemon is unavailable'],
      [{ freeMemory: SHARD_BUDGET_BYTES - 1 }, 'below the 8 GiB budget'],
    ] as const) {
      const message = preflight({ ...host, ...change });
      expect(message).toContain(reason);
      expect(message).toContain(NORMAL_GATES);
      expect(message).not.toContain('\n');
    }
    expect(preflight(host, 2)).toContain('--parallel 2 requires 16 GiB');
  });

  it('honors concurrency limits and returns results in selection order', async () => {
    for (const parallel of [1, 2, 5]) {
      let active = 0;
      let peak = 0;
      const results = await scheduleShards(SHARDS, parallel, async (shard) => {
        peak = Math.max(peak, ++active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return shard;
      });
      expect(results).toEqual(SHARDS);
      expect(peak).toBe(parallel);
      expect(active).toBe(0);
    }
    expect(await scheduleShards([], 2, (shard) => Promise.resolve(shard))).toEqual([]);
    let completed = false;
    await expect(
      scheduleShards(['static', 'tooling'], 2, async (shard) => {
        if (shard === 'static') throw new Error('cleanup failed');
        await new Promise((resolve) => setTimeout(resolve, 10));
        completed = true;
        return shard;
      }),
    ).rejects.toThrow('cleanup failed');
    expect(completed).toBe(true);
  });

  it('runs node-build alone, after every other shard has finished', async () => {
    // node-build runs its own pnpm install and tsc -b on the shared worktree; beside a test
    // shard it deleted vitest under that shard (run f6b66a35).
    expect(EXCLUSIVE_SHARDS).toEqual(['cli-coverage', 'node-build']);
    const events: string[] = [];
    let active = 0;
    const results = await scheduleShards(
      ['node-build', 'static', 'cli-1', 'deno-lane'],
      5,
      async (shard) => {
        events.push(`start ${shard} active=${active}`);
        active++;
        await new Promise((resolve) => setTimeout(resolve, shard === 'cli-1' ? 20 : 5));
        active--;
        events.push(`end ${shard}`);
        return shard;
      },
    );
    expect(results).toEqual(['node-build', 'static', 'cli-1', 'deno-lane']);
    const start = events.indexOf('start node-build active=0');
    expect(start).toBe(events.length - 2);
    for (const shard of ['static', 'cli-1', 'deno-lane'])
      expect(events.indexOf(`end ${shard}`)).toBeLessThan(start);
    expect(await scheduleShards(['node-build'], 3, (shard) => Promise.resolve(shard))).toEqual([
      'node-build',
    ]);
  });

  it('does not start an exclusive shard when a shared shard failed', async () => {
    const started: string[] = [];
    await expect(
      scheduleShards(['static', 'node-build'], 2, (shard) => {
        started.push(shard);
        return shard === 'static'
          ? Promise.reject(new Error('cleanup failed'))
          : Promise.resolve(shard);
      }),
    ).rejects.toThrow('cleanup failed');
    expect(started).toEqual(['static']);
  });

  it('merges only after all three CLI shards finish, including failed shards', async () => {
    const finished: string[] = [];
    const results = await scheduleShards(
      ['cli-coverage', 'cli-1', 'cli-2', 'cli-3'],
      3,
      async (shard) => {
        if (shard === 'cli-coverage') expect(finished.sort()).toEqual(['cli-1', 'cli-2', 'cli-3']);
        else {
          await new Promise((resolve) => setTimeout(resolve, shard === 'cli-2' ? 20 : 5));
          finished.push(shard);
        }
        return { shard, code: shard === 'cli-2' ? 1 : 0 };
      },
    );
    expect(results[0]).toEqual({ shard: 'cli-coverage', code: 0 });
    expect(results[2]!.code).toBe(1);
  });

  it('keeps node-build last even when selected before the CLI merge', async () => {
    const started: string[] = [];
    await scheduleShards(['node-build', 'cli-coverage', 'cli-1'], 3, (shard) => {
      started.push(shard);
      return Promise.resolve();
    });
    expect(started).toEqual(['cli-1', 'cli-coverage', 'node-build']);
  });

  it('still runs an exclusive shard after a shared shard exits nonzero, as CI does', async () => {
    const started: string[] = [];
    const results = await scheduleShards(['static', 'node-build'], 2, (shard) => {
      started.push(shard);
      return Promise.resolve({ shard, code: shard === 'static' ? 1 : 0 });
    });
    expect(started).toEqual(['static', 'node-build']);
    expect(results).toEqual([
      { shard: 'static', code: 1 },
      { shard: 'node-build', code: 0 },
    ]);
  });

  it('gives the tooling runner 8 GiB and every other runner 6 GiB', () => {
    expect(runnerMemory('tooling')).toBe('8g');
    for (const shard of [
      'static',
      'cli-1',
      'messaging',
      'packages',
      'deno-lane',
      'compat',
      'node-build',
    ] as const)
      expect(runnerMemory(shard)).toBe('6g');
  });

  it('accepts explicit parallelism and CPU sets, refusing malformed options', () => {
    expect(parseOptions(['--parallel', '2', '--cpus', '0-3,6', '--shard', 'tooling'])).toEqual({
      shards: ['tooling'],
      keep: false,
      parallel: 2,
      cpus: '0-3,6',
    });
    expect(parseOptions(['--cpus', '0', '--parallel', '1']).cpus).toBe('0');
    for (const args of [
      ['--parallel'],
      ['--parallel', '0'],
      ['--parallel', '6'],
      ['--parallel', '1.5'],
      ['--cpus'],
      ['--cpus', 'no'],
      ['--cpus', '3-1'],
      ['--cpus', '0,,2'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });
  it('defaults to seven shards plus merge and expands the whole CLI alias', () => {
    expect(parseOptions([])).toEqual({ shards: [...SHARDS, 'cli-coverage'], keep: false });
    expect(
      parseOptions(['--shard', 'cli', '--shard', 'cli', '--include', 'compat', '--keep']),
    ).toEqual({ shards: ['cli-1', 'cli-2', 'cli-3', 'compat', 'cli-coverage'], keep: true });
    expect(parseOptions(['--include', 'compat']).shards).toEqual([
      ...SHARDS,
      'compat',
      'cli-coverage',
    ]);
    expect(parseOptions(['--shard', 'cli-2']).shards).toEqual(['cli-2']);
    for (const args of [
      ['--wat'],
      ['--shard'],
      ['--include'],
      ['--shard', 'compat'],
      ['--include', 'packages'],
    ])
      expect(() => parseOptions(args)).toThrow();
  });

  it('reads every CI environment value verbatim and ignores host variables', () => {
    expect(ciEnvironment(workflow)).toEqual({
      REDIS_URL: 'redis://localhost:6379',
      SQS_ENDPOINT_URL: 'http://localhost:9324',
      SQS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
      RABBITMQ_URL: 'amqp://localhost:5672',
      S3_ENDPOINT_URL: 'http://localhost:9000',
      S3_BUCKET: 'm70c-verify',
      S3_ACCESS_KEY_ID: 'minioadmin',
      S3_SECRET_ACCESS_KEY: 'minioadmin',
      SMTP_URL: 'smtp://localhost:1025',
      MONGODB_URI: 'mongodb://127.0.0.1:27017',
      DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000',
      DYNAMODB_ENDPOINT_URL: 'http://127.0.0.1:8000',
      BIGTABLE_EMULATOR_ENDPOINT: '127.0.0.1:8086',
      KEYCLOAK_URL: 'http://localhost:8180',
      NATS_URL: 'nats://127.0.0.1:4222',
      KAFKA_BROKERS: '127.0.0.1:9092',
      OUTBOX_POSTGRES_URL: 'postgres://postgres:postgres@127.0.0.1:5433/postgres',
      MONGODB_RS_URI: 'mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true',
    });
    expect(ciEnvironment('jobs: {node: {env: {REDIS_URL: changed}, steps: []}}')).toEqual({
      REDIS_URL: 'changed',
    });
    for (const shard of SHARDS)
      expect(ciEnvironment(workflow, shard)).toEqual(ciEnvironment(workflow));
    for (const shard of ['compat', 'deno-lane', 'node-build', 'cli-coverage'] as const)
      expect(ciEnvironment(workflow, shard)).toEqual({});
  });

  it('mirrors all seven shards and optional job commands, including step environments', () => {
    expect(shardCommands(workflow, 'static')).toEqual([
      { run: 'pnpm run fmt:check', env: {} },
      { run: 'pnpm run lint', env: {} },
      { run: 'pnpm run check', env: {} },
      { run: 'pnpm run check:docs', env: {} },
      {
        run: 'pnpm run check:apps\ngit diff --exit-code -- apps\n',
        env: { ALLOW_SKIP: 'cloudflare' },
      },
      { run: 'node scripts/codemods/std-to-vitest.ts --check', env: {} },
    ]);
    for (const [index, shard] of ['cli-1', 'cli-2', 'cli-3'].entries())
      expect(shardCommands(workflow, shard as 'cli-1' | 'cli-2' | 'cli-3')).toEqual([
        { run: `pnpm test:coverage --no-tooling cli --shard ${index + 1}/3`, env: {} },
      ]);
    expect(shardCommands(workflow, 'cli-coverage')).toEqual([
      {
        run: 'for i in 1 2 3; do\n  test -f ".vitest-reports/cli/blob-$i.json"\ndone\npnpm test:coverage --no-tooling cli --merge\n',
        env: {},
      },
    ]);
    expect(shardCommands(workflow, 'messaging')).toEqual([
      { run: 'pnpm test:coverage --no-tooling messaging-plugin', env: {} },
    ]);
    expect(shardCommands(workflow, 'packages')).toEqual([
      { run: 'pnpm test:coverage --no-tooling --skip cli --skip messaging-plugin', env: {} },
    ]);
    expect(shardCommands(workflow, 'tooling')).toEqual([
      { run: 'pnpm run test:tooling:coverage', env: {} },
    ]);
    expect(shardCommands(workflow, 'deno-lane')).toEqual([
      { run: 'pnpm run test:deno-lane', env: {} },
    ]);
    expect(shardCommands(workflow, 'compat')).toEqual([{ run: 'pnpm run check:compat', env: {} }]);
    expect(shardCommands(workflow, 'node-build')).toEqual([
      { run: 'node scripts/node-manifests.ts --check', env: {} },
      { run: 'pnpm run check:node-build --require-all', env: {} },
    ]);
    expect(
      shardCommands(workflow.replace('pnpm run lint', 'pnpm run lint:new'), 'static')[1]!.run,
    ).toBe('pnpm run lint:new');
  });

  it('uses the complete source inventory with collision-free listeners and conservative caps', () => {
    const ci = parse(workflow) as {
      jobs: {
        node: {
          services: Record<string, { image: string }>;
          strategy: { matrix: { shard: string[] } };
          steps: { run?: string }[];
        };
      };
    };
    const full = backendSpecs('packages');
    expect(ci.jobs.node.strategy.matrix.shard).toEqual([...SHARDS]);
    expect(ci.jobs.node.steps.filter((step) => step.run?.includes('docker run '))).toHaveLength(
      full.length - Object.keys(ci.jobs.node.services).length,
    );
    expect(full).toHaveLength(13);
    expect(backendSpecs('cli-1')).toEqual(full);
    expect(backendSpecs('messaging')).toEqual(full);
    for (const [name, service] of Object.entries(ci.jobs.node.services))
      expect(full.find((spec) => spec.name === name)?.image).toBe(service.image);
    for (const name of ['keycloak', 'bigtable', 'nats', 'kafka', 'mongo-rs', 'minio'])
      expect(workflow).toContain(full.find((spec) => spec.name === name)!.image);
    for (const shard of [...SHARDS, 'compat', 'deno-lane', 'node-build'] as const)
      expect(() => assertUniquePorts(backendSpecs(shard))).not.toThrow();
    expect(backendSpecs('static').map((spec) => spec.name)).toEqual(['redis']);
    for (const shard of ['tooling', 'compat', 'deno-lane', 'node-build', 'cli-coverage'] as const)
      expect(backendSpecs(shard)).toEqual([]);
    expect(full.find((spec) => spec.name === 'keycloak')!.args).toContain(
      '--http-management-port=9100',
    );
    expect(full.find((spec) => spec.name === 'postgres')!.args).toEqual(['-c', 'port=5433']);
    expect(() => assertUniquePorts([full[0]!, { ...full[1]!, ports: [5433] }])).toThrow(
      'Port 5433 claimed by postgres and mongo',
    );
  });

  it('labels every served port, joins only its own namespace, and publishes nothing', () => {
    expect(containerName('one', 'cli-1', 'net')).toBe('setu-ci-one-cli-1-net');
    expect(shardLabel('one', 'cli-1')).toBe('one-cli-1');
    expect(shardLabel('two', 'cli-1')).not.toBe(shardLabel('one', 'cli-1'));
    expect(containerArgs('one', 'cli-1', 'runner', '6g')).toEqual([
      'run',
      '-d',
      '--name',
      'setu-ci-one-cli-1-runner',
      '--label',
      'setu.ci.run=one',
      '--label',
      'setu.ci.shard=one-cli-1',
      '--label',
      'setu.ci.role=runner',
      '--memory',
      '6g',
    ]);
    expect(containerArgs('one', 'cli-1', 'runner', '6g', '0-3,6').slice(-2)).toEqual([
      '--cpuset-cpus',
      '0-3,6',
    ]);
    for (const spec of backendSpecs('packages')) {
      const args = backendArgs(spec, 'one', 'packages', '/work');
      expect(args).not.toContain('--cpuset-cpus');
      expect(backendArgs(spec, 'one', 'packages', '/work', '0-1')).toContain('0-1');
      expect(args).toContain('container:setu-ci-one-packages-net');
      for (const port of spec.ports) expect(args).toContain(`setu.ci.port.${port}=1`);
      for (const [key, value] of Object.entries(spec.env))
        expect(args).toContain(`${key}=${value}`);
      expect(args).not.toContain('-p');
      expect(args).not.toContain('--publish');
      expect(args).toContain(spec.memory);
      expect(args.slice(args.indexOf(spec.image) + 1)).toEqual(spec.args);
      if (spec.mount) expect(args).toContain(`/work/${spec.mount}`);
      else expect(args).not.toContain('-v');
    }
    expect(backendArgs(backendSpecs('static')[0]!, 'two', 'static', '/work')).toContain(
      'container:setu-ci-two-static-net',
    );
  });

  it('adds member summaries without counting suite totals or assertion messages', () => {
    expect(parseSummary('')).toEqual({ passed: 0, skipped: 0, failed: 0, ignored: 0 });
    expect(
      parseSummary(
        '\u001b[32m Tests 25 passed | 2 skipped (27)\u001b[0m\nTest Files 8 passed\n Tests 1 failed | 3 passed | 4 ignored (8)\nassert 100 passed',
      ),
    ).toEqual({ passed: 28, skipped: 2, failed: 1, ignored: 4 });
  });

  it('converts docker stats units and refuses malformed samples', () => {
    for (const [unit, factor] of [
      ['B', 1],
      ['KiB', 1024],
      ['MiB', 1024 ** 2],
      ['GiB', 1024 ** 3],
    ] as const)
      expect(memoryBytes(`1.5${unit} / 6GiB`)).toBe(1.5 * factor);
    expect(() => memoryBytes('bad')).toThrow('Invalid docker memory sample');
  });
});
