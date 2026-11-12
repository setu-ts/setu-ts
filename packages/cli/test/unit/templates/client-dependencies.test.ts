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
import { SWAGGER_UI_DIST_VERSION } from '../../../src/templates/swagger-version.ts';
import { readFile } from 'node:fs/promises';
import { ADDABLE, BACKEND_PEERS } from '../../../src/commands/add.ts';

describe('CLIENT_RANGES', () => {
  it('V12-27 backend peer ranges equal each owning plugin manifest', async () => {
    for (const [pkg, backend] of Object.entries(BACKEND_PEERS)) {
      const manifest = JSON.parse(
        await readFile(new URL(`../../../../${pkg}/package.json`, import.meta.url), 'utf8'),
      ) as { peerDependencies: Record<string, string> };
      for (const peer of new Set(Object.values(backend.arms).flat()))
        expect(CLIENT_RANGES[peer], `${pkg}: ${peer}`).toBe(manifest.peerDependencies[peer]);
    }
  });
  it('graphql and grpc peer ranges equal each owning plugin manifest', async () => {
    for (const pkg of ['graphql-plugin', 'grpc-plugin']) {
      const manifest = JSON.parse(
        await readFile(new URL(`../../../../${pkg}/package.json`, import.meta.url), 'utf8'),
      ) as { peerDependencies: Record<string, string> };
      const entry = [...ADDABLE.values()].find((addable) => addable.pkg === pkg);
      expect(entry?.peers?.packages.length, pkg).toBeGreaterThan(0);
      for (const peer of entry?.peers?.packages ?? [])
        expect(CLIENT_RANGES[peer], `${pkg}: ${peer}`).toBe(manifest.peerDependencies[peer]);
    }
  });
  // A project installs the client the plugin will `import()`; a range outside
  // the plugin's own peer range is a version the plugin was never built against.
  it('uses framework ranges except reviewed OpenTelemetry bounds and the Swagger integrity pin', () => {
    const otel: Readonly<Record<string, string>> = {
      'drizzle-kit': '^0.31.11',
      prisma: '^7.10.0',
      '@opentelemetry/api': '~1.9.0',
      '@opentelemetry/sdk-trace-base': '^2.9.0',
      '@opentelemetry/resources': '^2.9.0',
      '@opentelemetry/context-async-hooks': '^2.0.0',
      // The ESM loader hook the generated preload registers (M131a X88-4). Not
      // a framework dependency: on the line of the instrumentations' own.
      '@opentelemetry/instrumentation': '^0.220.0',
    };
    for (const [name, range] of Object.entries(otel)) expect(CLIENT_RANGES[name]).toBe(range);
    expect(CLIENT_RANGES['swagger-ui-dist']).toBe(SWAGGER_UI_DIST_VERSION);
    for (const [name, range] of Object.entries(CLIENT_RANGES)) {
      expect(
        name === 'swagger-ui-dist'
          ? SWAGGER_UI_DIST_VERSION
          : (otel[name] ?? EXTERNAL_RANGES[name]),
        name,
      ).toBe(range);
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
