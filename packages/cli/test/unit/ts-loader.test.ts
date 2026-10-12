import { describe, expect, it } from 'vitest';
import { nearestTsconfig } from '../../src/utils/ts-loader.ts';

/** An `exists` seam over a fixed set of present paths, recording every probe. */
function probe(present: readonly string[]) {
  const asked: string[] = [];
  const set = new Set(present);
  return {
    asked,
    exists: (path: string) => {
      asked.push(path);
      return set.has(path);
    },
  };
}

describe('nearestTsconfig', () => {
  it('finds the tsconfig beside the module', () => {
    const { exists } = probe(['/app/tsconfig.json']);
    expect(nearestTsconfig('file:///app/setu.config.ts', '/app', exists))
      .toBe('/app/tsconfig.json');
  });

  it('walks up inside the project and prefers the closest one', () => {
    const { exists } = probe(['/repo/tsconfig.json', '/repo/apps/api/tsconfig.json']);
    expect(nearestTsconfig('file:///repo/apps/api/src/x.ts', '/repo', exists))
      .toBe('/repo/apps/api/tsconfig.json');
    expect(nearestTsconfig('file:///repo/libs/x/mod.ts', '/repo', exists))
      .toBe('/repo/tsconfig.json');
  });

  it('reaches a custom schematic project root two levels up', () => {
    const { exists } = probe(['/proj/tsconfig.json']);
    expect(nearestTsconfig('file:///proj/.setu-ts/schematics/x.ts', '/proj', exists))
      .toBe('/proj/tsconfig.json');
  });

  // M111d audit F2: a `tsconfig.json` is code routing — its `paths` decide which
  // file an `@setu-ts/*` import runs — so one planted ABOVE the project must
  // never be read, however many directories the walk would have to climb.
  it('never reads a tsconfig above the project root', () => {
    const { asked, exists } = probe(['/shared/tsconfig.json', '/tsconfig.json']);
    expect(nearestTsconfig('file:///shared/proj/setu.config.ts', '/shared/proj', exists))
      .toBe(false);
    expect(asked).toEqual(['/shared/proj/tsconfig.json']);
  });

  it('holds a module outside its root, or with no root, to its own directory', () => {
    const outside = probe(['/elsewhere/tsconfig.json', '/tsconfig.json']);
    expect(nearestTsconfig('file:///elsewhere/x/mod.ts', '/proj', outside.exists)).toBe(false);
    expect(outside.asked).toEqual(['/elsewhere/x/tsconfig.json']);

    const noRoot = probe(['/a/tsconfig.json']);
    expect(nearestTsconfig('file:///a/b/c.ts', undefined, noRoot.exists)).toBe(false);
    expect(noRoot.asked).toEqual(['/a/b/tsconfig.json']);
  });

  it('does not treat a sibling sharing the root as a prefix as inside it', () => {
    const { asked, exists } = probe(['/proj/tsconfig.json']);
    expect(nearestTsconfig('file:///proj-other/x.ts', '/proj', exists)).toBe(false);
    expect(asked).toEqual(['/proj-other/tsconfig.json']);
  });
});
