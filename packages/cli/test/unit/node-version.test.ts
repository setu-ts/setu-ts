import { describe, expect, it } from 'vitest';
import {
  isSupportedNode,
  SUPPORTED_NODE,
  HARD_FLOOR_NODE,
  isNodeBelowFloor,
  nodeFloorRefusal,
} from '../../src/utils/node-version.ts';
import { readFile } from 'node:fs/promises';

describe('supported Node versions', () => {
  it.each(['../../README.md', '../../../../docs/cli.md', '../../../create/README.md'])(
    'V13-166 documents the hard floor alongside the supported range in %s',
    async (path) => {
      const source = await readFile(new URL(path, import.meta.url), 'utf8');
      const paragraphs = source.split(/\n\s*\n/).map((paragraph) => paragraph.replace(/\s+/g, ' '));
      const ranges = paragraphs.filter((paragraph) => paragraph.includes('22.23.4'));
      expect(ranges.length).toBeGreaterThan(0);
      for (const paragraph of ranges) {
        expect(paragraph).toContain(`Node ${HARD_FLOOR_NODE}`);
        expect(paragraph).toContain('24.22.1');
        expect(paragraph).toContain('26.12.1');
      }
      if (path === '../../README.md') {
        expect(source.replace(/\s+/g, ' ')).toMatch(/[Bb]elow Node 22\.9\.0.*refuses.*exit `1`/);
        expect(source.replace(/\s+/g, ' ')).toMatch(
          /at or above Node 22\.9\.0.*outside.*warning.*continues/,
        );
      }
    },
  );

  it.each<readonly [Readonly<Record<string, string | undefined>>, boolean, boolean]>([
    [{ node: '18.20.8' }, false, true],
    [{ node: '20.20.2' }, false, true],
    [{ node: '21.7.3' }, false, true],
    [{ node: '22.8.0' }, false, true],
    [{ node: '22.9.0' }, false, false],
    [{ node: '22.12.0' }, false, false],
    [{ node: '22.23.4' }, false, false],
    [{ node: '24.22.1' }, false, false],
    [{ node: '26.12.1' }, false, false],
    [{ node: '27.0.0' }, false, false],
    [{ node: '24.22.1-rc.1' }, false, false],
    [{ node: '18.20.8', bun: '1.4.5' }, false, false],
    [{ node: '18.20.8', bun: '' }, false, false],
    [{ node: '18.20.8', bun: undefined }, false, true],
    [{ node: '18.20.8' }, true, false],
    [{ bun: '1.4.5' }, false, false],
    [{}, false, false],
  ])('selects the shared floor refusal for %j, Deno %s', (versions, isDeno, refuses) => {
    expect(nodeFloorRefusal(versions, isDeno)).toBe(
      refuses
        ? `setu needs Node 22.9.0 or newer; this is Node ${versions.node}. Supported: ^22.23.4 || ^24.22.1 || >=26.12.1.`
        : undefined,
    );
  });

  it('publishes the dependency-free helper through matching Node and Deno subpaths', async () => {
    const npm: { exports: Record<string, unknown> } = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const deno: { exports: Record<string, unknown> } = JSON.parse(
      await readFile(new URL('../../deno.json', import.meta.url), 'utf8'),
    );
    expect(npm.exports['./node-version']).toEqual({
      types: './dist/utils/node-version.d.ts',
      default: './dist/utils/node-version.js',
    });
    expect(deno.exports['./node-version']).toBe('./src/utils/node-version.ts');
  });
  it.each([
    ['18.20.8', true],
    ['20.20.2', true],
    ['21.7.3', true],
    ['22.8.0', true],
    ['22.9.0', false],
    ['22.12.0', false],
    ['22.23.4', false],
    ['24.22.1', false],
    ['26.12.1', false],
    ['22.9.1', false],
    ['24.22.1-rc.1', false],
    ['22.8.0-nightly', true],
    ['unrecognized', false],
  ])('refuses %s only below the measured hard floor', (version, below) => {
    expect(HARD_FLOOR_NODE).toBe('22.9.0');
    expect(isNodeBelowFloor(version)).toBe(below);
  });
  it('keeps the supported range equal to both executable manifests', async () => {
    for (const path of ['../../package.json', '../../../create/package.json']) {
      const manifest: { engines: { node: string } } = JSON.parse(
        await readFile(new URL(path, import.meta.url), 'utf8'),
      );
      expect(SUPPORTED_NODE).toBe(manifest.engines.node);
    }
  });

  it.each([
    ['garbage', false],
    ['22.23', false],
    ['24.22.1-rc.1', false],
    ['22.24.0', true],
    ['24.23.0', true],
    ['26.13.0', true],
    ['25.99.99', false],
    ['26.11.99', false],
    ['22.23.3', false],
  ])('matches the declared range for %s', (version, supported) => {
    expect(isSupportedNode(version)).toBe(supported);
  });
});
