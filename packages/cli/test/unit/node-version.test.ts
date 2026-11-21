import { describe, expect, it } from 'vitest';
import { isSupportedNode, SUPPORTED_NODE } from '../../src/utils/node-version.ts';
import { readFile } from 'node:fs/promises';

describe('supported Node versions', () => {
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
