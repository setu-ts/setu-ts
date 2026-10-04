/**
 * Check 10's controls: the version number against what the section says it
 * carries. Each refusal is shown to fire and its corrected input to pass.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { bumpKind, countBreaking, shapeProblems } from '../../scripts/release-shape.ts';

describe('bumpKind', () => {
  it('classifies each position and the equal case', () => {
    expect(bumpKind('0.8.0', '0.8.1')).toBe('patch');
    expect(bumpKind('0.8.0', '0.9.0')).toBe('minor');
    expect(bumpKind('0.9.3', '1.0.0')).toBe('major');
    expect(bumpKind('0.8.0', '0.8.0')).toBe('none');
    expect(bumpKind('0.9.0', '0.8.5')).toBe('backwards');
    expect(bumpKind('0.8.0', '0.9.0-rc.1')).toBe('prerelease');
    // A release of a core that only shipped as prereleases is a bump of that core.
    expect(bumpKind('0.9.0-rc.2', '0.9.0')).toBe('patch');
    expect(bumpKind('0.1.0-alpha.10', '0.2.0')).toBe('minor');
  });

  it('refuses a non-SemVer string by name', () => {
    expect(() => bumpKind('v0.8.0', '0.9.0')).toThrow('previous version is not SemVer');
    expect(() => bumpKind('0.8.0', 'latest')).toThrow('next version is not SemVer');
  });
});

describe('countBreaking', () => {
  it('counts entry leads opening with BREAKING and nothing else', () => {
    const section = [
      '### Changed',
      '',
      '- **BREAKING: `TemplateEngine.render` is asynchronous (M102).** Text.',
      '- **BREAKING — a Pub/Sub subscription is named per topic.** Text.',
      '- **Not breaking:** this entry mentions BREAKING in prose and `**BREAKING**` in code.',
      '- **The breaking change M69 shipped** is referenced here, lower-case.',
      '  - **BREAKING** nested under another entry is not an entry lead.',
    ].join('\n');
    expect(countBreaking(section)).toBe(2);
    expect(countBreaking('')).toBe(0);
  });
});

describe('shapeProblems', () => {
  const base = { allowQuietMinor: false, version: '0.9.1' };

  it('refuses a patch carrying breaking entries, and passes one that does not', () => {
    expect(shapeProblems({ ...base, bump: 'patch', breaking: 1 })[0])
      .toContain('0.9.1 is a PATCH release but its changelog section carries 1 BREAKING entry.');
    expect(shapeProblems({ ...base, bump: 'patch', breaking: 3 })[0]).toContain(
      '3 BREAKING entries',
    );
    expect(shapeProblems({ ...base, bump: 'patch', breaking: 0 })).toEqual([]);
  });

  it('refuses a quiet minor unless the cutter says so', () => {
    const minor = { ...base, version: '0.10.0', bump: 'minor' as const };
    expect(shapeProblems({ ...minor, breaking: 0 })[0]).toContain('--allow-quiet-minor');
    expect(shapeProblems({ ...minor, breaking: 0, allowQuietMinor: true })).toEqual([]);
    expect(shapeProblems({ ...minor, breaking: 2 })).toEqual([]);
    expect(shapeProblems({ ...minor, bump: 'major', breaking: 0 })[0]).toContain('MAJOR release');
  });

  it('never reports when nothing is being cut, and reports a backwards version', () => {
    expect(shapeProblems({ ...base, bump: 'none', breaking: 5 })).toEqual([]);
    expect(shapeProblems({ ...base, bump: 'prerelease', breaking: 5 })).toEqual([]);
    expect(shapeProblems({ ...base, bump: 'backwards', breaking: 0 })).toEqual([
      '0.9.1 is not later than the previous release tag.',
    ]);
  });
});
