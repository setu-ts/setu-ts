import { expect, it } from 'vitest';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';
import { CLASS_BASED_TEMPLATE } from '../../src/templates/class-based.ts';
import { MICROSERVICE_TEMPLATE } from '../../src/templates/microservice.ts';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';

for (const host of [
  MINIMAL_HOST,
  REST_TEMPLATE,
  CLASS_BASED_TEMPLATE,
  MICROSERVICE_TEMPLATE,
  FULL_STACK_TEMPLATE,
]) {
  for (const runtime of ['node', 'bun', 'deno'] as const) {
    it(`renders production and development scripts for ${'name' in host ? host.name : 'minimal'}/${runtime}`, () => {
      const files = projectFiles('probe', runtime, resolveHost(host, runtime));
      const full = host === FULL_STACK_TEMPLATE;
      const manifest = JSON.parse(
        files.find((file) => file.path === (runtime === 'deno' ? 'deno.json' : 'package.json'))!
          .contents,
      ) as {
        scripts?: Record<string, string>;
        tasks?: Record<string, string>;
      };
      const scripts = manifest.scripts ?? manifest.tasks!;
      if (runtime === 'node') {
        expect(scripts['build']).toBe(
          `${full ? 'react-router build && ' : ''}tsc --noEmit && setu build`,
        );
        expect(scripts['start']).toBe('node --enable-source-maps dist/main.js');
        expect(scripts['start:dev']).toBe(full ? 'tsx dev.ts' : 'tsx watch main.ts');
        expect(scripts['start:debug']).toBe(
          `node --inspect --import tsx ${full ? 'dev.ts' : 'main.ts'}`,
        );
        expect(files.find((file) => file.path === '.gitignore')!.contents).toContain('dist/');
      } else if (runtime === 'bun') {
        expect(scripts['start']).toBe('bun run main.ts');
        expect(scripts['start:dev']).toBe(full ? 'bun run dev.ts' : 'bun --watch main.ts');
        expect(scripts['start:debug']).toBe(`bun --inspect ${full ? 'dev.ts' : 'main.ts'}`);
        expect(scripts['build']).toBe(full ? 'react-router build' : undefined);
      } else {
        for (const flag of ['watch', 'inspect']) {
          const command = scripts[flag === 'watch' ? 'start:dev' : 'start:debug'];
          expect(command).toBe(
            full
              ? `deno task install && deno run -A --${flag} dev.ts`
              : scripts['start']!.replace('deno run ', `deno run --${flag} `),
          );
        }
        if (full) expect(scripts['check']).toMatch(/^deno task build && deno check main.ts/);
      }
      if (runtime !== 'deno') {
        expect(scripts['dev']).toBeUndefined();
        if (full) {
          expect(scripts['test']).toMatch(/^react-router build && /);
          expect(scripts['test']).not.toContain('setu build');
          expect(scripts['check']).toBe('react-router build && tsc --noEmit && setu check');
        }
      }
      const docker = files.find((file) => file.path === 'Dockerfile')!.contents;
      expect(docker).not.toMatch(/^ARG MEMBER/m);
      expect(docker).toContain('USER 1000:1000');
      if (runtime === 'node') {
        expect(docker.match(/^FROM /gm)).toHaveLength(2);
        expect(docker).toContain('npm ci --omit=dev');
        expect(docker).toContain('COPY --from=build /srv/buil[d] ./build/');
      }
      if (runtime === 'deno') {
        // §3.7/§3.15: the glibc frontend stage at the project root, and the
        // post-install switch of an "auto" node_modules root to "manual".
        expect(docker).toContain('FROM denoland/deno:debian-2.9.5 AS frontend');
        expect(docker).toContain('COPY --from=frontend /srv/buil[d] ./build/');
        const instructions = docker.split('\n').filter((line) => !line.startsWith('#'));
        expect(instructions.join('\n')).not.toContain('apps/');
        expect(docker).toContain('manifest.nodeModulesDir = "manual"');
      }
      const ignored = files.find((file) => file.path === '.dockerignore')!.contents;
      for (const pattern of [
        'node_modules',
        '**/dist',
        '**/build',
        'coverage',
        '.git',
        '**/.env',
        '**/.env.*',
        '!**/.env.example',
        '**/.npmrc',
      ])
        expect(ignored).toContain(pattern);
    });
  }
}

it('keeps a single full-stack socket entry and leaves Workers deployment with Wrangler', () => {
  const entries = ['node', 'bun', 'deno'].map((runtime) => {
    const target = runtime as 'node' | 'bun' | 'deno';
    return projectFiles('probe', target, resolveHost(FULL_STACK_TEMPLATE, target)).find(
      (file) => file.path === 'main.ts',
    )!.contents;
  });
  expect(new Set(entries).size).toBe(1);
  expect(entries[0]).toContain('createApp(undefined, undefined, { serverBuild })');
  const worker = projectFiles(
    'probe',
    'cloudflare-workers',
    resolveHost(REST_TEMPLATE, 'cloudflare-workers'),
  );
  expect(worker.some((file) => ['Dockerfile', '.dockerignore'].includes(file.path))).toBe(false);
});
