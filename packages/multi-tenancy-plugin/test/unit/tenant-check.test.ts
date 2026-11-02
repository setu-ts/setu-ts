/**
 * The shared tenant check (M127 §3.3): each numbered branch, the length cap,
 * malformed answers, and the warn-once / info-on-recovery log sequence.
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { TenantRegistryUnavailableError } from '../../src/errors.ts';
import {
  MAX_TENANT_ID_LENGTH,
  REGISTRY_FAULT_LOG,
  REGISTRY_RECOVERED_LOG,
  TenantCheck,
} from '../../src/registry/tenant-check.ts';

/** A logger recording every warn/info with its metadata. */
function recordingLogger(): {
  logger: ILogger;
  warns: { message: string; metadata?: unknown }[];
  infos: string[];
} {
  const warns: { message: string; metadata?: unknown }[] = [];
  const infos: string[] = [];
  const logger = {
    level: 'info',
    warn: (message: string, metadata?: unknown) => warns.push({ message, metadata }),
    info: (message: string) => infos.push(message),
    error: () => undefined,
    fatal: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
    child: () => logger,
  } as unknown as ILogger;
  return { logger, warns, infos };
}

/** A registry recording its calls and answering from a function. */
function recordingRegistry(answer: (id: string) => Promise<unknown>): {
  registry: ITenantRegistry;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    registry: {
      lookup: (id) => {
        calls.push(id);
        return answer(id) as Promise<Option<ITenant>>;
      },
    },
  };
}

describe('TenantCheck', () => {
  it('1. no registry configured admits every id as some({ id })', async () => {
    const check = new TenantCheck({ configured: false });
    const result = await check.check('x'.repeat(10_000));
    expect(result.present && result.value).toEqual({ id: 'x'.repeat(10_000) });
  });

  it('2. an over-long id is none() and never reaches lookup; 256 chars does', async () => {
    const { registry, calls } = recordingRegistry((id) => Promise.resolve(some({ id })));
    const check = new TenantCheck({ configured: true, registry });
    expect((await check.check('x'.repeat(MAX_TENANT_ID_LENGTH + 1))).present).toBe(false);
    expect((await check.check('x'.repeat(10_000))).present).toBe(false);
    expect(calls).toEqual([]);
    expect((await check.check('y'.repeat(MAX_TENANT_ID_LENGTH))).present).toBe(true);
    expect(calls).toEqual(['y'.repeat(MAX_TENANT_ID_LENGTH)]);
  });

  it('3. configured but not bound yet (factory before onInit) throws', async () => {
    const check = new TenantCheck({ configured: true });
    await expect(check.check('acme')).rejects.toBeInstanceOf(TenantRegistryUnavailableError);
    await expect(check.check('acme')).rejects.toThrow(/before onInit/);
    check.bind({ lookup: (id) => Promise.resolve(some({ id })) });
    expect((await check.check('acme')).present).toBe(true);
  });

  it('4. a throwing lookup throws TenantRegistryUnavailableError with the original as cause', async () => {
    const original = new Error('connection refused');
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.reject(original) },
    });
    const error = await check.check('acme').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantRegistryUnavailableError);
    expect((error as Error).cause).toBe(original);
    expect((error as Error).message).not.toContain('acme');
  });

  it('4b. a synchronously throwing lookup is a fault too', async () => {
    const check = new TenantCheck({
      configured: true,
      registry: {
        lookup: () => {
          throw new Error('sync');
        },
      },
    });
    await expect(check.check('acme')).rejects.toBeInstanceOf(TenantRegistryUnavailableError);
  });

  it.each<[string, unknown]>([
    ["some({ id: '' })", some({ id: '' })],
    ['some({})', some({})],
    ['some(null)', some(null)],
    ['some({ id: 7 })', some({ id: 7 })],
    ['a non-Option object', { id: 'acme' }],
    ['present: "yes"', { present: 'yes', value: { id: 'acme' } }],
    ['undefined', undefined],
    ['null', null],
    ['a string', 'acme'],
  ])('5. a malformed answer (%s) is a fault, with the answer as cause', async (_label, answer) => {
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.resolve(answer as Option<ITenant>) },
    });
    const error = await check.check('acme').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TenantRegistryUnavailableError);
    expect((error as Error).cause).toBe(answer);
  });

  it("6. otherwise the lookup's own result, unchanged", async () => {
    const tenant = { id: 'acme', name: 'Acme' };
    const hit = some(tenant);
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: (id) => Promise.resolve(id === 'acme' ? hit : none()) },
    });
    expect(await check.check('acme')).toBe(hit);
    expect(await check.check('initech')).toBe(none());
  });

  it('logs warn once per healthy→failing transition and info on recovery, never with the id', async () => {
    const { logger, warns, infos } = recordingLogger();
    let failing = true;
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: {
        lookup: (id) =>
          failing ? Promise.reject(new Error('db down')) : Promise.resolve(some({ id })),
      },
    });
    const secret = 'distinctive-tenant-id';
    await expect(check.check(secret)).rejects.toThrow();
    await expect(check.check(secret)).rejects.toThrow();
    expect(warns).toHaveLength(1);
    expect(warns[0]!.message).toBe(REGISTRY_FAULT_LOG);
    const metadata = warns[0]!.metadata as { error: string };
    expect(metadata.error).toContain('db down');
    expect(JSON.stringify(warns)).not.toContain(secret);
    expect(infos).toEqual([]);

    failing = false;
    await check.check(secret);
    await check.check(secret);
    expect(infos).toEqual([REGISTRY_RECOVERED_LOG]);

    failing = true;
    await expect(check.check(secret)).rejects.toThrow();
    expect(warns).toHaveLength(2);
    expect(JSON.stringify([...warns, ...infos])).not.toContain(secret);
  });

  it('a malformed answer logs the fault with the error itself when there is no cause', async () => {
    const { logger, warns } = recordingLogger();
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: { lookup: () => Promise.resolve(undefined as unknown as Option<ITenant>) },
    });
    await expect(check.check('acme')).rejects.toThrow();
    expect((warns[0]!.metadata as { error: string }).error).toContain('malformed');
  });

  it('runs without a logger', async () => {
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.reject(new Error('x')) },
    });
    await expect(check.check('acme')).rejects.toThrow(TenantRegistryUnavailableError);
  });
});
