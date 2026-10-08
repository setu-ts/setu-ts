/**
 * M107 §3.9 — `root: true` starts a parentless span on the REAL OTel SDK.
 *
 * The host's `startSpan` is driven against the real `@opentelemetry/api`,
 * `sdk-trace-base` and the `AsyncLocalStorageContextManager`, with an
 * in-memory exporter, so the parent relation asserted is the one OTel itself
 * recorded. Each root case has a control that omits `root` under the same
 * active span and must parent to it — without that control a host that never
 * parents anything would pass.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TELEMETRY_CONTEXT_OPAQUE } from '@setu-ts/common';
import type { TracerHost } from '../../src/interfaces/index.ts';
import {
  loadAsyncLocalStorageContextManager,
  registerContextManager,
} from '../../src/tracing/context-manager.ts';
import { buildTracerHost, setOtelApi } from '../../src/tracing/tracer.ts';
import type { OtelResourcesModule, OtelSdkModule } from '../../src/tracing/tracer.ts';

import * as api from 'npm:@opentelemetry/api@^1.9.0';
import * as sdk from 'npm:@opentelemetry/sdk-trace-base@^2.9.0';
import * as resources from 'npm:@opentelemetry/resources@^2.9.0';

/** A finished span as the in-memory exporter reports it (SDK 2.x shape). */
interface FinishedSpan {
  readonly name: string;
  spanContext(): { traceId: string; spanId: string };
  readonly parentSpanContext?: { traceId: string; spanId: string };
}

const exporter = new sdk.InMemorySpanExporter();
let host: TracerHost;

beforeAll(async () => {
  setOtelApi(api as unknown as Parameters<typeof setOtelApi>[0]);
  const outcome = await registerContextManager(
    api.context as unknown as Parameters<typeof registerContextManager>[0],
    loadAsyncLocalStorageContextManager,
  );
  // Without a registered manager nothing is ever active, and the controls
  // below would be parentless for the wrong reason.
  expect(outcome.activated).toBe(true);
  host = buildTracerHost({
    sdkMod: sdk as unknown as OtelSdkModule,
    resourcesMod: resources as unknown as OtelResourcesModule,
    pluginOptions: { serviceName: 'span-root-test', exporter: 'console' },
    // The exporter seam: hand the processor the shared in-memory exporter.
    consoleExporterCtor: function () {
      return exporter;
    } as never,
    validated: true,
    contextActivation: true,
  });
});

afterAll(async () => {
  await host.shutdown();
  setOtelApi(null);
});

/** Starts `parent`, runs `inner` with it active, ends everything, returns spans by name. */
async function underActiveParent(
  inner: () => void,
): Promise<Map<string, FinishedSpan>> {
  exporter.reset();
  const parent = host.startSpan('parent') as { end(): void };
  await host.activate!(parent, () => {
    inner();
    return Promise.resolve();
  });
  parent.end();
  const spans = exporter.getFinishedSpans() as unknown as FinishedSpan[];
  return new Map(spans.map((span) => [span.name, span]));
}

/** Starts and immediately ends a span through the host. */
function startAndEnd(name: string, options?: Parameters<TracerHost['startSpan']>[1]): void {
  (host.startSpan(name, options) as { end(): void }).end();
}

describe('TracerHost.startSpan — root (real SDK)', () => {
  it('root: true ignores the active span; omitting it parents to that span', async () => {
    const spans = await underActiveParent(() => {
      startAndEnd('rooted', { root: true });
      startAndEnd('control');
    });
    const parent = spans.get('parent')!;
    const rooted = spans.get('rooted')!;
    const control = spans.get('control')!;
    expect(parent).toBeDefined();

    // Control: the active span IS the parent when root is omitted.
    expect(control.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(control.spanContext().traceId).toBe(parent.spanContext().traceId);

    // Root: no parent, and a new trace.
    expect(rooted.parentSpanContext).toBeUndefined();
    expect(rooted.spanContext().traceId).not.toBe(parent.spanContext().traceId);
  });

  it('root: true also ignores a parentContext that carries both ids', async () => {
    const parentContext = {
      _opaque: TELEMETRY_CONTEXT_OPAQUE,
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
      traceFlags: '01',
    } as const;
    const spans = await underActiveParent(() => {
      startAndEnd('rooted', { parentContext, root: true });
      startAndEnd('control', { parentContext });
    });
    const rooted = spans.get('rooted')!;
    const control = spans.get('control')!;

    // Control: the stored context parents the span when root is omitted.
    expect(control.parentSpanContext?.spanId).toBe(parentContext.spanId);
    expect(control.spanContext().traceId).toBe(parentContext.traceId);

    expect(rooted.parentSpanContext).toBeUndefined();
    expect(rooted.spanContext().traceId).not.toBe(parentContext.traceId);
    expect(rooted.spanContext().traceId).not.toBe(spans.get('parent')!.spanContext().traceId);
  });
});
