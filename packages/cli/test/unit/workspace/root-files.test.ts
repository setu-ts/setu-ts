import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { firstDuplicatePath } from '../../../src/utils/file-writer.ts';
import { workspaceRootFiles } from '../../../src/workspace/root-files.ts';
import { WORKSPACE_MANIFEST, WORKSPACE_VERSION } from '../../../src/workspace/manifest.ts';
import { transportSpec } from '../../../src/workspace/transport.ts';

/** The default transport every existing assertion was written against. */
const HTTP = transportSpec('http');

/**
 * Reads one emitted file's contents.
 *
 * @param path - The path to read
 * @returns Its contents
 */
function contentsOf(path: string): string {
  const file = workspaceRootFiles('acme', 3000, HTTP).find((candidate) => candidate.path === path);
  expect(file).toBeDefined();
  return file?.contents ?? '';
}

describe('workspaceRootFiles', () => {
  it('emits the four root files and nothing else', () => {
    expect(workspaceRootFiles('acme', 3000, HTTP).map((file) => file.path).sort()).toEqual([
      '.gitignore',
      'README.md',
      WORKSPACE_MANIFEST,
      'deno.json',
    ].sort());
  });

  it('plans no path twice', () => {
    expect(firstDuplicatePath(workspaceRootFiles('acme', 3000, HTTP))).toBeUndefined();
  });

  // A GLOB, parsed rather than substring-matched: this is what makes adding a
  // member touch no file the developer owns.
  // BOTH globs, written once: a service goes under apps/ and a library under
  // libs/, and a glob matching nothing is valid (measured), so neither kind of
  // addition ever has to rewrite this file.
  it('declares members by glob so the root is never rewritten', () => {
    const manifest = JSON.parse(contentsOf('deno.json')) as { workspace?: string[] };
    expect(manifest.workspace).toEqual(['./apps/*', './libs/*']);
  });

  it('gives the root a task that runs every member', () => {
    const manifest = JSON.parse(contentsOf('deno.json')) as { tasks?: Record<string, string> };
    expect(manifest.tasks?.['dev']).toBe('deno task --recursive start');
  });

  // Framework pins belong to members: `setu generate` detects installed plugins
  // by reading ONE directory's manifest and never walks up, so pins living only
  // here would make every gated schematic refuse inside a member.
  it('pins no framework package at the root', () => {
    expect(contentsOf('deno.json')).not.toContain('@setu-ts/');
  });

  it('starts the workspace manifest empty, at the supported version', () => {
    const manifest = JSON.parse(contentsOf(WORKSPACE_MANIFEST)) as {
      version: number;
      basePort: number;
      members: unknown[];
    };
    expect(manifest).toEqual({
      version: WORKSPACE_VERSION,
      basePort: 3000,
      transport: 'http',
      members: [],
    });
  });

  it('records the base port it was given', () => {
    const file = workspaceRootFiles('acme', 4100, HTTP).find((f) => f.path === WORKSPACE_MANIFEST);
    expect(JSON.parse(file?.contents ?? '{}')).toMatchObject({ basePort: 4100 });
  });

  it('names the workspace and the add-a-service command in its README', () => {
    const readme = contentsOf('README.md');
    expect(readme).toContain('# acme');
    expect(readme).toContain('setu generate app orders');
    expect(readme).toContain(WORKSPACE_MANIFEST);
  });
});

// The README's transport section renders differently for each shape a transport
// can take, and a scaffolded workspace's only documentation of its own bus is this
// file — so each arm is rendered rather than assumed.
describe('the workspace README transport section', () => {
  /**
   * Renders the README for a transport.
   *
   * @param name - The transport
   * @param url - A `--transport-url` override, when one applies
   * @returns The README contents
   */
  function readmeFor(name: Parameters<typeof transportSpec>[0], url?: string): string {
    const files = workspaceRootFiles('acme', 3000, transportSpec(name), url);
    return files.find((file) => file.path === 'README.md')?.contents ?? '';
  }

  it('says nothing about a connection for a transport that has none', () => {
    const readme = readmeFor('http');
    expect(readme).toContain('Services talk over **http**');
    expect(readme).not.toContain('reads its connection value');
    // …and offers no stack, because there is no broker to run.
    expect(readme).not.toContain('Run the stack');
  });

  it('names the variable and the fallback for a broker transport', () => {
    const readme = readmeFor('redis');
    expect(readme).toContain('REDIS_URL');
    expect(readme).toContain('redis://127.0.0.1:6379');
    expect(readme).toContain('Run the stack');
  });

  it('shows the override in place of the local default when one is given', () => {
    const readme = readmeFor('redis', 'redis://shared:6379');
    expect(readme).toContain('redis://shared:6379');
    expect(readme).not.toContain('redis://127.0.0.1:6379');
  });

  // Both cloud arms carry an operational fact a developer cannot guess, and the
  // generated README is where they would look for it.
  it('carries the transport operational note when it has one', () => {
    expect(readmeFor('pubsub')).toContain('Topics are NOT');
    expect(readmeFor('service-bus')).toContain('NO entities');
  });
});
