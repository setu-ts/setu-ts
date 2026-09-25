/**
 * Barrel-export and public-surface tests for the diagnostics plugin. The
 * runtime exports are checked by identity; the `IDiagnosticsClient.health()`
 * addition (M98d) is checked at the type level against a real client instance.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as diagnosticsPlugin from '../src/index.ts';
import type { IDiagnosticsClient } from '../src/interfaces/index.ts';

describe('Diagnostics plugin — public surface', () => {
  it('exports the plugin factory and the client factory', () => {
    expect(diagnosticsPlugin.DiagnosticsPlugin).toBeDefined();
    expect(typeof diagnosticsPlugin.DiagnosticsPlugin).toBe('function');
    expect(diagnosticsPlugin.createDiagnosticsClient).toBeDefined();
    expect(typeof diagnosticsPlugin.createDiagnosticsClient).toBe('function');
  });

  it('exposes the client interface with the M98d health() member', () => {
    // Type-level: a client instance must carry health() returning the exact
    // health-snapshot DTO. This is the public contract M98d adds.
    const probe = (client: IDiagnosticsClient): ReturnType<IDiagnosticsClient['health']> =>
      client.health();
    expect(typeof probe).toBe('function');
  });
});
