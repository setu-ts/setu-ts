import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import {
  classifySmokeExitCode,
  malformedAppDirMessage,
  unexpectedSkips,
} from '../scripts/check-apps.ts';

interface RootConfig {
  readonly workspace: readonly string[];
}

interface AppConfig {
  readonly tasks?: Readonly<Record<string, string>>;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await Deno.readTextFile(path)) as T;
}

describe('application gate configuration', () => {
  it('keeps applications outside the published workspace', async () => {
    const root = await readJson<RootConfig>('deno.json');
    expect(root.workspace.some((entry) => entry.includes('apps'))).toBe(false);
  });

  it('requires every example application to declare start and smoke tasks', async () => {
    for await (const entry of Deno.readDir('apps')) {
      if (!entry.isDirectory) continue;
      const config = await readJson<AppConfig>(`apps/${entry.name}/deno.json`);
      expect(config.tasks?.start).toBeDefined();
      expect(config.tasks?.smoke).toBeDefined();
    }
  });

  it('keeps a documented smoke skip distinct from a passing smoke check', () => {
    expect(classifySmokeExitCode({ code: 77, success: false, signal: null }))
      .toBe('skipped');
    expect(classifySmokeExitCode({ code: 0, success: true, signal: null }))
      .toBe('passed');
  });
});

describe('unexpectedSkips', () => {
  it('returns empty array when no apps skipped', () => {
    expect(unexpectedSkips([], ['cloudflare'])).toEqual([]);
  });

  it('returns empty array when all skipped apps are in the allowlist', () => {
    expect(unexpectedSkips(['cloudflare'], ['cloudflare'])).toEqual([]);
  });

  it('returns the unexpected skips when allowlist does not cover them', () => {
    expect(
      unexpectedSkips(['realtime', 'cloudflare'], ['cloudflare']),
    ).toEqual(['realtime']);
  });

  it('returns all skips when allowlist is empty (unset ALLOW_SKIP behaviour)', () => {
    expect(unexpectedSkips(['cloudflare'], [])).toEqual(['cloudflare']);
  });
});

describe('malformedAppDirMessage', () => {
  it('formats a missing deno.json message for NotFound', () => {
    const msg = malformedAppDirMessage(
      'foo',
      new Deno.errors.NotFound('ENOENT'),
    );
    expect(msg).toContain('foo');
    expect(msg).toContain('missing deno.json');
    expect(msg).toContain('malformed application directory');
  });

  it('formats an invalid JSON message for SyntaxError', () => {
    const msg = malformedAppDirMessage('bar', new SyntaxError('unexpected token'));
    expect(msg).toContain('bar');
    expect(msg).toContain('not valid JSON');
    expect(msg).toContain('malformed application directory');
  });

  it('returns null for an unknown error type', () => {
    const msg = malformedAppDirMessage('baz', new RangeError('out of range'));
    expect(msg).toBeNull();
  });
});
