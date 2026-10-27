import { expect, it } from 'vitest';
import { TARGET_RUNTIMES, VERSION } from '../../src/constants.ts';
import {
  cliCheckCommand,
  devtoolTasks,
  projectFiles,
  resolveHost,
} from '../../src/templates/project-files.ts';
import { listTemplates } from '../../src/templates/registry.ts';
import { MINIMAL_HOST } from '../../src/templates/minimal.ts';

it('pins and invokes the CLI in every runtime and template check script', () => {
  for (const runtime of TARGET_RUNTIMES) {
    for (const template of [MINIMAL_HOST, ...listTemplates()]) {
      const host = resolveHost(template, runtime);
      const files = projectFiles('probe', runtime, host);
      if (runtime === 'deno') {
        const manifest = JSON.parse(files.find((file) => file.path === 'deno.json')!.contents) as {
          tasks: Record<string, string>;
        };
        expect(manifest.tasks.check).toBe(
          `${host.manifest?.npmBuild === undefined ? '' : 'deno task build && '}deno check main.ts setu.config.ts && deno run -A npm:@setu-ts/cli@^${VERSION} check`,
        );
      } else {
        const manifest = JSON.parse(
          files.find((file) => file.path === 'package.json')!.contents,
        ) as { scripts: Record<string, string>; devDependencies: Record<string, string> };
        expect(manifest.devDependencies['@setu-ts/cli']).toBe(`^${VERSION}`);
        expect(manifest.scripts.check).toBe(
          `${host.manifest?.npmBuild === undefined ? '' : runtime === 'cloudflare-workers' ? 'npm run build && ' : 'react-router build && '}tsc --noEmit && setu check`,
        );
        if (runtime === 'cloudflare-workers')
          expect(
            JSON.parse(files.find((file) => file.path === 'deno.json')!.contents).tasks.check,
          ).toBeUndefined();
      }
    }
  }
  expect(cliCheckCommand('node')).toBe('setu check');
  expect(devtoolTasks().check).toBe(
    `deno check main.ts setu.config.ts main.dev.ts && ${cliCheckCommand('deno')}`,
  );
});
