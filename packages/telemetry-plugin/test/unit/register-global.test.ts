/* eslint-disable require-await -- Test doubles preserve asynchronous provider and service contracts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '@opentelemetry/api';
import * as sdk from '@opentelemetry/sdk-trace-base';
import * as resources from '@opentelemetry/resources';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, ITelemetryService } from '@setu-ts/common';
import { TelemetryPlugin } from '../../src/plugin/telemetry-plugin.ts';
import { buildTracerHost, setOtelApi } from '../../src/tracing/tracer.ts';
import type { OtelSdkModule, OtelResourcesModule } from '../../src/tracing/tracer.ts';

afterEach(() => {
  api.trace.disable();
  api.context.disable();
  setOtelApi(null);
  vi.restoreAllMocks();
});

function setup(registerGlobal?: boolean, serviceName = 'global-test') {
  const exporter = new sdk.InMemorySpanExporter();
  const warn = vi.fn();
  api.context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  setOtelApi(api);
  const host = buildTracerHost({
    sdkMod: sdk as unknown as OtelSdkModule,
    resourcesMod: resources as unknown as OtelResourcesModule,
    pluginOptions: { exporter: 'console', serviceName },
    contextActivation: true,
    consoleExporterCtor: class {
      constructor() {
        return exporter;
      }
    },
  });
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      {
        name: 'logger',
        version: '1.0.0',
        provides: [CAPABILITIES.LOGGER],
        register(ctx) {
          ctx.services.register(CAPABILITIES.LOGGER, {
            warn,
            debug() {},
            child() {
              return this;
            },
          } as unknown as ILogger);
        },
      },
      TelemetryPlugin({
        exporter: 'console',
        middleware: false,
        tracerProviderFactory: async () => host,
        ...(registerGlobal === undefined ? {} : { registerGlobal }),
      }),
    ],
  });
  return { app, host, exporter, warn };
}

describe('TelemetryPlugin registerGlobal', () => {
  it("keeps a second app's library spans on the first exporter and drops them after it stops (F4)", async () => {
    const first = setup(true, 'first-app');
    const second = setup(true, 'second-app');
    await first.app.start();
    await second.app.start();
    try {
      const service = second.app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
      await service.withSpan('second-request', async () => {
        api.trace.getTracer('library').startSpan('second-library').end();
      });
      await first.host.forceFlush();
      await second.host.forceFlush();
      const [library] = first.exporter.getFinishedSpans();
      expect(library?.name).toBe('second-library');
      expect(library?.resource.attributes['service.name']).toBe('first-app');
      expect(second.exporter.getFinishedSpans().map((span) => span.name)).toEqual([
        'second-request',
      ]);
      expect(second.warn.mock.calls[0]?.[0]).toContain("first app's exporter and service.name");
      await first.app.stop();
      const afterStop = first.exporter.getFinishedSpans().length;
      await service.withSpan('second-request-after-stop', async () => {
        api.trace.getTracer('library').startSpan('dropped-library').end();
      });
      await second.host.forceFlush();
      expect(first.exporter.getFinishedSpans()).toHaveLength(afterStop);
      expect(second.exporter.getFinishedSpans().map((span) => span.name)).toEqual([
        'second-request',
        'second-request-after-stop',
      ]);
    } finally {
      await second.app.stop();
      await first.app.stop();
    }
  });
  it('leaves the global provider untouched by default', async () => {
    const setGlobal = vi.spyOn(api.trace, 'setGlobalTracerProvider');
    const { app } = setup();
    await app.start();
    try {
      expect(setGlobal).not.toHaveBeenCalled();
    } finally {
      await app.stop();
    }
  });

  it('exports global-tracer spans parented under the active withSpan span', async () => {
    const { app, host, exporter } = setup(true);
    await app.start();
    try {
      const service = app.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
      await service.withSpan('request', async () => {
        api.trace.getTracer('library').startSpan('library-call').end();
      });
      await host.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans.map((span) => span.name).sort()).toEqual(['library-call', 'request']);
      const child = spans.find((span) => span.name === 'library-call')!;
      const parent = spans.find((span) => span.name === 'request')!;
      expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
      expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    } finally {
      await app.stop();
    }
  });

  it('warns once for refused registration and retains the private provider', async () => {
    api.trace.setGlobalTracerProvider(new sdk.BasicTracerProvider());
    const { app, host, exporter, warn } = setup(true);
    await app.start();
    try {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('registration refused');
      expect(warn.mock.calls[0]?.[0]).toContain("first app's exporter and service.name");
      expect(warn.mock.calls[0]?.[0]).toContain('dropped after it stops');
      expect(warn.mock.calls[0]?.[0]).toContain("Only this app's own spans");
      await app.services
        .get<ITelemetryService>(CAPABILITIES.TELEMETRY)
        .withSpan('private', async () => {});
      await host.forceFlush();
      expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['private']);
    } finally {
      await app.stop();
    }
  });
});
