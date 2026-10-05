import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { compileRealtimeDiagnosticsAlias } from '../../packages/common/src/diagnostics/realtime-observations.ts';
import { compileLabelAllowlist } from '../../packages/kernel/src/diagnostics/projection.ts';
import { isDisplayAlias } from '../../packages/diagnostics-plugin/src/protocol/protocol.ts';
import { compileCacheDiagnosticsAlias } from '../../packages/cache-plugin/src/diagnostics/cache-observations.ts';
import { compileConfigDiagnosticsPolicy } from '../../packages/config-plugin/src/diagnostics/provenance.ts';
import { compileHealthDiagnosticsPolicy } from '../../packages/health-plugin/src/diagnostics/health-observation-collector.ts';
import { compileQueueDiagnosticsPolicy } from '../../packages/queue-plugin/src/diagnostics/queue-observation-collector.ts';
import { compileEventsDiagnosticsPolicy } from '../../packages/events-plugin/src/diagnostics/event-observations.ts';
import { compileSchedulerDiagnostics } from '../../packages/scheduler-plugin/src/diagnostics/scheduler-observations.ts';
import { compileStorageDiagnosticsAlias } from '../../packages/storage-plugin/src/diagnostics/storage-observations.ts';
import { compileTraceDiagnosticsPolicy } from '../../packages/telemetry-plugin/src/diagnostics/span-observation-collector.ts';
import { compileAuthorizationDiagnosticsOptions } from '../../packages/auth-plugin/src/diagnostics/authorization-observation-collector.ts';
import { compileOutboundAlias } from '../../packages/sdk/src/diagnostics/outbound-http-observations.ts';

const validators: Readonly<Record<string, (alias: string) => unknown>> = {
  realtime: (alias) => compileRealtimeDiagnosticsAlias({ enabled: true, alias }),
  kernel: (alias) => compileLabelAllowlist([alias], 'plugins'),
  protocol: (alias) => {
    if (!isDisplayAlias(alias)) throw new Error('invalid');
  },
  cache: (alias) => compileCacheDiagnosticsAlias({ enabled: true, alias }),
  config: (alias) => compileConfigDiagnosticsPolicy({ enabled: true, keys: { key: alias } }),
  health: (alias) => compileHealthDiagnosticsPolicy({ enabled: true, indicators: { key: alias } }),
  queue: (alias) =>
    compileQueueDiagnosticsPolicy({ enabled: true, instanceAlias: alias, queues: { key: alias } }),
  events: (alias) =>
    compileEventsDiagnosticsPolicy({ enabled: true, alias, events: { key: alias } }),
  scheduler: (alias) => compileSchedulerDiagnostics({ enabled: true, alias, jobs: { key: alias } }),
  storage: (alias) => compileStorageDiagnosticsAlias({ enabled: true, alias }),
  trace: (alias) =>
    compileTraceDiagnosticsPolicy({
      enabled: true,
      serviceAlias: alias,
      operations: { key: alias },
    }),
  authorization: (alias) =>
    compileAuthorizationDiagnosticsOptions({
      enabled: true,
      roles: { key: alias },
      permissions: {},
    }),
  sdk: compileOutboundAlias,
};

describe('all diagnostics alias boundaries agree', () => {
  for (const [name, validate] of Object.entries(validators)) {
    it(name, () => {
      for (const value of ['plain', 'é'.repeat(20)]) expect(() => validate(value)).not.toThrow();
      for (
        const code of [
          0,
          31,
          127,
          159,
          0x200b,
          0x200e,
          0x202a,
          0x202b,
          0x202c,
          0x202d,
          0x202e,
          0x2066,
          0x2067,
          0x2068,
          0x2069,
          0xfeff,
          0xad,
        ]
      ) {
        expect(() => validate(`a${String.fromCodePoint(code)}b`)).toThrow();
      }
    });
  }
});
