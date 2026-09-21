import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MINIMAL_HOST } from '../../src/templates/minimal.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { FULL_STACK_TEMPLATE } from '../../src/templates/full-stack.ts';
import type { TargetRuntime } from '../../src/constants.ts';

/** Renders the config module for one runtime, as `setu new` would. */
function config(runtime: TargetRuntime, template?: typeof MINIMAL_HOST): string {
  const host = resolveHost(template ?? MINIMAL_HOST, runtime);
  return projectFiles('probe', runtime, host).find((file) => file.path === 'setu.config.ts')!
    .contents;
}

describe('the generated config module factory signature', () => {
  it('takes the devtool composition as its SECOND parameter on Deno', () => {
    const source = config('deno');
    expect(source).toContain(
      'export function createApp(\n' +
        '  _env?: Readonly<Record<string, unknown>>,\n' +
        '  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },\n' +
        '): IApplication {',
    );
  });

  it('takes the same second parameter on Node and Bun', () => {
    for (const runtime of ['node', 'bun'] as const) {
      expect(config(runtime)).toContain(
        'devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },',
      );
    }
  });

  it('keeps env FIRST and named on Workers, with the parameter unused there', () => {
    const source = config('cloudflare-workers');
    expect(source).toContain(
      'export function createApp(\n  env: Readonly<Record<string, unknown>> = {},',
    );
    expect(source).toContain('_devtool?: { plugins?: readonly IPlugin[];');
    // The devtool is Deno-only: the Workers factory never reads it.
    expect(source).not.toContain('...(devtool?.plugins ?? [])');
  });

  it('keeps the starter factory async with the parameter accepted and unread', () => {
    const source = config('deno', FULL_STACK_TEMPLATE);
    expect(source).toContain('export async function createApp(');
    expect(source).toContain('  env?: Readonly<Record<string, unknown>>,');
    expect(source).toContain('_devtool?: { plugins?: readonly IPlugin[];');
    expect(source).not.toContain('...(devtool?.plugins ?? [])');
  });

  it('threads the plugin spread and the constructor diagnostics option on the plugin-list path', () => {
    const source = config('deno');
    expect(source).toContain('...(devtool?.plugins ?? []),');
    expect(source).toContain(
      '...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),',
    );
  });

  it('imports the kernel on every target because the parameter names its type', () => {
    for (const runtime of ['deno', 'node', 'bun', 'cloudflare-workers'] as const) {
      expect(config(runtime)).toContain('@setu-ts/kernel');
    }
  });
});
