import * as nodeFs from 'node:fs/promises';
/** Guards broker string sinks from dropping caught error diagnostics. @module */
import { describe, expect, it } from 'vitest';

const BROKERS_DIRECTORY = new URL('../../src/brokers/', import.meta.url);
const RAW_LOG_INTERPOLATION = /\.error\(\s*`[^`]*\$\{(?:error|err|handlerError|args\.error)\}/;
const ESCAPE_MARKER = 'raw-interpolation:';

describe('broker logger diagnostics', () => {
  it('does not interpolate caught errors directly into logger messages', async () => {
    const violations: string[] = [];
    for await (const entry of await nodeFs.opendir(BROKERS_DIRECTORY)) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const source = await nodeFs.readFile(new URL(entry.name, BROKERS_DIRECTORY), 'utf8');
      if (RAW_LOG_INTERPOLATION.test(source) && !source.includes(ESCAPE_MARKER)) {
        violations.push(entry.name);
      }
    }

    expect(violations).toEqual([]);
  });
});
