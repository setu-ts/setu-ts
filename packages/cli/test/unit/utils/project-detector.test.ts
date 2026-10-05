import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../../fixtures/fake-fs.ts';
import { detectProject } from '../../../src/utils/project-detector.ts';

describe('detectProject', () => {
  it('reports a directory with no manifest as none', async () => {
    expect(await detectProject(createFakeFs({ '/app/readme.txt': 'hi' }), '/app')).toEqual({
      kind: 'none',
    });
  });

  it('accepts every project manifest spelling', async () => {
    for (const file of ['deno.json', 'deno.jsonc', 'package.json']) {
      const result = await detectProject(createFakeFs({ [`/app/${file}`]: '{}' }), '/app');
      expect(result.kind).toBe('project');
    }
  });

  it('recognizes all workspace-root markers', async () => {
    const fixtures = [
      { '/app/setu.workspace.json': '{}' },
      { '/app/deno.json': '{"workspace":[]}' },
      { '/app/deno.jsonc': '{"workspace":[],}' },
      { '/app/package.json': '{"workspaces":[]}' },
    ];
    for (const fixture of fixtures) {
      expect((await detectProject(createFakeFs(fixture), '/app')).kind).toBe('workspace-root');
    }
  });

  it('names an unreadable manifest', async () => {
    const result = await detectProject(createFakeFs({ '/app/deno.json': '{ nope' }), '/app');
    expect(result.kind).toBe('unreadable');
  });
});
