import { describe, expect, it, vi } from 'vitest';
import type { IOpenApiService, IServiceRegistry } from '@setu-ts/common';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import { parseArgs } from '../../src/args.ts';
import { runCli } from '../../src/cli.ts';
import { runClientCommand } from '../../src/commands/client.ts';
import { CLIENT_MARKER, generateClientFile } from '../../src/client/generate.ts';
import type { ClientPackageLoader } from '../../src/client/generate.ts';
import { createFakeApp } from '../fixtures/fake-app.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';

const OUTPUT = '/app/src/clientsdk/api.ts';
const DOCUMENT = { openapi: '3.1.0', paths: {} };
const SOURCE = 'export interface Api {}\n';
const TEXT = `${CLIENT_MARKER}\n/* eslint-disable */\n${SOURCE}`;
const missing = (specifier = '@setu-ts/sdk') =>
  Object.assign(new Error(`Cannot find package '${specifier}' imported from /app/package.json`), {
    code: 'ERR_MODULE_NOT_FOUND',
  });

function harness(seed: Readonly<Record<string, string>> = {}, load?: ClientPackageLoader) {
  const fs = createFakeFs({ '/app/package.json': '{}', ...seed });
  const out: string[] = [];
  const err: string[] = [];
  const app = createFakeApp();
  const service: IOpenApiService = { getSpec: vi.fn(() => DOCUMENT), addSchema: () => {} };
  const services = { has: () => true, get: () => service } as unknown as IServiceRegistry;
  const start = vi.fn(app.start);
  const stop = vi.fn(app.stop);
  const loadApp = vi.fn((_url: string, _root?: string) =>
    Promise.resolve().then(() => ({
      createApp: () => Object.assign(Object.create(app) as typeof app, { services, start, stop }),
    })),
  );
  const generate = vi.fn(() => SOURCE);
  const prettier = {
    resolveConfigFile: vi.fn(() => Promise.resolve().then(() => '/app/.prettierrc.json')),
    resolveConfig: vi.fn(() => Promise.resolve().then(() => ({ semi: false }))),
    format: vi.fn((text: string) => Promise.resolve().then(() => text)),
  };
  const importFromProject = vi.fn(
    load ??
      ((name: string) =>
        Promise.resolve().then(() =>
          name === '@setu-ts/sdk' ? { generateOpenApiClient: generate } : prettier,
        )),
  );
  const deps = {
    fs,
    cwd: '/app',
    log: (s: string) => out.push(s),
    error: (s: string) => err.push(s),
    loadApp,
    importFromProject,
  };
  return {
    ...deps,
    out,
    err,
    app,
    service,
    services,
    start,
    stop,
    generate,
    prettier,
    run: (argv: readonly string[] = []) => runClientCommand(parseArgs(argv), deps),
  };
}

