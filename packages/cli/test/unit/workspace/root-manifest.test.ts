import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  NODE_MODULES_AUTO,
  NODE_MODULES_DIR,
  planRootNodeModulesDir,
  planRootWorkspaceGlob,
  ROOT_MANIFEST,
  WORKSPACE_KEY,
} from '../../../src/workspace/root-manifest.ts';

describe('planRootNodeModulesDir', () => {
  it('adds the field, keeping everything else the root declared', () => {
    const plan = planRootNodeModulesDir(
      `${JSON.stringify({ workspace: ['./apps/*'], tasks: { dev: 'x' } })}\n`,
      'web',
    );
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    const parsed = JSON.parse(plan.file.contents) as Record<string, unknown>;
    expect(parsed[NODE_MODULES_DIR]).toBe(NODE_MODULES_AUTO);
    expect(parsed['tasks']).toEqual({ dev: 'x' });
    // The CLI wrote this file and is adding one field to it, so the overwrite
    // check must not treat it as somebody else's.
    expect(plan.file.managed).toBe(true);
  });

  it('does nothing when the root already answers the same way', () => {
    const plan = planRootNodeModulesDir(
      `${JSON.stringify({ [NODE_MODULES_DIR]: NODE_MODULES_AUTO })}\n`,
      'web',
    );
    expect(plan.kind).toBe('unchanged');
  });

  // `none` is a deliberate choice to keep every dependency in Deno's global cache.
  it('refuses a root that answers differently, naming the value', () => {
    const plan = planRootNodeModulesDir(
      `${JSON.stringify({ [NODE_MODULES_DIR]: 'none' })}\n`,
      'web',
    );
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') expect(plan.message).toContain('"none"');
  });

  it('refuses a root it cannot parse rather than rewriting it', () => {
    const plan = planRootNodeModulesDir('{ // a comment\n}', 'web');
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') expect(plan.message).toContain('Add that field by hand');
  });

  // Reachable from a hand-written root: a JSON document is not required to be an
  // object, and rewriting an array as one would discard it.
  it('refuses a root that is valid JSON but not an object', () => {
    for (const contents of ['[]', '"a string"', 'null']) {
      const plan = planRootNodeModulesDir(contents, 'web');
      expect(plan.kind).toBe('refused');
      if (plan.kind === 'refused') expect(plan.message).toContain('not a JSON object');
    }
  });
});

describe('planRootWorkspaceGlob', () => {
  it('appends the glob, keeping the existing ones and everything else', () => {
    const plan = planRootWorkspaceGlob(
      `${JSON.stringify({ workspace: ['./apps/*'], tasks: { dev: 'x' } })}\n`,
      './libs/*',
      'shared',
    );
    expect(plan.kind).toBe('update');
    if (plan.kind !== 'update') return;
    const parsed = JSON.parse(plan.file.contents) as Record<string, unknown>;
    expect(parsed[WORKSPACE_KEY]).toEqual(['./apps/*', './libs/*']);
    expect(parsed['tasks']).toEqual({ dev: 'x' });
    expect(plan.file.managed).toBe(true);
  });

  // Every workspace this CLI creates declares both globs, so this is the common
  // path and it must touch nothing.
  it('does nothing when the glob is already declared', () => {
    const plan = planRootWorkspaceGlob(
      `${JSON.stringify({ workspace: ['./apps/*', './libs/*'] })}\n`,
      './libs/*',
      'shared',
    );
    expect(plan.kind).toBe('unchanged');
  });

  it('refuses a root whose workspace key is not a list of strings', () => {
    for (const workspace of ['apps/*', 42, { path: './apps/*' }, ['./apps/*', 7]]) {
      const plan = planRootWorkspaceGlob(
        `${JSON.stringify({ workspace })}\n`,
        './libs/*',
        'shared',
      );
      expect(plan.kind).toBe('refused');
      if (plan.kind === 'refused') expect(plan.message).toContain(WORKSPACE_KEY);
    }
  });

  it('refuses a root it cannot parse, naming the library that needed it', () => {
    const plan = planRootWorkspaceGlob('{ // comment\n}', './libs/*', 'shared');
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') {
      expect(plan.message).toContain('shared');
      expect(plan.message).toContain(ROOT_MANIFEST);
    }
  });

  it('refuses a root that is valid JSON but not an object', () => {
    const plan = planRootWorkspaceGlob('[]', './libs/*', 'shared');
    expect(plan.kind).toBe('refused');
    if (plan.kind === 'refused') expect(plan.message).toContain('not a JSON object');
  });
});
