/**
 * Unit tests for `release:verify`'s Node version sites (M111a plan §3.5, §6):
 * a `package.json` or `src/version.ts` that disagrees with the tag is reported
 * by name, and a member shipping no constant is not.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { versionSiteProblems } from '../../scripts/version-sites.ts';

const DIR = 'packages/kernel';
const MANIFEST = '{"name":"@setu-ts/kernel","version":"0.9.0"}';
const CONSTANT = "export const VERSION: string = '0.9.0';\n";

describe('versionSiteProblems', () => {
  it('reports nothing when both sites agree with the tag', () => {
    expect(versionSiteProblems(DIR, '0.9.0', MANIFEST, CONSTANT)).toEqual([]);
  });

  it('accepts a member that ships no version constant', () => {
    expect(versionSiteProblems(DIR, '0.9.0', MANIFEST, null)).toEqual([]);
  });

  it('reports a package.json version that disagrees with the tag', () => {
    expect(versionSiteProblems(DIR, '0.9.0', '{"version":"0.8.0"}', CONSTANT)).toEqual([
      'packages/kernel: package.json version is 0.8.0, expected 0.9.0',
    ]);
  });

  it('reports a src/version.ts constant that disagrees with the tag', () => {
    expect(
      versionSiteProblems(DIR, '0.9.0', MANIFEST, "export const VERSION: string = '0.8.0';"),
    ).toEqual(['packages/kernel: src/version.ts VERSION is 0.8.0, expected 0.9.0']);
  });

  it('reports both sites when both disagree', () => {
    expect(
      versionSiteProblems(
        DIR,
        '0.9.0',
        '{"version":"0.8.0"}',
        "export const VERSION: string = '0.8.0';",
      ),
    ).toHaveLength(2);
  });

  it('reports a package.json with no version', () => {
    expect(versionSiteProblems(DIR, '0.9.0', '{"name":"x"}', null)).toEqual([
      'packages/kernel: package.json version is (missing), expected 0.9.0',
    ]);
  });

  it('reports an absent, unparseable or non-object package.json as unreadable', () => {
    const unreadable = "packages/kernel: no readable package.json (the Node build's manifest)";
    for (const text of [null, '{not json', 'null', '7']) {
      expect(versionSiteProblems(DIR, '0.9.0', text, null)).toEqual([unreadable]);
    }
  });

  it('reports a src/version.ts with no recognizable literal', () => {
    expect(versionSiteProblems(DIR, '0.9.0', MANIFEST, 'export const VERSION = "0.9.0";'))
      .toEqual(['packages/kernel: src/version.ts carries no recognizable VERSION literal']);
  });
});
