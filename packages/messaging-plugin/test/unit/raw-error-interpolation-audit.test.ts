/** Guards broker string sinks from dropping caught error diagnostics. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

const BROKERS_DIRECTORY = new URL('../../src/brokers/', import.meta.url);
const RAW_LOG_INTERPOLATION = /\.error\(\s*`[^`]*\$\{(?:error|err|handlerError|args\.error)\}/;
const ESCAPE_MARKER = 'raw-interpolation:';

describe('broker logger diagnostics', () => {
  it('does not interpolate caught errors directly into logger messages', async () => {
    const violations: string[] = [];
    for await (const entry of Deno.readDir(BROKERS_DIRECTORY)) {
      if (!entry.isFile || !entry.name.endsWith('.ts')) continue;
      const source = await Deno.readTextFile(new URL(entry.name, BROKERS_DIRECTORY));
      if (RAW_LOG_INTERPOLATION.test(source) && !source.includes(ESCAPE_MARKER)) {
        violations.push(entry.name);
      }
    }

    expect(violations).toEqual([]);
  });
});
