import { describe, expect, it } from 'vitest';
import { nearestTsconfig } from '../../src/utils/ts-loader.ts';

describe('nearestTsconfig', () => {
  it('finds the tsconfig beside the module', () => {
    const present = new Set(['/app/tsconfig.json']);
    expect(nearestTsconfig('file:///app/setu.config.ts', (p) => present.has(p)))
      .toBe('/app/tsconfig.json');
  });

  it('walks up to the nearest ancestor and prefers the closest one', () => {
    const present = new Set(['/repo/tsconfig.json', '/repo/apps/api/tsconfig.json']);
    expect(nearestTsconfig('file:///repo/apps/api/src/x.ts', (p) => present.has(p)))
      .toBe('/repo/apps/api/tsconfig.json');
    expect(nearestTsconfig('file:///repo/libs/x/mod.ts', (p) => present.has(p)))
      .toBe('/repo/tsconfig.json');
  });

  it('answers false when no tsconfig exists above the module, never an ambient one', () => {
    const asked: string[] = [];
    expect(nearestTsconfig('file:///a/b/c.ts', (p) => {
      asked.push(p);
      return false;
    })).toBe(false);
    expect(asked).toEqual(['/a/b/tsconfig.json', '/a/tsconfig.json', '/tsconfig.json']);
  });
});
