import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import {
  devEntryPort,
  devEntryVariants,
  isDevEntry,
  renderDevEntry,
} from '../../src/devtool/dev-entry.ts';
import { VERSION } from '../../src/version.ts';

describe('renderDevEntry', () => {
  for (const runtime of ['deno', 'node'] as const) {
    it(`renders portable credential reads and exits for ${runtime}`, () => {
      const entry = renderDevEntry({ devtoolPort: 4919 }, runtime);
      expect(entry).not.toMatch(/Deno\.|process\./);
      expect(entry).toContain("runtime.env['SETU_DEVTOOL_SESSION_ID']");
      expect(entry).toContain("runtime.env['SETU_DEVTOOL_SESSION_KEY']");
      expect(entry.match(/runtime.exit\(1\)/g)).toHaveLength(4);
      expect(entry).toContain(runtime === 'deno' ? 'deno run -A npm:' : 'npx @setu-ts/cli@');
      expect(isDevEntry(entry, 4919, false)).toBe(true);
    });
  }
  for (const member of [false, true]) {
    it(`recognizes the captured pre-change 0.10.0 ${member ? 'member' : 'standalone'} entry verbatim`, async () => {
      const source = await readFile(
        new URL(
          `../fixtures/dev-entry-0.10.0-${member ? 'member' : 'standalone'}.txt`,
          import.meta.url,
        ),
        'utf8',
      );
      expect(devEntryVariants(4919, member)).toContain(source);
      expect(isDevEntry(source, 4919, member)).toBe(true);
      expect(devEntryPort(source, member)).toBe(4919);
    });
  }
  it('recognises ports only in complete current and previous CLI renderings', () => {
    for (const member of [false, true]) {
      for (const source of devEntryVariants(4920, member)) {
        expect(devEntryPort(source, member)).toBe(4920);
        expect(devEntryPort(`${source}// edited\n`, member)).toBeUndefined();
      }
    }
    for (const port of [0, 65536, 1e100]) {
      expect(devEntryPort(renderDevEntry({ devtoolPort: port }, 'deno'))).toBeUndefined();
    }
    expect(devEntryPort('handwritten entry')).toBeUndefined();
    const variants = devEntryVariants(4920);
    expect(variants[0]).toContain(`deno run -A npm:@setu-ts/cli@${VERSION} devtool enable`);
    expect(variants[3]).toContain('Re-run `setu devtool enable`');
    expect(variants[4]).not.toContain('Re-run');
  });
  it('checks plugin registration and diagnostics after starting and stops on discarded composition', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain("name: 'setu-devtool-probe'");
    expect(entry).toContain('plugins: [diagnostics, devtoolProbe]');
    expect(entry).toContain('if (!devtoolRegistered || app.diagnostics === undefined)');
    expect(entry.indexOf('if (!devtoolRegistered')).toBeGreaterThan(
      entry.indexOf('await app.start'),
    );
    expect(entry).toContain('await app.stop();');
    expect(entry).toContain('did not pass the devtool composition');
  });
  it('reads exactly the two credential variables', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain("runtime.env['SETU_DEVTOOL_SESSION_ID']");
    expect(entry).toContain("runtime.env['SETU_DEVTOOL_SESSION_KEY']");
    expect(entry).not.toContain('SETU_DEVTOOL_MEMBER');
  });

  it('names every variable it reads in the warning above the reads', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    const warning = entry.slice(entry.indexOf('// The two variable names'));
    expect(warning).toContain('SETU_DEVTOOL_SESSION_ID');
    expect(warning).toContain('SETU_DEVTOOL_SESSION_KEY');
    // The warning precedes the reads it warns about.
    expect(entry.indexOf('// The two variable names')).toBeLessThan(
      entry.indexOf("runtime.env['SETU_DEVTOOL_SESSION_ID']"),
    );
  });

  it('refuses an absent or malformed session id, naming it and never printing a value', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain('/^[0-9a-f]{32}$/.test(sessionId) === false');
    expect(entry).toContain('SETU_DEVTOOL_SESSION_ID is absent or malformed');
    expect(entry).toContain('runtime.exit(1)');
    // No generated line prints or persists a credential VALUE: the only
    // interpolations of the variables are the reads and the error NAMES.
    expect(entry.match(/sessionId|rawSessionKey/g)?.every(() => true)).toBe(true);
    expect(entry).not.toMatch(/console\.\w+\([^)]*\$\{sessionId/);
    expect(entry).not.toMatch(/console\.\w+\([^)]*\$\{rawSessionKey/);
    expect(entry).not.toMatch(/writeTextFile/);
  });

  it('refuses a key that is not 64 lowercase hex characters', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain('/^[0-9a-f]{64}$/.test(rawSessionKey) === false');
    expect(entry).toContain('SETU_DEVTOOL_SESSION_KEY is absent or malformed');
  });

  it('binds the devtool port as a literal and never generates a credential', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain('port: 4919,');
    expect(entry).toContain('enabled: true,');
    expect(entry).toContain('maxSessionLifetimeMs: 28_800_000,');
    // The entry READS; it never mints a pair.
    expect(entry).not.toContain('getRandomValues');
    expect(entry).not.toContain('crypto.randomUUID');
  });

  it('mirrors the production entry: same factory, same startup, same shutdown', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 }, 'deno');
    expect(entry).toContain("import { createApp } from './setu.config.ts';");
    expect(entry).toContain('await createApp(undefined, {');
    expect(entry).toContain('diagnostics: {},');
    expect(entry).toContain("await app.start({ port: Number(runtime.env.PORT ?? '3000') });");
    expect(entry).toContain('runtime.onSignal?.(signal, () => {');
  });

  it('takes a member port from the discovery module, exactly as main.ts does', () => {
    const entry = renderDevEntry(
      {
        devtoolPort: 5001,
        port: { symbol: 'SERVICE_PORT', from: './src/discovery/services.ts' },
      },
      'deno',
    );
    expect(entry).toContain("import { SERVICE_PORT } from './src/discovery/services.ts';");
    expect(entry).toContain('await app.start({ port: SERVICE_PORT });');
  });
});

describe('isDevEntry', () => {
  // The entry names the pinned CLI, so one written by an earlier release differs only
  // in the version; a CLI upgrade must not make every existing entry read as edited.
  it('recognizes an entry an earlier release wrote, and only the version may differ', () => {
    for (const member of [true, false]) {
      const current = devEntryVariants(4920, member)[0]!;
      expect(current).toContain(`npm:@setu-ts/cli@${VERSION}`);
      for (const older of ['0.8.9', '0.10.0-rc.1', '1.2.3+build.7']) {
        const earlier = current.replaceAll(
          `npm:@setu-ts/cli@${VERSION}`,
          `npm:@setu-ts/cli@${older}`,
        );
        expect(earlier).not.toBe(current);
        expect(isDevEntry(earlier, 4920, member)).toBe(true);
        expect(devEntryPort(earlier, member)).toBe(4920);
      }
      const renamed = current.replaceAll(`npm:@setu-ts/cli@${VERSION}`, 'npm:other-cli@0.8.9');
      expect(isDevEntry(renamed, 4920, member)).toBe(false);
      expect(isDevEntry(`${current}// edited\n`, 4920, member)).toBe(false);
      expect(isDevEntry(current, 4921, member)).toBe(false);
    }
  });
});
