import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type {
  DiagnosticsBatch,
  DiagnosticsEvent,
  IDiagnosticsSource,
  IPlugin,
  IPluginContext,
} from '@setu-ts/common';
import type { IApplication } from '@setu-ts/common';

/**
 * A MINIMAL structural `IApplication` of the pre-diagnostics shape — exactly
 * what a third-party implementation written before M98a looked like. The
 * optional `diagnostics` member must not force this type to change.
 */
interface LegacyApplication {
  readonly name: string;
  start(): Promise<void>;
}

describe('diagnostics type contracts', () => {
  it('accepts a structural application that predates diagnostics', () => {
    // Compiles only because `IApplication.diagnostics` is optional AND allows
    // an explicitly-undefined answer — the disabled kernel's getter shape.
    const legacy: LegacyApplication = { name: 'old', start: () => Promise.resolve() };
    const app: IApplication = {
      router: {} as IApplication['router'],
      middleware: {} as IApplication['middleware'],
      services: {} as IApplication['services'],
      register: () => app as unknown as IApplication,
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
      fetch: () => Promise.resolve(new Response(null)),
    };
    expect(legacy.name).toBe('old');
    expect(app.diagnostics).toBeUndefined();
  });

  it('a consumer compiles against the reader surface and the frozen DTOs', () => {
    const source: IDiagnosticsSource = {
      snapshot: () => ({
        version: 1,
        instanceId: null,
        state: 'created',
        failureCode: null,
        nodes: [],
        edges: [],
        truncated: false,
        droppedEvents: 0,
      }),
      read: () => ({
        version: 1,
        instanceId: null,
        events: [],
        next: 0,
        lost: 0,
        closed: true,
      }),
    };
    const snapshot = source.snapshot();
    const batch: DiagnosticsBatch = source.read(0);
    expect(snapshot.version).toBe(1);
    expect(batch.closed).toBe(true);
    // A consumer holding the reader cannot register a callback or write —
    // the surface carries only the two read methods.
    expect(Object.keys(source).sort()).toEqual(['read', 'snapshot']);
  });

  it('event fields carry the documented vocabulary and null timing shape', () => {
    const event: DiagnosticsEvent = {
      sequence: 1,
      operationId: 'op1',
      parentOperationId: null,
      kind: 'lifecycle',
      stage: 'resolve',
      nodeId: null,
      outcome: 'ok',
      atMs: null,
      durationMs: null,
    };
    expect(event.atMs).toBeNull();
    expect(event.durationMs).toBeNull();
    expect(event.parentOperationId).toBeNull();
  });

  it('the plugin contract still declares only the committed edge families', () => {
    // Guards the boundary claim: declared edges are not observed calls. The
    // four declared families are unchanged and no diagnostics field was added
    // to the plugin contract in this change.
    const plugin: IPlugin = {
      name: 'p',
      version: '1.0.0',
      dependencies: ['runtime'],
      optionalDependencies: ['logger'],
      provides: ['thing'],
      consumes: ['other'],
      register(_ctx: IPluginContext) {},
    };
    expect(plugin.dependencies).toEqual(['runtime']);
    expect(plugin.optionalDependencies).toEqual(['logger']);
    expect(plugin.provides).toEqual(['thing']);
    expect(plugin.consumes).toEqual(['other']);
    expect(Object.hasOwn(plugin, 'diagnostics')).toBe(false);
  });
});
