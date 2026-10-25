import { describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('freshness independent of install and personal instructions', () => {
  it('ignores personal edits and card presence, but detects manifest and version changes', async () => {
    const fs = createFakeFs({ '/app/package.json': '{"dependencies":{"@setu-ts/common":"1"}}' });
    const errors: string[] = [];
    const run = (...args: string[]) =>
      runCli(['agents', ...args], {
        fs,
        cwd: '/app',
        now: () => 0,
        log: () => {},
        error: (s) => errors.push(s),
      });
    expect(await run('--check')).toBe(1);
    expect(fs.writes).toEqual([]);
    expect(await run()).toBe(0);
    expect(errors.some((s) => s.startsWith('card not found:'))).toBe(true);
    errors.length = 0;
    expect(await run('--check')).toBe(0);
    expect(errors).toEqual([]);
    const brief = fs.read('/app/AGENTS.md');
    await fs.writeFile('/app/AGENTS.md', new TextEncoder().encode('personal\n' + brief + '\nmore'));
    expect(await run('--check')).toBe(0);
    await fs.writeFile(
      '/app/AGENTS.md',
      new TextEncoder().encode(brief.replace('# Setu-TS ', '# Setu-TS old-')),
    );
    expect(await run('--check')).toBe(1);
    expect(await run()).toBe(0);
    await fs.writeFile(
      '/app/package.json',
      new TextEncoder().encode('{"dependencies":{"@setu-ts/cache-plugin":"1"}}'),
    );
    expect(await run('--check')).toBe(1);
  });

  it('adds card presence only when --strict is requested with --check', async () => {
    const fs = createFakeFs({ '/app/package.json': '{"dependencies":{"@setu-ts/common":"1"}}' });
    const errors: string[] = [];
    const run = (...args: string[]) =>
      runCli(['agents', ...args], {
        fs,
        cwd: '/app',
        now: () => 0,
        log: () => {},
        error: (s) => errors.push(s),
      });
    expect(await run()).toBe(0);
    errors.length = 0;
    // Plain --check stays install-independent (C1), so a missing card passes.
    expect(await run('--check')).toBe(0);
    expect(errors).toEqual([]);
    expect(await run('--check', '--strict')).toBe(1);
    expect(errors).toEqual([
      '/app/AGENTS.md: card not found: node_modules/@setu-ts/common/AGENT_CARD.md — run install',
    ]);
    errors.length = 0;
    expect(await run('--strict')).toBe(2);
    expect(errors).toEqual(['--strict requires --check.']);
  });
});
