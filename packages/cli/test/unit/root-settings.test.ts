import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { rootManifestSettings } from '../../src/templates/root-settings.ts';
import { projectFiles, resolveHost } from '../../src/templates/project-files.ts';
import { workspaceRootFiles } from '../../src/workspace/root-files.ts';
import { transportSpec } from '../../src/workspace/transport.ts';
import { getTemplate } from '../../src/templates/registry.ts';

/** Parses one emitted file's JSON, so an assertion reads keys rather than text. */
function manifestOf(files: readonly { path: string; contents: string }[], path: string) {
  const file = files.find((f) => f.path === path);
  if (!file) throw new Error(`no ${path} in the emitted set`);
  return JSON.parse(file.contents) as Record<string, unknown>;
}

describe('root manifest settings', () => {
  it('opts a generated project out of the dependency-age policy', () => {
    // `setu new` pins a project to the CLI's own version. Deno refuses a
    // dependency published in the last 24 hours, so without this a project
    // scaffolded on the day of a release cannot install the versions it was
    // just pinned to — the failure is total, not a warning.
    expect(rootManifestSettings()['minimumDependencyAge']).toBe(0);
  });

  it('explains the opt-out beside it', () => {
    // A reader who deletes the line should be able to see what it was for.
    expect(String(rootManifestSettings()['//minimumDependencyAge'])).toContain('24 hours');
  });

  it('carries the formatting the CLI actually emits', () => {
    // The CLI writes single-quoted source; Deno's default is double. Without
    // this a fresh scaffold fails `deno fmt --check` on files the CLI itself
    // just wrote.
    expect(rootManifestSettings()['fmt']).toEqual({
      lineWidth: 100,
      indentWidth: 2,
      singleQuote: true,
      semiColons: true,
    });
  });
});

describe('where the root settings are emitted', () => {
  it('puts them in a workspace root', () => {
    const manifest = manifestOf(
      workspaceRootFiles('shop', 3000, transportSpec('http')),
      'deno.json',
    );

    expect(manifest['minimumDependencyAge']).toBe(0);
    expect(manifest['fmt']).toBeDefined();
    // The keys the root already carried are untouched.
    expect(manifest['workspace']).toEqual(['./apps/*', './libs/*']);
  });

  it('puts them in a standalone project root', () => {
    const host = resolveHost(getTemplate('rest')!, { di: false }, 'deno');
    const manifest = manifestOf(projectFiles('shop', 'deno', host, { di: false }), 'deno.json');

    expect(manifest['minimumDependencyAge']).toBe(0);
    expect(manifest['fmt']).toBeDefined();
  });

  it('keeps them OUT of a workspace member', () => {
    // A member inherits both from its root, and Deno refuses some root-only
    // settings in a member outright — `nodeModulesDir` is the precedent. The
    // port argument is what marks a member.
    const host = resolveHost(getTemplate('rest')!, { di: false }, 'deno');
    const member = projectFiles('shop', 'deno', host, { di: false }, {
      symbol: 'SERVICE_PORT',
      from: './src/discovery/services.ts',
    });
    const manifest = manifestOf(member, 'deno.json');

    expect(manifest['minimumDependencyAge']).toBeUndefined();
    expect(manifest['fmt']).toBeUndefined();
  });
});
