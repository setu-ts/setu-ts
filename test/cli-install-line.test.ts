/**
 * Every documented `setu` install command is the one that works.
 *
 * `docs/getting-started.md` shipped `deno install -A -f … jsr:@setu-ts/cli@…/main`
 * while four other sites carried the working form. On Deno 2.9 that line fails
 * outright (`the following required arguments were not provided: --global`),
 * and even with `-g` the binary is named after the entry file, `cli`, so every
 * `setu new …` that follows answers "command not found". Nothing ran or
 * compared the copies, so the broken one survived a rewrite of the guide.
 * CHANGELOG.md is excluded: its install lines record past releases.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

/** Tracked Markdown files that may carry a current install command. */
async function documents(): Promise<string[]> {
  const output = await new Deno.Command('git', {
    args: ['ls-files', '*.md'],
    stdout: 'piped',
  }).output();
  return new TextDecoder().decode(output.stdout).split('\n')
    .filter((path) => path !== '' && path !== 'CHANGELOG.md')
    .filter((path) => !path.startsWith('plans/') && !path.startsWith('smoke/'));
}

describe('documented setu install command', () => {
  it('is global, named setu, and identical everywhere', async () => {
    const lines: string[] = [];
    for (const path of await documents()) {
      const text = await Deno.readTextFile(path);
      for (const [index, line] of text.split('\n').entries()) {
        if (/\bdeno install\b/.test(line) && line.includes('jsr:@setu-ts/cli@')) {
          lines.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    // Vacuity guard: the README, both guides, PUBLIC_API.md and the CLI
    // README all carry one, so finding none means the scan broke.
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const entry of lines) {
      const command = entry.slice(entry.indexOf(': ') + 2);
      expect({ entry, global: /\s-g\s/.test(command) }).toEqual({ entry, global: true });
      expect({ entry, named: /\s-n setu\s/.test(command) }).toEqual({ entry, named: true });
    }
    const commands = new Set(lines.map((entry) => entry.slice(entry.indexOf(': ') + 2)));
    expect([...commands]).toHaveLength(1);
  });
});
