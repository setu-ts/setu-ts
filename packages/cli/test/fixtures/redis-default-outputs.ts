import { runCli } from '../../src/cli.ts';
import { createFakeFs } from './fake-fs.ts';

/** Redis scaffolds captured from develop before the M117 CLI changes. */
export async function redisDefaultOutputs(): Promise<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const runtime of ['deno', 'node', 'bun']) {
    for (const flags of [
      ['--broker', 'redis'],
      ['--queue', 'redis'],
      ['--workspace', '--transport', 'redis'],
    ]) {
      const fs = createFakeFs();
      const run = (args: readonly string[]) =>
        runCli(args, {
          fs,
          cwd: '/work',
          now: () => 0,
          log: () => {},
          error: (line) => {
            throw new Error(line);
          },
        });
      const workspace = flags.includes('--workspace');
      await run([
        'new',
        'app',
        '--runtime',
        runtime,
        ...flags,
        ...(workspace ? [] : ['--template', 'microservice']),
      ]);
      if (workspace)
        await run(['generate', 'app', 'svc', '--template', 'microservice', '--dir', '/work/app']);
      const prefix = `${runtime}/${flags[0]}`;
      for (const path of new Set(fs.writes)) outputs[`${prefix}${path}`] = fs.read(path);
    }
    for (const [plugin, flag] of [
      ['messaging', '--broker'],
      ['queue', '--queue'],
    ]) {
      const fs = createFakeFs();
      const run = (args: readonly string[]) =>
        runCli(args, {
          fs,
          cwd: '/work',
          now: () => 0,
          log: () => {},
          error: (line) => {
            throw new Error(line);
          },
        });
      await run(['new', 'app', '--runtime', runtime, '--template', 'rest']);
      await run(['add', plugin!, flag!, 'redis', '--dir', '/work/app']);
      for (const path of new Set(fs.writes))
        outputs[`${runtime}/add-${plugin}${path}`] = fs.read(path);
    }
  }
  return outputs;
}