describe('setu client', () => {
  for (const [state, contents, code, message] of [
    ['missing', undefined, 1, 'does not exist'],
    ['drift', `${TEXT}old`, 1, 'is out of date'],
    ['current', TEXT, 0, 'is up to date'],
    ['unmarked', 'handwritten', 1, 'was not written by'],
  ] as const) {
    it(`review 1 escapes --output in the ${state} message`, async () => {
      const output = 'src/\u001b[31m\nINJECTED.ts';
      const h = harness(contents === undefined ? {} : { [`/app/${output}`]: contents });
      expect(await h.run(['--output', output, ...(state === 'unmarked' ? [] : ['--check'])])).toBe(
        code,
      );
      const printed = [...h.out, ...h.err].join('\n');
      expect(printed).toContain(`src/\\u001b[31m\\u000aINJECTED.ts ${message}`);
      expect(printed).not.toContain('\u001b');
      expect(printed).not.toContain('\nINJECTED');
    });
  }

  for (const dryRun of [false, true]) {
    for (const input of [false, true]) {
      it(`review 2 refuses unmarked output before loading (dry-run=${dryRun}, input=${input})`, async () => {
        const h = harness({ [OUTPUT]: 'handwritten' });
        const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify(DOCUMENT))));
        const argv = [
          ...(dryRun ? ['--dry-run'] : []),
          ...(input ? ['--input', 'https://example.test/openapi.json'] : []),
        ];
        expect(await runClientCommand(parseArgs(argv), { ...h, fetch: fetcher })).toBe(1);
        expect(h.err.join('\n')).toContain('was not written by `setu client`');
        expect(h.loadApp).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
        expect(h.importFromProject).not.toHaveBeenCalled();
        expect(h.fs.read(OUTPUT)).toBe('handwritten');
        expect(h.fs.writes).toEqual([]);
      });
    }
  }

  it('keeps check loading and generating before reading existing output', async () => {
    const h = harness({ [OUTPUT]: 'handwritten' });
    const readFile = h.fs.readFile;
    h.fs.readFile = (path) => {
      if (path === OUTPUT) expect(h.generate).toHaveBeenCalledOnce();
      return readFile(path);
    };
    expect(await h.run(['--check'])).toBe(1);
    expect(h.err.join('\n')).toContain('is out of date');
    expect(h.loadApp).toHaveBeenCalledOnce();
    expect(h.fs.writes).toEqual([]);
  });

  it('boots without a port, uses the capability, generates with the project SDK and formats in the project', async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.start).toHaveBeenCalledWith();
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.service.getSpec).toHaveBeenCalledOnce();
    expect(h.importFromProject.mock.calls).toEqual([
      ['@setu-ts/sdk', '/app'],
      ['prettier', '/app'],
    ]);
    expect(h.generate).toHaveBeenCalledWith(DOCUMENT, {});
    expect(h.prettier.resolveConfigFile).toHaveBeenCalledWith(OUTPUT);
    expect(h.prettier.resolveConfig).toHaveBeenCalledWith(OUTPUT, {
      config: '/app/.prettierrc.json',
    });
    expect(h.prettier.format).toHaveBeenCalledWith(TEXT, { semi: false, parser: 'typescript' });
    expect(h.fs.read(OUTPUT)).toBe(TEXT);
  });

  it('forwards names, directory, config and relative output', async () => {
    const h = harness({ '/app/other/package.json': '{}' });
    expect(
      await h.run([
        '--dir',
        'other',
        '--config',
        'config/api.ts',
        '--output',
        'api.ts',
        '--factory',
        '$api',
        '--type-name',
        '_API',
      ]),
    ).toBe(0);
    expect(h.loadApp.mock.calls[0]).toEqual(['file:///app/other/config/api.ts', '/app/other']);
    expect(h.generate).toHaveBeenCalledWith(DOCUMENT, { factoryName: '$api', apiTypeName: '_API' });
    expect(h.fs.read('/app/other/api.ts')).toBe(TEXT);
  });

  for (const argv of [
    ['--dry-run', '--check'],
    ['--config', 'a.ts', '--input', 'a.json'],
    ['--factory', 'bad-name'],
    ['--type-name', '3name'],
    ['--output', 'a.js'],
    ['--output', '/a.ts'],
    ['--output', '../a.ts'],
    ['--output', 'C:\\a.ts'],
    ['--output', 'src\\a.ts'],
    ['--input', 'ftp://host/a'],
    ['--input', 'file:///a.json'],
    ...['output', 'input', 'factory', 'type-name', 'dir', 'config'].map((name) => [`--${name}`]),
  ])
    it(`refuses usage ${argv.join(' ')} before loading or writing`, async () => {
      const h = harness();
      expect(await h.run(argv)).toBe(2);
      expect(h.loadApp).not.toHaveBeenCalled();
      expect(h.fs.writes).toEqual([]);
      expect(h.err.length).toBeGreaterThan(0);
    });

  it('refuses links inside the project before loading', async () => {
    const h = harness();
    h.fs.realPath = (path) =>
      Promise.resolve().then(() =>
        path.startsWith('/app/src') ? path.replace('/app/src', '/elsewhere') : '/app',
      );
    expect(await h.run()).toBe(2);
    expect(h.err.join('\n')).toContain('symbolic link');
    expect(h.loadApp).not.toHaveBeenCalled();
  });

  it('prints help through both spellings without a project', async () => {
    for (const flag of ['--help', '-h']) {
      const h = harness();
      expect(await h.run([flag])).toBe(0);
      expect(h.out.join('\n')).toContain('Usage: setu client');
      expect(h.loadApp).not.toHaveBeenCalled();
    }
  });

  it('dispatches as a built-in and refuses positionals and unknown flags', async () => {
    const h = harness({ '/app/saved.json': JSON.stringify(DOCUMENT) });
    const deps = { ...h, now: () => 0 };
    expect(await runCli(['client', '--help'], deps)).toBe(0);
    expect(await runCli(['client', 'extra'], deps)).toBe(2);
    expect(await runCli(['client', '--from', 'a.json'], deps)).toBe(2);
    expect(await runCli(['client', '--input', 'saved.json'], deps)).toBe(0);
    expect(h.loadApp).not.toHaveBeenCalled();
  });

  it('refuses a missing project, unreadable manifest and workspace with check guidance', async () => {
    const h = harness();
    await h.fs.rm('/app/package.json');
    expect(await h.run()).toBe(1);
    expect(h.err.join('\n')).toContain('holds no deno.json');
    const unreadable = harness({ '/app/package.json': '{' });
    expect(await unreadable.run()).toBe(1);
    expect(unreadable.err.join('\n')).toContain('Cannot read /app/package.json');
    const workspace = harness({ '/app/setu.workspace.json': '{}' });
    expect(await workspace.run()).toBe(1);
    expect(workspace.err.join('\n')).toContain('in a member');
    expect(workspace.loadApp).not.toHaveBeenCalled();
  });

  it('refuses unmarked output and leaves every byte untouched', async () => {
    const handwritten = 'export const handWritten = true;\n';
    const h = harness({ [OUTPUT]: handwritten });
    expect(await h.run()).toBe(1);
    expect(h.err.join('\n')).toContain('was not written by `setu client`');
    expect(h.fs.read(OUTPUT)).toBe(handwritten);
    expect(h.fs.writes).toEqual([]);
  });

  it('replaces marked output and leaves an identical file unchanged', async () => {
    const h = harness({ [OUTPUT]: `${CLIENT_MARKER}\nold\n` });
    expect(await h.run()).toBe(0);
    expect(h.fs.read(OUTPUT)).toBe(TEXT);
    expect(h.out.join('\n')).toContain('updated');
    expect(await h.run()).toBe(0);
    expect(h.out.join('\n')).toContain('unchanged');
  });

  it('regenerates a marked file formatted with the project line-ending setting', async () => {
    for (const newline of ['\r\n', '\r']) {
      const h = harness({ [OUTPUT]: TEXT.replaceAll('\n', newline) });
      h.prettier.format.mockImplementation((text) =>
        Promise.resolve(text.replaceAll('\n', newline)),
      );
      expect(await h.run()).toBe(0);
      expect(await h.run(['--check'])).toBe(0);
      expect(h.fs.read(OUTPUT)).toBe(TEXT.replaceAll('\n', newline));
      await h.fs.writeFile(
        OUTPUT,
        new TextEncoder().encode(
          TEXT.replace('interface Api', 'interface OldApi').replaceAll('\n', newline),
        ),
      );
      expect(await h.run(['--check'])).toBe(1);
      expect(h.err.at(-1)).toContain('first differing line 3');
    }
  });

  it('reports the first line for drift caused only by line endings', async () => {
    const h = harness({ [OUTPUT]: TEXT.replaceAll('\n', '\r\n') });
    expect(await h.run(['--check'])).toBe(1);
    expect(h.err.at(-1)).toContain('first differing line 1');
  });

  it('keeps a successful exit when app shutdown fails', async () => {
    const h = harness();
    h.stop.mockRejectedValue(new Error('shutdown failed'));
    expect(await h.run()).toBe(0);
    expect(h.err.join('\n')).toContain('Warning: the application did not shut down cleanly');
    expect(h.fs.read(OUTPUT)).toBe(TEXT);
  });

  it('dry-run reports the managed plan and never writes', async () => {
    const h = harness();
    expect(await h.run(['--dry-run'])).toBe(0);
    expect(h.out.join('\n')).toContain(`would create ${OUTPUT}`);
    expect(h.fs.writes).toEqual([]);
  });

  it('check accepts identical output without writing', async () => {
    const h = harness({ [OUTPUT]: TEXT });
    expect(await h.run(['--check'])).toBe(0);
    expect(h.out.join('\n')).toContain('src/clientsdk/api.ts is up to date');
    expect(h.fs.writes).toEqual([]);
  });

  it('check refuses drift at the first differing line without writing', async () => {
    const old = TEXT.replace('interface Api', 'interface OldApi');
    const h = harness({ [OUTPUT]: old });
    expect(await h.run(['--check'])).toBe(1);
    expect(h.err.join('\n')).toContain('is out of date; run `setu client`');
    expect(h.err.join('\n')).toContain('first differing line 3');
    expect(h.fs.read(OUTPUT)).toBe(old);
    expect(h.fs.writes).toEqual([]);
  });

  it('check refuses a missing file and reports generation failures separately', async () => {
    const h = harness();
    expect(await h.run(['--check'])).toBe(1);
    expect(h.err.join('\n')).toContain('does not exist; run `setu client`');
    h.generate.mockImplementation(() => {
      throw new Error('bad document');
    });
    expect(await h.run(['--check'])).toBe(1);
    expect(h.err.at(-1)).toBe('bad document');
    expect(h.fs.writes).toEqual([]);
  });

  it('reports read and write errors rather than treating them as absence', async () => {
    const h = harness();
    h.fs.writeFile = () =>
      Promise.resolve().then(() => {
        throw new Error('read-only filesystem');
      });
    expect(await h.run()).toBe(1);
    expect(h.err.join('\n')).toContain('read-only filesystem');
    const read = harness({ [OUTPUT]: TEXT });
    const stat = read.fs.stat;
    read.fs.stat = (path) =>
      path === OUTPUT ? Promise.reject(new Error('permission denied')) : stat(path);
    expect(await read.run()).toBe(1);
    expect(read.err.join('\n')).toContain('permission denied');
  });

  it('returns 130 after an interrupt during boot and stops the app', async () => {
    const h = harness();
    const abort = new AbortController();
    h.start.mockImplementation(() =>
      Promise.resolve().then(() => {
        abort.abort();
      }),
    );
    expect(await runClientCommand(parseArgs([]), { ...h, interrupt: abort.signal })).toBe(130);
    expect(h.stop).toHaveBeenCalledOnce();
    expect(h.fs.writes).toEqual([]);
  });

  it('handles an already-aborted signal and a non-Error thrown value', async () => {
    const h = harness();
    expect(await runClientCommand(parseArgs([]), { ...h, interrupt: AbortSignal.abort() })).toBe(
      130,
    );
    expect(h.start).not.toHaveBeenCalled();
    h.generate.mockImplementation(() => {
      throw 'codegen fault';
    });
    expect(await h.run()).toBe(1);
    expect(h.err.at(-1)).toBe('codegen fault');
  });
});

