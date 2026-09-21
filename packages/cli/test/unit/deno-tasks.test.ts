import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { devtoolTasks, projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { REST_TEMPLATE } from '../../src/templates/rest.ts';

describe('the generated Deno task set', () => {
  it('is byte-identical to the pre-devtool set for a project without the opt-in', () => {
    const host = resolveHost(REST_TEMPLATE, 'deno');
    const manifest = JSON.parse(
      projectFiles('probe', 'deno', host).find((file) => file.path === 'deno.json')!.contents,
    ) as { tasks: Record<string, string> };
    // `dev` and `check` are the devtool opt-in's tasks; without the flag a
    // project emits exactly what it always emitted. REST adds --allow-read and
    // --allow-sys of its own; the base grant leads, as always.
    expect(Object.keys(manifest.tasks)).toEqual(['start', 'test']);
    expect(manifest.tasks['start']).toMatch(/^deno run --allow-net --allow-env .* main\.ts$/);
    expect(manifest.tasks['check']).toBeUndefined();
  });

  it('differs from start only in the entry module, with no scoped --allow-net', () => {
    const host = resolveHost(REST_TEMPLATE, 'deno');
    const withDevtool = {
      ...host,
      extraTasks: { ...host.extraTasks, ...devtoolTasks(host.manifest) },
    };
    const manifest = JSON.parse(
      projectFiles('probe', 'deno', withDevtool).find((file) => file.path === 'deno.json')!
        .contents,
    ) as { tasks: Record<string, string> };

    const start = manifest.tasks['start'];
    const dev = manifest.tasks['dev'];
    expect(dev).toBe(start.replace(' main.ts', ' main.dev.ts'));
    expect(dev).not.toContain('--allow-net=');
    expect(start).not.toContain('--allow-net=');
  });

  it('names main.ts, setu.config.ts and main.dev.ts in the check task', () => {
    const tasks = devtoolTasks();
    expect(tasks['check']).toBe('deno check main.ts setu.config.ts main.dev.ts');
  });

  it('renders the same dev task string the enable command derives from start', () => {
    // The create-time renderer and `devtool enable`'s derivation must agree
    // byte-for-byte, or the two entry points would emit different projects.
    const host = resolveHost(MINIMAL_HOST, 'deno');
    const manifest = JSON.parse(
      projectFiles('probe', 'deno', host).find((file) => file.path === 'deno.json')!.contents,
    ) as { tasks: Record<string, string> };
    const derived = manifest.tasks['start'].replace(' main.ts', ' main.dev.ts');
    expect(devtoolTasks(host.manifest)['dev']).toBe(derived);
  });
});
