import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { DiagnosticsEdge, DiagnosticsNode } from '@setu-ts/common';

import {
  applySnapshotBudget,
  approvedLabel,
  boundedPluginVersion,
  compileLabelAllowlist,
  compileLabelAllowlists,
  MAX_LABEL_BYTES,
  MAX_SNAPSHOT_BYTES,
  monotonicElapsed,
  projectHttpMethod,
  saturatingNext,
} from '../../src/diagnostics/projection.ts';

describe('compileLabelAllowlist', () => {
  it('compiles an exact-match set', () => {
    const compiled = compileLabelAllowlist(['api', 'GET /users'], 'routes');
    expect(compiled.has('api')).toBe(true);
    expect(compiled.has('GET /users')).toBe(true);
    expect(compiled.has('ap')).toBe(false);
  });

  it('compiles an absent list to an empty set', () => {
    expect(compileLabelAllowlist(undefined, 'plugins').size).toBe(0);
  });

  it('refuses more than 256 entries with a value-free error', () => {
    const entries = Array.from({ length: 257 }, (_, i) => `label-${i}`);
    expect(() => compileLabelAllowlist(entries, 'plugins')).toThrow(RangeError);
    let message = '';
    try {
      compileLabelAllowlist(entries, 'plugins');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('more than 256 entries');
    expect(message).not.toContain('label-256');
  });

  it('refuses an entry over the 160-byte bound without naming it', () => {
    const long = 'x'.repeat(MAX_LABEL_BYTES + 1);
    expect(() => compileLabelAllowlist([long], 'routes')).toThrow(/160-byte bound/);
    try {
      compileLabelAllowlist([long], 'routes');
    } catch (error) {
      expect((error as Error).message).not.toContain(long);
    }
  });

  it('refuses control characters without naming the entry', () => {
    try {
      compileLabelAllowlist(['bad\u0000label'], 'routes');
      throw new Error('unreachable');
    } catch (error) {
      expect(error).toBeInstanceOf(RangeError);
      expect((error as Error).message).toContain('control character');
      expect((error as Error).message).not.toContain('bad');
    }
  });

  it('counts UTF-8 bytes, not characters', () => {
    // 80 two-byte characters = 160 bytes: exactly at the bound.
    expect(() => compileLabelAllowlist(['é'.repeat(80)], 'routes')).not.toThrow();
    expect(() => compileLabelAllowlist(['é'.repeat(81)], 'routes')).toThrow(RangeError);
  });
});

describe('compileLabelAllowlists', () => {
  it('compiles every family from an options object', () => {
    const allowlists = compileLabelAllowlists({
      labels: {
        plugins: ['api'],
        capabilities: ['database'],
        routes: ['GET /users'],
        middleware: ['auth'],
      },
    });
    expect(allowlists.plugins.has('api')).toBe(true);
    expect(allowlists.capabilities.has('database')).toBe(true);
    expect(allowlists.routes.has('GET /users')).toBe(true);
    expect(allowlists.middleware.has('auth')).toBe(true);
  });

  it('compiles all-empty lists for absent options', () => {
    const allowlists = compileLabelAllowlists(undefined);
    expect(allowlists.plugins.size).toBe(0);
    expect(allowlists.capabilities.size).toBe(0);
    expect(allowlists.routes.size).toBe(0);
    expect(allowlists.middleware.size).toBe(0);
  });
});

describe('approvedLabel', () => {
  it('answers the candidate itself only on exact membership', () => {
    const allowlist = compileLabelAllowlist(['GET /users'], 'routes');
    expect(approvedLabel(allowlist, 'GET /users')).toBe('GET /users');
    expect(approvedLabel(allowlist, 'GET /users/1')).toBeUndefined();
    expect(approvedLabel(allowlist, '')).toBeUndefined();
  });
});

describe('projectHttpMethod', () => {
  it('projects the seven supported verbs and omits anything else', () => {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      expect(projectHttpMethod(method)).toBe(method);
    }
    expect(projectHttpMethod('TRACE')).toBeUndefined();
    expect(projectHttpMethod('get')).toBeUndefined();
  });
});

