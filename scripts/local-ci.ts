/** Local Linux reproduction of CI's isolated, concurrent Node shards. */
/* eslint-disable no-console -- this developer runner streams progress and its evidence table. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { availableParallelism, freemem } from 'node:os';
import { run } from './lib/run.ts';
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
  runnerMemory,
  scheduleShards,
  SHARD_BUDGET_BYTES,
  shardCommands,
} from './lib/local-ci-plan.ts';
import type { IBackend, Shard } from './lib/local-ci-plan.ts';

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, '..');
  const image = 'setu-ci-runner:local';
  const id = randomUUID().slice(0, 8);
  const directory = resolve(root, '.tmp/local-ci', id);
  const options = parseOptions(process.argv.slice(2));
  const host = {
    platform: process.platform,
    dockerCli: false,
    dockerDaemon: false,
    freeMemory: availableMemory(await readFile('/proc/meminfo', 'utf8').catch(() => ''), freemem()),
    threads: availableParallelism(),
  };
  // Only read-only probes precede preflight. Refusals create no directories,
  // images, containers or signal/cleanup handlers (including on non-Linux).
  if (host.platform === 'linux') {
    host.dockerCli = await run('docker', ['--version'], { timeoutMs: 10_000 }).then(
      (result) => result.code === 0,
      () => false,
    );
    if (host.dockerCli)
      host.dockerDaemon = await run('docker', ['info'], { timeoutMs: 10_000 }).then(
        (result) => result.code === 0,
        () => false,
      );
  }
  const refusal = preflight(host, options.parallel);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }
  const parallel = chooseParallelism(host.freeMemory, host.threads, options.parallel);
  console.log(
    `Parallelism: ${parallel} (${options.parallel === undefined ? `automatic: ${SHARD_BUDGET_BYTES / 1024 ** 3} GiB and 2 threads per shard, maximum 5` : 'requested by --parallel'}; ${(host.freeMemory / 1024 ** 3).toFixed(2)} GiB available; ${host.threads} threads). CPU set: ${options.cpus ?? 'unrestricted'}.`,
  );
  const source = await readFile(resolve(root, '.github/workflows/ci.yml'), 'utf8');
  let interrupted = false;
  let sampling = true;
  const peaks = new Map<string, number>();
  let cleaning = Promise.resolve();
  const docker = (args: string[]) => run('docker', args, { cwd: root });

  async function owned(shard?: Shard): Promise<string[]> {
    const result = await docker([
      'ps',
      '-aq',
      '--filter',
      `label=setu.ci.run=${id}`,
      ...(shard === undefined ? [] : ['--filter', `label=setu.ci.shard=${shardLabel(id, shard)}`]),
    ]);
    if (result.code !== 0) throw new Error(result.stderr);
    return result.stdout.trim().split(/\s+/).filter(Boolean);
  }

  function cleanup(): Promise<void> {
    cleaning = cleaning.catch(() => {}).then(() => removeOwned());
    return cleaning;
  }

  async function removeOwned(shard?: Shard): Promise<void> {
    const containers = await owned(shard);
    if (containers.length > 0) {
      // Unpause before removal: outage tests may have left a paused backend.
      await docker(['unpause', ...containers]);
      const result = await docker(['rm', '-fv', ...containers]);
      if (result.code !== 0) throw new Error(`Cleanup failed: ${result.stderr}`);
    }
  }

  function onSignal(): void {
    interrupted = true;
    // Removing running containers ends docker wait; final cleanup also catches a
    // docker create already in flight when the signal arrived.
    void cleanup().catch((error: unknown) => console.error(error));
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  async function checked(args: string[]): Promise<string> {
    if (interrupted) throw new Error('Interrupted');
    const result = await docker(args);
    if (result.code !== 0) throw new Error(`docker ${args.join(' ')}: ${result.stderr}`);
    if (interrupted) throw new Error('Interrupted');
    return result.stdout.trim();
  }

  async function ready(name: string, probe: string[], net: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (interrupted) throw new Error('Interrupted');
      const args =
        probe[0] === '@http' ? ['exec', net, 'curl', '-fsS', probe[1]!] : ['exec', name, ...probe];
      const result = await docker(args);
      if (result.code === 0) return;
      const state = await docker(['inspect', '-f', '{{.State.Running}}', name]);
      if (state.stdout.trim() !== 'true') break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    const logs = await docker(['logs', name]);
    throw new Error(`${name} not ready\n${logs.stdout}${logs.stderr}`);
  }

  async function startBackend(
    spec: IBackend,
    shard: Shard,
    net: string,
    log: (text: string) => void,
  ): Promise<void> {
    const name = containerName(id, shard, spec.name);
    await checked(backendArgs(spec, id, shard, root, options.cpus));
    if (spec.init !== undefined) {
      await ready(
        name,
        ['mongosh', '--port', '27018', '--quiet', '--eval', 'db.runCommand({ ping: 1 }).ok'],
        net,
      );
      await checked(['exec', name, ...spec.init]);
    }
    await ready(name, spec.probe, net);
    // ss runs in the shared namespace; snapshots after EACH backend identify
    // listeners even when its image contains neither ss nor a shell.
    log(`\nLISTENERS after ${spec.name}\n${await checked(['exec', net, 'ss', '-ltn'])}\n`);
  }

  async function sample(): Promise<void> {
    const file = createWriteStream(resolve(directory, 'docker-stats.jsonl'));
    try {
      while (sampling) {
        const names = await docker(['ps', '-q', '--filter', `label=setu.ci.run=${id}`]);
        const ids = names.stdout.trim().split(/\s+/).filter(Boolean);
        if (ids.length > 0) {
          const result = await docker(['stats', '--no-stream', '--format', '{{json .}}', ...ids]);
          const totals = new Map<string, number>();
          for (const line of result.stdout.trim().split('\n').filter(Boolean)) {
            const row = JSON.parse(line) as { Name: string; MemUsage: string };
            file.write(`${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
            const shard = options.shards.find((shard) =>
              row.Name.startsWith(`setu-ci-${id}-${shard}-`),
            );
            if (shard !== undefined)
              totals.set(shard, (totals.get(shard) ?? 0) + memoryBytes(row.MemUsage));
          }
          for (const [shard, bytes] of totals)
            peaks.set(shard, Math.max(peaks.get(shard) ?? 0, bytes));
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      file.end();
    }
  }

  async function shardRun(shard: Shard, gitCommon: string) {
    const started = performance.now();
    console.log(`START ${shard} ${new Date().toISOString()}`);
    const path = resolve(directory, `${shard}.log`);
    const stream = createWriteStream(path);
    const log = (value: string) => {
      stream.write(value);
      process.stdout.write(`[${shard}] ${value}`);
    };
    let code = 1;
    try {
      const specs = backendSpecs(shard);
      assertUniquePorts(specs);
      const net = containerName(id, shard, 'net');
      await checked([
        ...containerArgs(id, shard, 'net', '512m', options.cpus),
        image,
        'sleep',
        'infinity',
      ]);
      for (const spec of specs) await startBackend(spec, shard, net, log);
      const scratch = resolve(directory, shard);
      await mkdir(resolve(scratch, 'tmp'), { recursive: true });
      await mkdir(resolve(scratch, 'home'), { recursive: true });
      // All CLI runners share only this invocation's blobs; logs stay outside it.
      const cliReports = shard.startsWith('cli-');
      const reports = resolve(directory, 'vitest-reports');
      if (cliReports) {
        await mkdir(reports, { recursive: true });
        // Create nested mount destinations as the host user, before Docker can
        // create root-owned directories inside the shared worktree mount.
        await mkdir(resolve(root, '.vitest-reports'), { recursive: true });
      }
      const socket = await stat('/var/run/docker.sock');
      const env = {
        ...ciEnvironment(source, shard),
        SETU_CI_SHARD: shardLabel(id, shard),
        CI: 'true',
        NODE_OPTIONS: '--max-old-space-size=4096',
        GITHUB_WORKSPACE: root,
        TMPDIR: '/tmp',
        DENO_DIR: resolve(scratch, 'deno'),
        BUN_INSTALL_CACHE_DIR: resolve(scratch, 'bun'),
        PNPM_HOME: '/usr/local/bin',
        HOME: resolve(scratch, 'home'),
      };
      const commands = shardCommands(source, shard)
        .map(
          (command) =>
            `env ${Object.entries(command.env)
              .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
              .join(' ')} bash -e -o pipefail -c '${command.run.replaceAll("'", "'\\''")}'`,
        )
        .join('\n');
      const name = containerName(id, shard, 'runner');
      await checked([
        ...containerArgs(id, shard, 'runner', runnerMemory(shard), options.cpus),
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--group-add',
        String(socket.gid),
        '--network',
        `container:${net}`,
        '-v',
        `${root}:${root}`,
        '-v',
        `${resolve(scratch, 'tmp')}:/tmp`,
        ...cliReportMounts(directory, root, shard),
        '-v',
        `${gitCommon}:${gitCommon}:ro`,
        '-v',
        '/var/run/docker.sock:/var/run/docker.sock',
        '-w',
        root,
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        image,
        'bash',
        '-e',
        '-o',
        'pipefail',
        '-c',
        `git config --global --add safe.directory '${root.replaceAll("'", "'\\''")}'\n${commands}`,
      ]);
      const follow = spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] });
      follow.stdout.on('data', (chunk: Buffer) => log(chunk.toString()));
      follow.stderr.on('data', (chunk: Buffer) => log(chunk.toString()));
      const followed = new Promise<void>((resolve, reject) => {
        follow.on('error', reject);
        follow.on('close', () => resolve());
      });
      const waited = await checked(['wait', name]);
      await followed;
      code = Number(waited);
      const state = await checked(['inspect', '-f', '{{json .State}}', name]);
      log(`\nRUNNER STATE ${state}\n`);
    } catch (error) {
      log(`\nERROR ${String(error)}\n`);
    } finally {
      await new Promise<void>((resolve) => stream.end(resolve));
      // Free this slot's backends as well as its runner before scheduling more.
      // --keep retains stopped containers, otherwise completed backends accumulate RAM.
      if (options.keep && !interrupted) {
        const containers = await owned(shard);
        if (containers.length > 0) {
          await docker(['unpause', ...containers]);
          await checked(['stop', ...containers]);
        }
      } else await removeOwned(shard);
      console.log(`END ${shard} code=${code} ${new Date().toISOString()}`);
    }
    return {
      shard,
      code,
      seconds: Math.round((performance.now() - started) / 1000),
      ...parseSummary(await readFile(path, 'utf8')),
      peakMiB: Math.round((peaks.get(shard) ?? 0) / 1024 ** 2),
    };
  }

  await mkdir(directory, { recursive: true });
  console.log(`Local CI run ${id}; logs: ${directory}`);
  let sampler: Promise<void> | undefined;
  let samplingError: unknown;
  try {
    await access(resolve(root, 'node_modules/.bin/vitest'));
    if ((await docker(['image', 'inspect', image])).code !== 0) {
      const build = await run('docker', ['build', '-t', image, 'docker/ci-runner'], {
        cwd: root,
        inherit: true,
      });
      if (build.code !== 0) throw new Error('Runner image build failed');
    }
    const git = await run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: root,
    });
    if (git.code !== 0) throw new Error(git.stderr);
    sampler = sample().catch((error: unknown) => {
      samplingError = error;
    });
    const results = await scheduleShards(options.shards, parallel, (shard) =>
      shardRun(shard, git.stdout.trim()),
    );
    console.table(results);
    await writeFile(resolve(directory, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
    process.exitCode = interrupted ? 130 : results.some((result) => result.code !== 0) ? 1 : 0;
  } catch (error) {
    console.error(error);
    process.exitCode = interrupted ? 130 : 1;
  } finally {
    sampling = false;
    await sampler;
    if (!options.keep || interrupted) await cleanup();
    else console.log(`Kept containers: docker ps -a --filter label=setu.ci.run=${id}`);
    if (samplingError !== undefined) {
      console.error(samplingError);
      process.exitCode = 1;
    }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

if (import.meta.main) await main();
