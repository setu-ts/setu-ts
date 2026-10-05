/**
 * Project-controlled text must reach CLI output as ONE line.
 *
 * The output sinks keep `\n` on purpose — the CLI's own multi-line messages use
 * it — so a member name, a path or a parser message carrying a line feed would
 * otherwise print a second line that reads as the CLI's own. Every case here is
 * a site the M101f security audit (F1, F2, and the same class on develop) found
 * printing such a value raw.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs, createRecorder, type Recorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runDevtoolCommand } from '../../src/commands/devtool.ts';
import { runWorkspaceCommand } from '../../src/commands/workspace.ts';
import { runAddCommand } from '../../src/commands/add.ts';
import { runAppCommand } from '../../src/commands/app.ts';
import { runGenerateCommand } from '../../src/commands/generate.ts';
import { runLibraryCommand } from '../../src/commands/library.ts';
import { devtoolRunnerRefusal } from '../../src/devtool/planner.ts';
import { interruptedRunRetryHint } from '../../src/utils/file-writer.ts';
import { InterruptedError, interruptionMessage } from '../../src/utils/interruption.ts';
import { legacyLayoutNotice } from '../../src/utils/legacy-layout.ts';
import { devEntryVariants } from '../../src/devtool/dev-entry.ts';
import { RuntimeMarkerUnreadableError } from '../../src/utils/runtime-detector.ts';
import { describeReconcileFailure } from '../../src/workspace/reconcile.ts';
import { renderWorkspaceManifest, type WorkspaceManifest } from '../../src/workspace/manifest.ts';
import { workspaceProfile } from '../../src/workspace/runtime-profile.ts';

/** A factory that already takes and uses the devtool composition. */
const CONFIG = 'export function createApp(devtool?: { plugins?: readonly IPlugin[]; ' +
  'diagnostics?: KernelDiagnosticsOptions }) { return createApplication({ plugins: ' +
  '[...(devtool?.plugins ?? [])], ...(devtool?.diagnostics !== undefined ? ' +
  '{ diagnostics: devtool.diagnostics } : {}) }); }';

const FORGED = 'orders\nsetu: FORGED';
const SEPARATOR = 'orders setu: FORGED';

/** Fails when any recorded message would render as more than its own line(s) of CLI text. */
function expectNoForgedLine(recorder: Recorder): void {
  expect(recorder.lines.length).toBeGreaterThan(0);
  for (const line of recorder.lines) {
    expect(line.split('\n').some((part) => part.startsWith('setu: FORGED'))).toBe(false);
    expect(line).not.toContain(' ');
  }
}

function workspace(member: string, extra: Partial<WorkspaceManifest['members'][number]> = {}) {
  const manifest: WorkspaceManifest = {
    version: 1,
    basePort: 5869,
    devtoolBasePort: 6000,
    runtime: 'deno',
    transport: 'http',
    members: [{ name: member, port: 5869, ...extra }],
  };
  return createFakeFs({
    '/ws/setu.workspace.json': renderWorkspaceManifest(manifest),
    '/ws/deno.json': JSON.stringify({
      workspace: ['./apps/*'],
      tasks: { dev: workspaceProfile('deno').runAll },
    }),
    [`/ws/apps/${member}/deno.json`]: JSON.stringify({ tasks: { start: 'deno run -A main.ts' } }),
    [`/ws/apps/${member}/.setu-member`]: '',
    [`/ws/apps/${member}/setu.config.ts`]: CONFIG,
    ...(extra.devtoolPort === undefined
      ? {}
      : { [`/ws/apps/${member}/main.dev.ts`]: devEntryVariants(extra.devtoolPort)[0]! }),
  });
}

