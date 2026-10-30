import { describe, expect, it } from 'vitest';
import type { IFileSystem, IPluginContext } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '../../../src/index.ts';
import { createFakeRuntime, createFakeHttp } from '../../fixtures/fakes.ts';

describe('Kubernetes token startup guidance (V10-44)', () => {
  for (const present of [false, true]) {
    for (const explicit of [false, true]) {
      for (const logger of [false, true]) {
        it(`file=${present}, explicit=${explicit}, logger=${logger}`, async () => {
          const stats: string[] = [];
          const warnings: string[] = [];
          const fs = {
            stat: (path: string) => {
              stats.push(path);
              return present
                ? Promise.resolve({ isFile: true, isDirectory: false, size: 1 })
                : Promise.reject(new Error('ENOENT'));
            },
          } as IFileSystem;
          let health: (() => Promise<unknown>) | undefined;
          const ctx = {
            runtime: createFakeRuntime({ fs }),
            services: { register: () => {} },
            health: {
              register: (_name: string, check: () => Promise<unknown>) => {
                health = check;
              },
            },
            lifecycle: { onClose: () => {}, onBootstrap: () => {}, onStopping: () => {} },
            ...(logger ? { logger: { warn: (message: string) => warnings.push(message) } } : {}),
          } as unknown as IPluginContext;
          await ServiceDiscoveryPlugin({
            provider: 'kubernetes',
            namespace: 'default',
            apiServer: 'https://API_SERVER_CANARY.invalid',
            http: createFakeHttp(),
            ...(explicit ? { token: 'TOKEN_CANARY' } : {}),
          }).register(ctx);
          expect(stats).toEqual(
            explicit ? [] : ['/var/run/secrets/kubernetes.io/serviceaccount/token'],
          );
          expect(warnings).toHaveLength(!present && !explicit && logger ? 1 : 0);
          for (const message of warnings) {
            expect(message).toContain('token');
            expect(message).toContain('apiServer');
            expect(message).not.toContain('CANARY');
          }
          // Live probes do not repeat the startup warning or stat.
          await health?.();
          await health?.();
          expect(stats).toHaveLength(explicit ? 0 : 1);
          expect(warnings).toHaveLength(!present && !explicit && logger ? 1 : 0);
        });
      }
    }
  }

  it('does not give the outside-a-pod warning for a stat failure other than a missing file', async () => {
    const warnings: string[] = [];
    const fs = {
      stat: () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' })),
    } as unknown as IFileSystem;
    const ctx = {
      runtime: createFakeRuntime({ fs }),
      services: { register: () => {} },
      health: { register: () => {} },
      lifecycle: { onClose: () => {}, onBootstrap: () => {}, onStopping: () => {} },
      logger: { warn: (message: string) => warnings.push(message) },
    } as unknown as IPluginContext;
    await ServiceDiscoveryPlugin({
      provider: 'kubernetes',
      namespace: 'default',
      apiServer: 'https://api.invalid',
      http: createFakeHttp(),
    }).register(ctx);
    expect(warnings).toEqual([]);
  });
});
