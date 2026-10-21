import { describe, expect, it } from 'vitest';
import { availableSchematics } from '../../../src/commands/generate.ts';
import { runCli } from '../../../src/cli.ts';
import { createFakeFs } from '../../fixtures/fake-fs.ts';

describe('one schematic availability inventory', () => {
  for (const plugins of [
    [],
    ['decorator-plugin'],
    ['queue-plugin', 'auth-plugin', 'cqrs-plugin', 'validation-plugin'],
  ]) {
    it(`agrees with generate --help for ${plugins.join(', ') || 'no plugins'}`, async () => {
      const fs = createFakeFs({
        '/app/package.json': JSON.stringify({
          dependencies: Object.fromEntries(plugins.map((p) => [`@setu-ts/${p}`, '1'])),
        }),
      });
      const lines: string[] = [];
      expect(
        await runCli(['g', '--help'], {
          fs,
          cwd: '/app',
          now: () => 0,
          log: (s) => lines.push(s),
          error: () => {},
        }),
      ).toBe(0);
      const listed = lines.filter((line) => /^ {2}[\w-]+$/.test(line)).map((line) => line.trim());
      expect(listed).toEqual(availableSchematics(new Set(plugins)).map((s) => s.name));
    });
  }
});