describe('project-controlled text stays on one output line', () => {
  for (const name of [FORGED, SEPARATOR]) {
    const label = JSON.stringify(name);

    it(`reallocation success and dry-run lines escape the member path (${label})`, async () => {
      for (const dryRun of [false, true]) {
        const fs = workspace(name, { devtoolPort: 6500 });
        const log = createRecorder();
        const argv = ['ports', '--reallocate', ...(dryRun ? ['--dry-run'] : [])];
        expect(
          await runWorkspaceCommand(parseArgs(argv), {
            fs,
            cwd: '/ws',
            log: log.sink,
            error: () => {},
          }),
        ).toBe(0);
        expectNoForgedLine(log);
      }
    });

    it(`the devtool-port conflict refusal escapes the member name (${label})`, async () => {
      const fs = workspace(name, { devtoolPort: 6500 });
      const error = createRecorder();
      await runDevtoolCommand(parseArgs(['enable', name, '--devtool-port', '6501']), {
        fs,
        cwd: '/ws',
        log: () => {},
        error: error.sink,
      });
      expect(error.text()).toContain('already uses devtool port 6500');
      expectNoForgedLine(error);
    });

    it(`the members list escapes every member name (${label})`, async () => {
      for (const argv of [['enable'], ['enable', 'missing']]) {
        const error = createRecorder();
        await runDevtoolCommand(parseArgs(argv), {
          fs: workspace(name),
          cwd: '/ws',
          log: () => {},
          error: error.sink,
        });
        expectNoForgedLine(error);
      }
    });

    it(`a reconcile failure escapes the member name and path (${label})`, () => {
      for (const reason of ['missing', 'unreadable'] as const) {
        const message = describeReconcileFailure({ ok: false, member: name, reason });
        expect(message).not.toContain('\n');
        expect(message).not.toContain(' ');
      }
    });

    it(`an unreadable runtime marker escapes its path and reason (${label})`, () => {
      const message = new RuntimeMarkerUnreadableError(`/p/${name}/package.json`, `bad\n${name}`)
        .message;
      expect(message).not.toContain('\n');
      expect(message).not.toContain(' ');
    });
  }

  it('a malformed deno.json does not echo its raw content as extra lines', async () => {
    const fs = createFakeFs({
      // V8 quotes the whole input in this error shape, newline included.
      '/p/deno.json': '{"a":\nsetu: FORGED}',
      '/p/setu.config.ts': 'export function createApp() {}',
    });
    const error = createRecorder();
    expect(
      await runDevtoolCommand(parseArgs(['enable']), {
        fs,
        cwd: '/p',
        log: () => {},
        error: error.sink,
      }),
    ).not.toBe(0);
    expectNoForgedLine(error);
  });

  it('a refused task merge escapes the value it would write (re-audit N1)', async () => {
    // The `dev` task is derived from the project's own `start` task, so the
    // "would write" line carries project-controlled text too.
    const fs = createFakeFs({
      '/p/deno.json': JSON.stringify({
        tasks: { start: 'deno run -A\nsetu: FORGED main.ts', dev: 'deno run other.ts' },
      }),
      '/p/setu.config.ts': CONFIG,
    });
    const error = createRecorder();
    await runDevtoolCommand(parseArgs(['enable']), {
      fs,
      cwd: '/p',
      log: () => {},
      error: error.sink,
    });
    expect(error.text()).toContain('would write:');
    expectNoForgedLine(error);
  });

  it('generate app escapes sibling paths and the devtool-port conflict', async () => {
    for (
      const argv of [
        ['app', 'beta', '--dry-run'],
        ['app', 'beta'],
        ['app', 'beta', '--devtool', '--devtool-port', '6500'],
      ]
    ) {
      const fs = workspace(FORGED, { devtoolPort: 6500 });
      const out = createRecorder();
      await runAppCommand(parseArgs(argv), {
        fs,
        dir: '/ws',
        log: out.sink,
        error: out.sink,
      });
      expectNoForgedLine(out);
    }
  });

  it('add, generate and workspace refusals escape a hostile project directory', async () => {
    const dir = '/p\nsetu: FORGED';
    const add = createRecorder();
    const addFs = createFakeFs({ [`${dir}/deno.json`]: JSON.stringify({ imports: {} }) });
    for (const argv of [['cache', '--dry-run'], ['cache'], ['cache']]) {
      await runAddCommand(parseArgs(argv), { fs: addFs, cwd: dir, log: add.sink, error: add.sink });
    }
    expectNoForgedLine(add);

    const generate = createRecorder();
    await runGenerateCommand(parseArgs(['service', 'x']), {
      fs: createFakeFs({
        [`${dir}/deno.json`]: JSON.stringify({ workspace: ['./apps/*'] }),
        [`${dir}/setu.workspace.json`]: '{}',
      }),
      cwd: dir,
      now: () => 0,
      log: generate.sink,
      error: generate.sink,
    });
    expectNoForgedLine(generate);

    const ports = createRecorder();
    await runWorkspaceCommand(parseArgs(['ports', '--reallocate']), {
      fs: createFakeFs(),
      cwd: dir,
      log: ports.sink,
      error: ports.sink,
    });
    expectNoForgedLine(ports);
  });

  it('generate app escapes manifest problems a committed manifest can carry (re-audit N3)', async () => {
    const base = { version: 1, basePort: 5869, runtime: 'deno', transport: 'http', members: [] };
    for (
      const manifest of [
        { ...base, transport: 'http\nsetu: FORGED' },
        // The invalid-port refusal names the field, which embeds the member name.
        { ...base, members: [{ name: FORGED, port: 70000 }] },
      ]
    ) {
      const out = createRecorder();
      await runAppCommand(parseArgs(['app', 'beta']), {
        fs: createFakeFs({ '/ws/setu.workspace.json': JSON.stringify(manifest) }),
        dir: '/ws',
        log: out.sink,
        error: out.sink,
      });
      expectNoForgedLine(out);
    }
    const absent = createRecorder();
    await runAppCommand(parseArgs(['app', 'beta']), {
      fs: createFakeFs(),
      dir: '/w\nsetu: FORGED',
      log: absent.sink,
      error: absent.sink,
    });
    expectNoForgedLine(absent);
  });

  it('generate escapes a hostile artifact file name and its own output (re-audit N3)', async () => {
    for (const dir of ['/p', '/p\nsetu: FORGED']) {
      for (const argv of [['service', 'billing', '--dry-run'], ['service', 'billing']]) {
        const out = createRecorder();
        await runGenerateCommand(parseArgs(argv), {
          fs: createFakeFs({
            [`${dir}/deno.json`]: JSON.stringify({ imports: {} }),
            [`${dir}/src/services/x\nsetu: FORGED.service.ts`]: 'export const nothing = 1;\n',
          }),
          cwd: dir,
          now: () => 0,
          log: out.sink,
          error: out.sink,
        });
        expectNoForgedLine(out);
      }
    }
  });

  it('add escapes a hostile directory in its workspace-root and JSONC refusals (re-audit N3)', async () => {
    const dir = '/p\nsetu: FORGED';
    for (
      const files of [
        {
          [`${dir}/deno.json`]: JSON.stringify({ workspace: ['./apps/*'] }),
          [`${dir}/setu.workspace.json`]: '{}',
        },
        { [`${dir}/deno.jsonc`]: '{\n  // comment\n  "imports": {}\n}\n' },
      ]
    ) {
      const out = createRecorder();
      await runAddCommand(parseArgs(['cache']), {
        fs: createFakeFs(files),
        cwd: dir,
        log: out.sink,
        error: out.sink,
      });
      expectNoForgedLine(out);
    }
  });

  it('message builders escape the project text they embed (re-audit N4)', () => {
    const hostile = '/p\nsetu: FORGED';
    const built = [
      ...legacyLayoutNotice(['evil\nsetu: FORGED.ts', 'ok.ts']),
      interruptedRunRetryHint([`${hostile}/a.ts`], hostile) ?? '',
      devtoolRunnerRefusal('old runner', `${hostile}/scripts/dev.ts`) ?? '',
      interruptionMessage(
        new AggregateError([], `rollback failed at ${hostile}`, {
          cause: new InterruptedError(),
        }),
      ) ?? '',
    ];
    const recorder = createRecorder();
    for (const message of built) {
      expect(message).not.toBe('');
      recorder.sink(message);
    }
    expectNoForgedLine(recorder);
  });

  it('generate library escapes its directory and file paths (re-audit N4)', async () => {
    const dir = '/w\nsetu: FORGED';
    const absent = createRecorder();
    await runLibraryCommand(parseArgs(['library', 'shared']), {
      fs: createFakeFs(),
      dir,
      log: absent.sink,
      error: absent.sink,
    });
    expectNoForgedLine(absent);
    for (const dryRun of [true, false]) {
      const out = createRecorder();
      await runLibraryCommand(parseArgs(['library', 'shared', ...(dryRun ? ['--dry-run'] : [])]), {
        fs: workspaceAt(dir),
        dir,
        log: out.sink,
        error: out.sink,
      });
      expect(out.text()).toContain(dryRun ? 'would create' : 'created');
      expectNoForgedLine(out);
    }
  });
});

/** A one-member workspace rooted at `dir`. */
function workspaceAt(dir: string) {
  return createFakeFs({
    [`${dir}/setu.workspace.json`]: renderWorkspaceManifest({
      version: 1,
      basePort: 5869,
      runtime: 'deno',
      transport: 'http',
      members: [],
    }),
    [`${dir}/deno.json`]: JSON.stringify({ workspace: ['./apps/*'] }),
  });
}
