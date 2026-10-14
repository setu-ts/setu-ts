/**
 * Every documented `setu` install command is the one that works.
 *
 * `docs/getting-started.md` once shipped `deno install -A -f … jsr:@setu-ts/cli@…/main`
 * while four other sites carried the working form, and nothing compared the
 * copies. Since M111d the CLI is a Node program on npm, so the documented global
 * install is `npm install --global @setu-ts/cli`, identical everywhere, and no
 * current document may still carry a JSR install line — `docs/cli.md` did,
 * after every other site had moved. CHANGELOG.md is excluded: its install lines
 * record past releases.
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
  return new TextDecoder()
    .decode(output.stdout)
    .split('\n')
    .filter((path) => path !== '' && path !== 'CHANGELOG.md')
    .filter((path) => !path.startsWith('plans/') && !path.startsWith('smoke/'));
}

/** The one documented global install. */
const NPM_GLOBAL_INSTALL = 'npm install --global @setu-ts/cli';

describe('documented setu install command', () => {
  it('installs from npm, identically everywhere', async () => {
    const npm: string[] = [];
    const jsr: string[] = [];
    for (const path of await documents()) {
      const text = await Deno.readTextFile(path);
      for (const [index, line] of text.split('\n').entries()) {
        const where = `${path}:${index + 1}: ${line.trim()}`;
        if (/\bdeno install\b/.test(line) && line.includes('jsr:@setu-ts/cli')) jsr.push(where);
        if (/\bnpm (?:install|i)\b[^`]*@setu-ts\/cli\b/.test(line)) npm.push(where);
      }
    }
    // No current document may still install the CLI from JSR.
    expect(jsr).toEqual([]);
    // Vacuity guard: the README, the guides, PUBLIC_API.md, the CLI README and the
    // upgrade guide all carry one, so finding few means the scan broke.
    expect(npm.length).toBeGreaterThanOrEqual(5);
    for (const entry of npm) {
      expect({ entry, form: entry.includes(NPM_GLOBAL_INSTALL) }).toEqual({ entry, form: true });
    }
  });
});
