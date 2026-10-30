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
  it('uses framework ranges except the reviewed OpenTelemetry compatibility bounds', () => {
    const otel: Readonly<Record<string, string>> = {
      '@opentelemetry/api': '~1.9.0',
      '@opentelemetry/sdk-trace-base': '^2.9.0',
      '@opentelemetry/resources': '^2.9.0',
      '@opentelemetry/context-async-hooks': '^2.0.0',
    };
    for (const [name, range] of Object.entries(otel)) expect(CLIENT_RANGES[name]).toBe(range);
    for (const [name, range] of Object.entries(CLIENT_RANGES)) {
      expect(otel[name] ?? EXTERNAL_RANGES[name], name).toBe(range);
    }
  });
});

describe('withClientDependencies', () => {
  const host = resolveHost(getTemplate('microservice')!, 'node');

  it('declares node-redis at the framework range for npm and Deno', () => {
    expect(CLIENT_RANGES['redis']).toBe(EXTERNAL_RANGES['redis']);
    const out = withClientDependencies(host, ['redis']);
    expect(out.extraDependencies['redis']).toBe('6.x');
    expect(out.extraImports['redis']).toBe('npm:redis@6.x');
  });

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
