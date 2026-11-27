import { createSocket } from 'node:dgram';
import { describe, expect, it } from 'vitest';
import { createRuntimeServices } from '@setu-ts/runtime';
import { resolveOptions } from '../../src/options.ts';
import { createProvider } from '../../src/providers/provider-factory.ts';
import { isNameAbsent } from '../../src/providers/dns-provider.ts';

describe.skipIf(typeof Deno !== 'undefined')('chosen DNS server lookup bound', () => {
  it('rejects a silent local UDP server near the whole-lookup bound and records failure rather than absence', async () => {
    const stub = createSocket('udp4');
    let packets = 0;
    stub.on('message', () => {
      packets++;
    }); // deliberately never answer
    await new Promise<void>((resolve, reject) => {
      stub.once('error', reject);
      stub.bind(0, '127.0.0.1', resolve);
    });
    try {
      const runtime = await createRuntimeServices();
      const options = {
        provider: 'dns',
        mode: 'a',
        port: 9000,
        servers: [`127.0.0.1:${stub.address().port}`],
        resolveTimeoutMs: 100,
      } as const;
      const provider = createProvider(options, resolveOptions(options), runtime);
      const start = performance.now();
      const error: unknown = await provider.resolve('billing.invalid').then(
        () => {
          throw new Error('silent DNS server unexpectedly answered');
        },
        (failure: unknown) => failure,
      );
      const elapsed = performance.now() - start;
      expect(packets).toBeGreaterThan(0);
      expect(elapsed).toBeGreaterThanOrEqual(75);
      expect(elapsed).toBeLessThan(1000);
      expect(error).toBeInstanceOf(Error);
      expect(isNameAbsent(error)).toBe(false);
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
      expect(
        ((error as Error).cause as AggregateError).errors.map(
          (member: { code?: string }) => member.code,
        ),
      ).toEqual(['ETIMEOUT', 'ETIMEOUT']);
      await expect(provider.isHealthy()).rejects.toBe(error);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});
