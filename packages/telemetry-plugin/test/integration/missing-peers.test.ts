import { describe, expect, it } from 'vitest';
import { OptionalDependencyUnavailableError } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { TelemetryPlugin } from '../../src/index.ts';

describe('missing telemetry peers', () => {
  it('propagates the SDK load refusal through registration and start', async () => {
    // This seam proves propagation, not import resolution. The real absent-peer
    // import was measured in an isolated bundle (M113l plan §12).
    const failure = new OptionalDependencyUnavailableError('@opentelemetry/sdk-trace-base');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        TelemetryPlugin({
          exporter: 'console',
          serviceName: 'missing-peer-test',
          tracerProviderFactory: () => Promise.reject(failure),
        }),
      ],
    });
    try {
      await expect(app.start()).rejects.toBe(failure);
    } finally {
      await app.stop();
    }
  });
});
