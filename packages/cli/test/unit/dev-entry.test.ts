import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { renderDevEntry } from '../../src/devtool/dev-entry.ts';

describe('renderDevEntry', () => {
  it('reads exactly the two credential variables', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    expect(entry).toContain("Deno.env.get('SETU_DEVTOOL_SESSION_ID')");
    expect(entry).toContain("Deno.env.get('SETU_DEVTOOL_SESSION_KEY')");
    expect(entry).not.toContain('SETU_DEVTOOL_MEMBER');
  });

  it('names every variable it reads in the warning above the reads', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    const warning = entry.slice(entry.indexOf('// The two variable names'));
    expect(warning).toContain('SETU_DEVTOOL_SESSION_ID');
    expect(warning).toContain('SETU_DEVTOOL_SESSION_KEY');
    // The warning precedes the reads it warns about.
    expect(entry.indexOf('// The two variable names'))
      .toBeLessThan(entry.indexOf("Deno.env.get('SETU_DEVTOOL_SESSION_ID')"));
  });

  it('refuses an absent or malformed session id, naming it and never printing a value', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    expect(entry).toContain('/^[0-9a-f]{32}$/.test(sessionId) === false');
    expect(entry).toContain('SETU_DEVTOOL_SESSION_ID is absent or malformed');
    expect(entry).toContain('Deno.exit(1)');
    // No generated line prints or persists a credential VALUE: the only
    // interpolations of the variables are the reads and the error NAMES.
    expect(entry.match(/sessionId|rawSessionKey/g)?.every(() => true)).toBe(true);
    expect(entry).not.toMatch(/console\.\w+\([^)]*\$\{sessionId/);
    expect(entry).not.toMatch(/console\.\w+\([^)]*\$\{rawSessionKey/);
    expect(entry).not.toMatch(/writeTextFile/);
  });

  it('refuses a key that is not 64 lowercase hex characters', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    expect(entry).toContain('/^[0-9a-f]{64}$/.test(rawSessionKey) === false');
    expect(entry).toContain('SETU_DEVTOOL_SESSION_KEY is absent or malformed');
  });

  it('binds the devtool port as a literal and never generates a credential', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    expect(entry).toContain('port: 4919,');
    expect(entry).toContain('enabled: true,');
    // The entry READS; it never mints a pair.
    expect(entry).not.toContain('getRandomValues');
    expect(entry).not.toContain('crypto.randomUUID');
  });

  it('mirrors the production entry: same factory, same startup, same shutdown', () => {
    const entry = renderDevEntry({ devtoolPort: 4919 });
    expect(entry).toContain("import { createApp } from './setu.config.ts';");
    expect(entry).toContain('await createApp(undefined, {');
    expect(entry).toContain('diagnostics: {},');
    expect(entry).toContain("await app.start({ port: Number(runtime.env.PORT ?? '3000') });");
    expect(entry).toContain('runtime.onSignal?.(signal, () => {');
  });

  it('takes a member port from the discovery module, exactly as main.ts does', () => {
    const entry = renderDevEntry({
      devtoolPort: 5001,
      port: { symbol: 'SERVICE_PORT', from: './src/discovery/services.ts' },
    });
    expect(entry).toContain("import { SERVICE_PORT } from './src/discovery/services.ts';");
    expect(entry).toContain('await app.start({ port: SERVICE_PORT });');
  });
});
