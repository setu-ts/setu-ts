/**
 * The drift gate: scaffolds each template into a REAL temp directory, generates
 * over the §6.1 hostile name set, and runs `deno check` on the result against
 * the real published packages.
 *
 * A gate that exercises one input proves one input — M34's version ran only
 * `order-item` and still shipped `(class) => {` and `class 2faService`, both
 * unparseable.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@hono-enterprise/runtime';
import type { IFileSystem } from '@hono-enterprise/common';
import { runCli } from '../../src/cli.ts';
import { listTemplates } from '../../src/templates/registry.ts';

const runtime = createDenoRuntimeServices();
const fs: IFileSystem = runtime.fs!;

/**
 * Names generation must survive. Each entry names the defect it guards.
 */
const HOSTILE_NAMES: readonly { readonly name: string; readonly accepted: boolean }[] = [
  { name: 'order-item', accepted: true }, // the ordinary multi-word path
  { name: 'class', accepted: true }, // reserved word — M34 emitted `(class) => {`
  { name: 'new', accepted: true }, // reserved word that is also a CLI verb
  { name: 'API', accepted: true }, // all-caps segment → Pascal `Api`
  { name: 'oauth2-client', accepted: true }, // digits inside a word
  { name: 'user', accepted: true }, // single word
  { name: '2fa', accepted: false }, // digit-leading — refused, never emitted
];

/**
 * Schematics that need no plugin installed, so the hostile-name sweep runs
 * against a bare project. `controller` is absent: it is gated on
 * `decorator-plugin`, and is covered by the rest-template check below.
 */
const UNGATED = ['plugin', 'service', 'route', 'middleware', 'job'] as const;

/** Every schematic the `rest` template's plugin set makes available. */
const REST_AVAILABLE = [...UNGATED, 'controller'] as const;

/**
 * Runs `deno check` over a scaffolded project.
 *
 * `--min-dep-age 0` is required: JSR refuses versions younger than a day by
 * default, which would fail the gate for reasons unrelated to drift.
 *
 * @param root - The project directory
 * @param files - Files to check
 * @returns The process result
 */
async function denoCheck(root: string, files: readonly string[]) {
  const command = new Deno.Command(Deno.execPath(), {
    args: ['check', '--min-dep-age', '0', '--config', `${root}/deno.json`, ...files],
    stdout: 'piped',
    stderr: 'piped',
  });
  const { code, stderr } = await command.output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

describe('template scaffolding — end to end', () => {
  let root: string;
  let out: string[];
  let err: string[];

  const run = (argv: readonly string[]) =>
    runCli(argv, {
      fs,
      cwd: root,
      now: () => runtime.now(),
      log: (m) => out.push(m),
      error: (m) => err.push(m),
    });

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: 'honoe-tpl-' });
    out = [];
    err = [];
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  for (const template of listTemplates()) {
    it(`scaffolds a ${template.name} project whose files exist on disk`, async () => {
      expect(await run(['new', 'svc', '--template', template.name])).toBe(0);
      for (const name of ['deno.json', 'main.ts', 'honoe.config.ts', 'README.md']) {
        expect((await Deno.stat(`${root}/svc/${name}`)).isFile).toBe(true);
      }
    });

    it(`emits a ${template.name} config declaring every plugin in the manifest`, async () => {
      await run(['new', 'svc', '--template', template.name]);
      const config = await Deno.readTextFile(`${root}/svc/honoe.config.ts`);
      const manifest = JSON.parse(await Deno.readTextFile(`${root}/svc/deno.json`));
      for (const match of config.matchAll(/from '(@hono-enterprise\/[a-z-]+)'/g)) {
        expect(Object.keys(manifest.imports)).toContain(match[1]);
      }
    });
  }

  it('refuses a controller in a project without the decorator plugin', async () => {
    // Regression: the schematic emits @Controller/@Get/@Post, so an ungated
    // generate produced source whose own import could not resolve.
    await run(['new', 'bare']);
    expect(await run(['g', 'controller', 'user', '--dir', `${root}/bare`])).toBe(1);
    expect(err.join('\n')).toContain('@hono-enterprise/decorator-plugin');
  });

  it('allows a controller once the rest template installs the decorator plugin', async () => {
    await run(['new', 'svc', '--template', 'rest']);
    expect(await run(['g', 'controller', 'user', '--dir', `${root}/svc`])).toBe(0);
  });

  describe('the hostile name set', () => {
    for (const { name, accepted } of HOSTILE_NAMES) {
      it(`${accepted ? 'generates' : 'refuses'} the name "${name}"`, async () => {
        await run(['new', 'svc']);
        const project = `${root}/svc`;
        for (const schematic of UNGATED) {
          const code = await run(['g', schematic, name, '--dir', project]);
          expect(code).toBe(accepted ? 0 : 2);
        }
      });
    }

    it('never writes a file for a refused name', async () => {
      await run(['new', 'svc']);
      const project = `${root}/svc`;
      expect(await run(['g', 'service', '2fa', '--dir', project])).toBe(2);
      await expect(Deno.stat(`${project}/src/services`)).rejects.toThrow();
    });
  });

  it('type-checks a scaffolded project generated over every accepted name', async () => {
    expect(await run(['new', 'svc', '--template', 'rest'])).toBe(0);
    const project = `${root}/svc`;

    for (const { name, accepted } of HOSTILE_NAMES) {
      if (!accepted) continue;
      for (const schematic of REST_AVAILABLE) {
        expect(await run(['g', schematic, name, '--dir', project])).toBe(0);
      }
    }

    const sources: string[] = [`${project}/main.ts`, `${project}/honoe.config.ts`];
    for await (const entry of Deno.readDir(`${project}/src`)) {
      for await (const file of Deno.readDir(`${project}/src/${entry.name}`)) {
        sources.push(`${project}/src/${entry.name}/${file.name}`);
      }
    }
    // 6 schematics × 6 accepted names, plus the two entry files.
    expect(sources.length).toBe(REST_AVAILABLE.length * 6 + 2);

    const { code, stderr } = await denoCheck(project, sources);
    expect(stderr).not.toContain('SyntaxError');
    expect(code).toBe(0);
  });
});