describe('project client generation', () => {
  it('review 3 classifies the requested SDK package not-found with its original cause', async () => {
    const cause = missing();
    await expect(
      generateClientFile(
        DOCUMENT,
        {},
        'node',
        '/app',
        OUTPUT,
        () => {},
        () => Promise.reject(cause),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('@setu-ts/sdk is not installed in this project') as unknown,
      cause,
    });
  });

  for (const specifier of ['@setu-ts/sdk', 'prettier']) {
    it(`review 3 rethrows an installed ${specifier} missing a transitive package unchanged`, async () => {
      const h = harness();
      const cause = Object.assign(
        new Error(
          `Cannot find package 'missing-transitive-peer' imported from /app/node_modules/${specifier}/index.js`,
        ),
        { code: 'ERR_MODULE_NOT_FOUND' },
      );
      const load: ClientPackageLoader = (name) =>
        name === specifier
          ? Promise.reject(cause)
          : Promise.resolve(
              name === '@setu-ts/sdk' ? { generateOpenApiClient: h.generate } : h.prettier,
            );
      await expect(
        generateClientFile(DOCUMENT, {}, 'node', '/app', OUTPUT, h.error, load),
      ).rejects.toBe(cause);
    });
  }

  it('review 3 rethrows missing-module errors without the requested package message', async () => {
    for (const cause of [
      { code: 'ERR_MODULE_NOT_FOUND' },
      { code: 'ERR_MODULE_NOT_FOUND', message: 42 },
      missing('@setu-ts/sdk-extra'),
      Object.assign(new Error("Cannot find module '/app/sdk.js' imported from /app/package.json"), {
        code: 'ERR_MODULE_NOT_FOUND',
      }),
    ]) {
      await expect(
        generateClientFile(
          DOCUMENT,
          {},
          'node',
          '/app',
          OUTPUT,
          () => {},
          () => Promise.reject(cause),
        ),
      ).rejects.toBe(cause);
    }
  });

  it('reports a missing SDK as absent from the project, with the setu add sdk remedy', async () => {
    const cause = missing();
    const rejected = generateClientFile(
      DOCUMENT,
      {},
      'node',
      '/app',
      OUTPUT,
      () => {},
      () =>
        Promise.resolve().then(() => {
          throw cause;
        }),
    );
    await expect(rejected).rejects.toMatchObject({ cause });
    // The sdk belongs in the project, not beside the CLI: the generic optional-peer
    // wording ("install it where @setu-ts/cli is installed") would send the reader
    // to the wrong place.
    await expect(rejected).rejects.not.toBeInstanceOf(OptionalDependencyUnavailableError);
    await expect(rejected).rejects.toThrow(
      '@setu-ts/sdk is not installed in this project. `setu client` generates with the project',
    );
    const h = harness({}, () =>
      Promise.resolve().then(() => {
        throw missing();
      }),
    );
    expect(await h.run()).toBe(1);
    expect(h.err.join('\n')).toContain('setu add sdk');
  });
  it('refuses an uninstalled Deno project before loading anything, even with --input', async () => {
    const h = harness({
      '/app/deno.json': '{"imports":{}}',
      '/app/o.json': JSON.stringify(DOCUMENT),
    });
    expect(await h.run(['--input', 'o.json'])).toBe(1);
    expect(h.err.join('\n')).toContain('Run `deno install`');
    expect(h.importFromProject).not.toHaveBeenCalled();
    expect(h.loadApp).not.toHaveBeenCalled();
    // A Workers project carries a deno.json for plugin gating; it is not told to run deno install.
    const workers = harness({
      '/app/deno.json': '{"imports":{}}',
      '/app/wrangler.toml': '',
      '/app/o.json': JSON.stringify(DOCUMENT),
    });
    await workers.run(['--input', 'o.json']);
    expect(workers.err.join('\n')).not.toContain('deno install');
    expect(workers.importFromProject).toHaveBeenCalled();
  });
  it('does not misreport an SDK that throws during loading as absent', async () => {
    const h = harness({}, () =>
      Promise.resolve().then(() => {
        throw new Error('SDK initialization failed');
      }),
    );
    expect(await h.run()).toBe(1);
    expect(h.err.at(-1)).toBe('SDK initialization failed');
    expect(h.err.join('\n')).not.toContain('setu add sdk');
  });
  it('refuses an installed SDK without its generator', async () => {
    const h = harness({}, () => Promise.resolve().then(() => ({})));
    expect(await h.run()).toBe(1);
    expect(h.err.join('\n')).toContain('no generateOpenApiClient; update it');
  });
  it('preserves codegen failures and explains the Api name clash', async () => {
    class OpenApiCodegenError extends Error {}
    for (const [message, expected] of [
      ["Duplicate generated name 'Api'", '--type-name'],
      ['Missing operationId on GET /x', 'Missing operationId'],
    ]) {
      const h = harness({}, () =>
        Promise.resolve().then(() => ({
          OpenApiCodegenError,
          generateOpenApiClient: () => {
            throw new OpenApiCodegenError(message);
          },
        })),
      );
      expect(await h.run()).toBe(1);
      expect(h.err.join('\n')).toContain(expected);
    }
  });
  it('falls back to the CLI Prettier only when the project has none', async () => {
    const h = harness({}, (name) =>
      Promise.resolve().then(() => {
        if (name === 'prettier') throw missing('prettier');
        return { generateOpenApiClient: () => 'export const x=1;' };
      }),
    );
    expect(await h.run()).toBe(0);
    expect(h.fs.read(OUTPUT)).toContain('export const x = 1;');
  });
  it('reports a broken formatter without falling back to another version', async () => {
    for (const failure of ['shape', 'initialization']) {
      const h = harness({}, (name) =>
        Promise.resolve().then(() => {
          if (name === '@setu-ts/sdk') return { generateOpenApiClient: () => SOURCE };
          if (failure === 'initialization') throw new Error('Prettier initialization failed');
          return {};
        }),
      );
      expect(await h.run()).toBe(1);
      expect(h.err.join('\n')).toMatch(/formatting API|initialization failed/);
    }
  });

  it('refuses every incomplete formatter API and preserves non-object loader failures', async () => {
    for (const module of [{ format: () => '' }, { format: () => '', resolveConfig: () => ({}) }]) {
      const h = harness({}, (name) =>
        Promise.resolve(name === '@setu-ts/sdk' ? { generateOpenApiClient: () => SOURCE } : module),
      );
      expect(await h.run()).toBe(1);
      expect(h.err.join('\n')).toContain('no formatting API');
    }
    for (const cause of [null, 'load failed', { code: 'OTHER', message: 'other failure' }]) {
      const h = harness({}, () => Promise.reject(cause));
      expect(await h.run()).toBe(1);
      expect(h.err.join('\n')).not.toContain('setu add sdk');
    }
  });
  for (const runtime of ['node', 'bun', 'cloudflare-workers', 'deno'] as const) {
    it(`emits the ${runtime} header and respects its formatting path`, async () => {
      const h = harness();
      const file = await generateClientFile(
        DOCUMENT,
        {},
        runtime,
        '/app',
        OUTPUT,
        h.error,
        h.importFromProject,
      );
      expect(file.managed).toBe(true);
      expect(file.contents.split('\n')[0]).toBe(CLIENT_MARKER);
      if (runtime === 'deno') {
        expect(file.contents).toContain('// deno-fmt-ignore-file\n// deno-lint-ignore-file');
        expect(h.prettier.format).not.toHaveBeenCalled();
      } else expect(file.contents).toContain('/* eslint-disable */');
    });
  }
});