describe('boundedPluginVersion', () => {
  it('accepts plain and suffixed semver within the bound', () => {
    expect(boundedPluginVersion('1.2.3')).toBe('1.2.3');
    expect(boundedPluginVersion('0.7.0-alpha.1')).toBe('0.7.0-alpha.1');
    expect(boundedPluginVersion('1.0.0+build.5')).toBe('1.0.0+build.5');
  });

  it('omits anything that is not bounded semver', () => {
    expect(boundedPluginVersion('')).toBeUndefined();
    expect(boundedPluginVersion('v1.2.3')).toBeUndefined();
    expect(boundedPluginVersion('1.2')).toBeUndefined();
    expect(boundedPluginVersion('not a version')).toBeUndefined();
    expect(boundedPluginVersion('1.2.3-'.padEnd(80, 'x'))).toBeUndefined();
  });
});

describe('saturatingNext', () => {
  it('advances normally and returns null at saturation', () => {
    expect(saturatingNext(0)).toBe(1);
    expect(saturatingNext(41)).toBe(42);
    expect(saturatingNext(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe('monotonicElapsed', () => {
  it('computes inclusive elapsed time from a monotonic clock', () => {
    let current = 100;
    const clock = () => current;
    expect(monotonicElapsed(clock, 40)).toBe(60);
    current = 105;
    expect(monotonicElapsed(clock, 40)).toBe(65);
  });

  it('answers null for a null start or a null clock reading', () => {
    expect(monotonicElapsed(() => 5, null)).toBeNull();
    expect(monotonicElapsed(() => null, 5)).toBeNull();
  });
});

describe('applySnapshotBudget', () => {
  const scalar = {
    instanceId: 'u' as string | null,
    state: 'running' as const,
    failureCode: null,
    droppedEvents: 0,
  };
  const node = (id: string): DiagnosticsNode => ({ id, kind: 'plugin' });
  const edge = (from: string, to: string): DiagnosticsEdge => ({
    from,
    to,
    kind: 'owns',
  });

  it('returns the DTO unchanged when it fits the budget', () => {
    const snapshot = applySnapshotBudget(scalar, [node('p1')], [edge('p1', 'p1')], false);
    expect(snapshot.nodes.length).toBe(1);
    expect(snapshot.edges.length).toBe(1);
    expect(snapshot.truncated).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length)
      .toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
  });

  it('omits later entries and their edges, setting truncated, until it fits', () => {
    // A label of 160 bytes per node blows the 256 KiB budget long before the
    // trim converges — exactly the hostile shape the budget exists for.
    const bigLabel = 'y'.repeat(160);
    const nodes = Array.from({ length: 3_000 }, (_, i) => ({
      id: `p${i}`,
      kind: 'plugin' as const,
      label: bigLabel,
    }));
    const edges = Array.from({ length: 2_999 }, (_, i) => edge(`p${i}`, `p${i + 1}`));
    const snapshot = applySnapshotBudget(scalar, nodes, edges, false);
    const encodedLength = new TextEncoder().encode(JSON.stringify(snapshot)).length;
    expect(encodedLength).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.length).toBeLessThan(3_000);
    // Every retained edge still names two retained nodes.
    const ids = new Set(snapshot.nodes.map((n) => n.id));
    expect(snapshot.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
  });

  it('keeps scalar members intact through the trim', () => {
    const nodes = Array.from({ length: 4_000 }, (_, i) => ({
      id: `p${i}`,
      kind: 'capability' as const,
      label: 'z'.repeat(160),
    }));
    const snapshot = applySnapshotBudget(
      { instanceId: 'uuid-9', state: 'failed', failureCode: 'startup-failed', droppedEvents: 7 },
      nodes,
      [],
      false,
    );
    expect(snapshot.instanceId).toBe('uuid-9');
    expect(snapshot.state).toBe('failed');
    expect(snapshot.failureCode).toBe('startup-failed');
    expect(snapshot.droppedEvents).toBe(7);
    expect(snapshot.version).toBe(1);
  });
});
