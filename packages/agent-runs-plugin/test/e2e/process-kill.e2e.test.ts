import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { agentRunPostgres } from '../../../database-plugin/test/fixtures/agent-run-postgres.ts';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
describe.skipIf(!process.env['AGENT_RUNS_PG_URL'])('process-kill recovery', () => {
  it('SIGKILL after committed model output resumes one model call and one effect', async () => {
    const h = await agentRunPostgres(process.env['AGENT_RUNS_PG_URL']!);
    const file = '.tmp/m136/process-worker.mjs';
    await mkdir('.tmp/m136', { recursive: true });
    let first: ReturnType<typeof spawn> | undefined;
    let second: ReturnType<typeof spawn> | undefined;
    try {
      await build({
        entryPoints: ['packages/agent-runs-plugin/test/fixtures/process-worker.ts'],
        outfile: file,
        bundle: true,
        platform: 'node',
        format: 'esm',
        plugins: [
          {
            name: 'source-workspace',
            setup(builder) {
              builder.onResolve({ filter: /^@setu-ts\// }, (args) => ({
                path: resolve('packages', args.path.slice('@setu-ts/'.length), 'src/index.ts'),
              }));
              builder.onResolve({ filter: /^[^./]/ }, async (args) => {
                if (args.pluginData === 'resolve-external') return;
                if (args.path.startsWith('node:')) return { path: args.path, external: true };
                const dependency = await builder.resolve(args.path, {
                  resolveDir: args.resolveDir,
                  kind: args.kind,
                  pluginData: 'resolve-external',
                });
                if (dependency.errors.length)
                  throw new Error('Cannot resolve process fixture dependency.');
                return { path: dependency.path, external: true };
              });
            },
          },
        ],
        tsconfig: 'tsconfig.check.json',
      });
      const env = { ...process.env, AGENT_RUNS_SCHEMA: h.namespace };
      first = spawn(process.execPath, [file, 'first'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise<void>((resolve) => first!.once('exit', () => resolve()));
      await new Promise<void>((resolve, reject) => {
        let output = '';
        first!.stderr!.on('data', (data) => {
          output += String(data);
        });
        first!.stdout!.on('data', (data) => {
          output += String(data);
          if (output.includes('COMMITTED')) resolve();
        });
        first!.once('error', reject);
        first!.once('exit', (code) => reject(new Error(`first exited ${code}: ${output}`)));
      });
      first.kill('SIGKILL');
      await exited;
      // Lease time is deliberately tiny; delay belongs to runtime services.
      await new Promise<void>((resolve) => createNodeRuntimeServices().setTimeout(resolve, 40));
      second = spawn(process.execPath, [file, 'second'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      second.stderr!.on('data', (data) => {
        stderr += String(data);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        second!.once('exit', resolve);
        second!.once('error', reject);
      });
      expect(code, stderr).toBe(0);
      expect(await h.database.getRepository('ModelCalls').count()).toBe(1);
      expect(await h.database.getRepository('Business').count()).toBe(1);
      expect(await h.database.getRepository('AgentRun').findOne()).toMatchObject({
        status: 'completed',
      });
    } finally {
      first?.kill('SIGKILL');
      second?.kill('SIGKILL');
      await h.dispose();
      await rm(file, { force: true });
    }
  }, 30000);
});
