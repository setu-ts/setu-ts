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
});
