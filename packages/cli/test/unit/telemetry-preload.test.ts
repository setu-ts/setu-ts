/**
 * The OpenTelemetry preload a generated Node project starts with (M131a X88-4).
 *
 * Node projects carry `instrumentation.mjs` and run it with `--import` in every
 * start script and in the production image, ahead of the application, so the
 * ESM loader hook is registered before a plugin's lazy driver import. Deno and
 * Bun carry neither. The generated preload must also start cleanly when
 * `@opentelemetry/instrumentation` is not installed, which is what lets every
 * Node project carry it.
 *
 * @module
 */
import { execFile } from 'node:child_process';
import * as nodeFs from 'node:fs/promises';
import * as nodeOs from 'node:os';
import * as nodePath from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';
import {
  TELEMETRY_PRELOAD_CONTENTS,
  TELEMETRY_PRELOAD_FLAG,
  TELEMETRY_PRELOAD_PATH,
} from '../../src/templates/telemetry-preload.ts';

const run = promisify(execFile);

function harness() {
  const fs = createFakeFs();
  return {
    fs,
    run: (args: readonly string[]) =>
      runCli(args, { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} }),
    exists: (path: string): boolean => {
      try {
        fs.read(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function scripts(h: ReturnType<typeof harness>, path: string): Record<string, string> {
  return (JSON.parse(h.fs.read(path)) as { scripts: Record<string, string> }).scripts;
}

describe('the OpenTelemetry preload (M131a X88-4)', () => {
  it('a Node project carries the preload and runs it before the application', async () => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'microservice', '--runtime', 'node'])).toBe(0);
    expect(h.fs.read(`/work/svc/${TELEMETRY_PRELOAD_PATH}`)).toBe(TELEMETRY_PRELOAD_CONTENTS);
    const s = scripts(h, '/work/svc/package.json');
    expect(s['start']).toBe(
      `node ${TELEMETRY_PRELOAD_FLAG} --env-file-if-exists=.env --enable-source-maps dist/main.js`,
    );
    expect(s['start:dev']).toBe(
      `tsx watch ${TELEMETRY_PRELOAD_FLAG} --env-file-if-exists=.env main.ts`,
    );
    expect(s['start:debug']).toBe(
      `node ${TELEMETRY_PRELOAD_FLAG} --env-file-if-exists=.env --inspect --import tsx main.ts`,
    );
    const dockerfile = h.fs.read('/work/svc/Dockerfile');
    expect(dockerfile).toContain(`COPY --from=build /srv/${TELEMETRY_PRELOAD_PATH} ./`);
    expect(dockerfile).toContain(
      `CMD ["node", "--import", "./${TELEMETRY_PRELOAD_PATH}", "--enable-source-maps", "dist/main.js"]`,
    );
  });

  it('a workspace member image copies the member preload', async () => {
    const h = harness();
    expect(await h.run(['new', 'ws', '--workspace', '--runtime', 'node'])).toBe(0);
    expect(await h.run(['generate', 'app', 'svc', '--dir', '/work/ws'])).toBe(0);
    expect(h.exists(`/work/ws/apps/svc/${TELEMETRY_PRELOAD_PATH}`)).toBe(true);
    const dockerfile = h.fs.read('/work/ws/docker/Dockerfile');
    expect(dockerfile).toContain(
      `COPY --from=build /srv/apps/\${MEMBER}/${TELEMETRY_PRELOAD_PATH} ./`,
    );
    expect(dockerfile).toContain(`"--import", "./${TELEMETRY_PRELOAD_PATH}"`);
  });

  it.each(['bun', 'deno'] as const)('a %s project carries neither file nor flag', async (rt) => {
    const h = harness();
    expect(await h.run(['new', 'svc', '--template', 'microservice', '--runtime', rt])).toBe(0);
    expect(h.exists(`/work/svc/${TELEMETRY_PRELOAD_PATH}`)).toBe(false);
    const manifest = h.fs.read(`/work/svc/${rt === 'deno' ? 'deno.json' : 'package.json'}`);
    expect(manifest).not.toContain(TELEMETRY_PRELOAD_PATH);
  });

  it('the generated preload starts cleanly without the instrumentation package', async () => {
    const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'setu-preload-'));
    try {
      await nodeFs.writeFile(
        nodePath.join(dir, TELEMETRY_PRELOAD_PATH),
        TELEMETRY_PRELOAD_CONTENTS,
      );
      await nodeFs.writeFile(nodePath.join(dir, 'main.mjs'), "console.log('started');\n");
      const { stdout } = await run(
        process.execPath,
        ['--import', `./${TELEMETRY_PRELOAD_PATH}`, 'main.mjs'],
        { cwd: dir },
      );
      expect(stdout.trim()).toBe('started');
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });
});
