import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { workspaceDevRunner } from '../../../src/workspace/dev-runner.ts';
import { workspaceProfile } from '../../../src/workspace/runtime-profile.ts';

describe('workspaceDevRunner', () => {
  it('renders a Deno runner that waits for readiness before starting dependents', () => {
    const runner = workspaceDevRunner(workspaceProfile('deno'));
    expect(runner.path).toBe('scripts/dev.ts');
    expect(runner.contents).toContain('Deno.Command');
    expect(runner.contents).toContain('/ready');
    expect(runner.contents).toContain('Dependency cycle includes');
    expect(runner.contents).toContain('child.kill');
  });

  it('renders Node and Bun runners with their own child command', () => {
    const node = workspaceDevRunner(workspaceProfile('node'));
    const bun = workspaceDevRunner(workspaceProfile('bun'));
    expect(node.path).toBe('scripts/dev.mjs');
    expect(node.contents).toContain("spawn('npm', ['run', 'start']");
    expect(bun.contents).toContain("spawn('bun', ['run', 'start']");
    expect(node.contents).toContain('/ready');
    expect(bun.contents).toContain('Dependency cycle includes');
  });
});
