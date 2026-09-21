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
    expect(source).not.toContain('devtool?.diagnostics');
  });

  it('keeps the starter factory async with the parameter accepted and unread', () => {
    const source = config('deno', FULL_STACK_TEMPLATE);
    expect(source).toContain('export async function createApp(');
    expect(source).toContain('  env?: Readonly<Record<string, unknown>>,');
    expect(source).toContain('_devtool?: { plugins?: readonly IPlugin[];');
    expect(source).not.toContain('...(devtool?.plugins ?? [])');
    expect(source).not.toContain('devtool?.diagnostics');
  });

  /**
   * Every read of the composition in generated source, in the one form the
   * renderer emits it: optional chaining off the parameter. Deliberately NOT a
   * bare `\bdevtool\b` word match — the JSDoc above each factory says "the
   * devtool is Deno-only" in prose, so a word match reports a comment as a
   * reference and the guard fails on correct output.
   *
   * @param source - The rendered config module
   * @returns Each read, so an empty array means the factory reads nothing
   */
  const bareReads = (source: string): readonly string[] =>
    source.match(/(?<![_\w])devtool\?\./g) ?? [];

  // The defect this pins shipped: the plugin spread was gated on `onWorkers`
  // and the kernel-diagnostics option beside it was not, so the Workers
  // factory declared `_devtool` and then referenced `devtool` — TS2552 under
  // the project's own check, a ReferenceError at boot. `deno fmt` and
  // `deno lint` both pass on that file, so only an identifier assertion or a
  // type-check sees it. Asserted for EVERY target that underscore-prefixes the
  // parameter, rather than for the one that happened to break.
  it('never reads the bare identifier where the parameter is underscore-prefixed', () => {
    const hosts: readonly (readonly [string, string])[] = [
      ['workers', config('cloudflare-workers')],
      ['starter', config('deno', FULL_STACK_TEMPLATE)],
    ];
    for (const [label, source] of hosts) {
      expect(source, `${label}: declares the unused parameter`).toContain('_devtool?:');
      expect(bareReads(source), `${label}: reads an identifier it never declared`).toEqual([]);
    }
  });

  // The positive control: the plugin-list targets DO read it, so a "fix" that
  // suppressed the composition everywhere would fail here rather than pass.
  it('does read the bare identifier on the targets that honor it', () => {
    for (const runtime of ['deno', 'node', 'bun'] as const) {
      expect(bareReads(config(runtime)).length, runtime).toBe(2);
    }
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
