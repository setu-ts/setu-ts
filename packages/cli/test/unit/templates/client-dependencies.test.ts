/**
 * Tests for the client packages a selected transport adds to a project.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { EXTERNAL_RANGES } from '../../../../../scripts/node-dependency-ranges.ts';
import {
  CLIENT_RANGES,
  withClientDependencies,
} from '../../../src/templates/client-dependencies.ts';
import { resolveHost } from '../../../src/templates/project-files.ts';
import { getTemplate } from '../../../src/templates/registry.ts';

describe('CLIENT_RANGES', () => {
  // A project installs the client the plugin will `import()`; a range outside
  // the plugin's own peer range is a version the plugin was never built against.
  it('pins every client at exactly the range the framework declares for it', () => {
    for (const [name, range] of Object.entries(CLIENT_RANGES)) {
      expect(EXTERNAL_RANGES[name], name).toBe(range);
    }
  });
});

describe('withClientDependencies', () => {
  const host = resolveHost(getTemplate('microservice')!, 'node');

  it('returns the host itself when nothing is selected', () => {
    expect(withClientDependencies(host, [])).toBe(host);
  });

  it('declares each client for both manifest kinds, keeping what the host had', () => {
    const seeded = { ...host, extraDependencies: { kept: '1' }, extraImports: { kept: 'x' } };
    const out = withClientDependencies(seeded, ['ioredis', 'amqplib']);
    expect(out.extraDependencies).toEqual({ kept: '1', ioredis: '5.x', amqplib: '0.10.x' });
    expect(out.extraImports).toEqual({
      kept: 'x',
      ioredis: 'npm:ioredis@5.x',
      amqplib: 'npm:amqplib@0.10.x',
    });
    // The input is not mutated.
    expect(seeded.extraDependencies).toEqual({ kept: '1' });
  });

  it('refuses a client it has no range for, naming the table to extend', () => {
    expect(() => withClientDependencies(host, ['left-pad'])).toThrow(
      'No client range for left-pad; add it to CLIENT_RANGES.',
    );
  });
});
