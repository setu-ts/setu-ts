import { describe, expect, it } from 'vitest';

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
    expect(node.contents).toContain("spawn('npm', ['run', 'start:dev']");
    expect(bun.contents).toContain("spawn('bun', ['run', 'start:dev']");
    expect(node.contents).toContain('/ready');
    expect(bun.contents).toContain('Dependency cycle includes');
  });

  // PR #450 CI: a member's server must not outlive the runner when the script
  // shell (Ubuntu's dash) does not forward the signal, so the npm and Bun
  // runners start each member in its own group and signal the group.
  it('signals each npm and Bun member as a process group', () => {
    for (const runtime of ['node', 'bun'] as const) {
      const runner = workspaceDevRunner(workspaceProfile(runtime)).contents;
      expect(runner).toContain('detached: grouped');
      expect(runner).toContain("process.kill(-child.pid, 'SIGTERM')");
    }
  });

  // The Deno runner runs on Deno, where Node's `process` global does not exist:
  // a reference there is a ReferenceError at startup, which is how the group fix
  // first broke every Deno workspace's runner before it landed.
  it('keeps the Deno runner free of the Node process global', () => {
    expect(workspaceDevRunner(workspaceProfile('deno')).contents).not.toMatch(/\bprocess\./);
  });
});
