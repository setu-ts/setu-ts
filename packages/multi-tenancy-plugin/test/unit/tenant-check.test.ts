/**
 * The shared tenant check (M127 §3.3): each numbered branch, the length cap,
 * malformed answers, and the warn-once / info-on-recovery log sequence.
 */
import { describe, expect, it } from 'vitest';
import type { ILogger, ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { TenantRegistryUnavailableError } from '../../src/errors.ts';
import {
  MASKED_TENANT_ID,
  maskTenantId,
  MAX_TENANT_ID_LENGTH,
  REGISTRY_FAULT_LOG,
  REGISTRY_RECOVERED_LOG,
  snapshotAnswer,
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

  it('6. otherwise none(), or a frozen snapshot of the registry tenant (R3)', async () => {
    const tenant = { id: 'acme', name: 'Acme', metadata: { plan: 'gold' } };
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: (id) => Promise.resolve(id === 'acme' ? some(tenant) : none()) },
    });
    const hit = await check.check('acme');
    expect(hit.present && hit.value).toEqual(tenant);
    expect(hit.present && hit.value).not.toBe(tenant);
    expect(Object.isFrozen(hit.present && hit.value)).toBe(true);
    expect(Object.isFrozen(hit.present && hit.value.metadata)).toBe(true);
    expect(await check.check('initech')).toBe(none());
  });

  it('R3: extra keys are dropped and the shared registry object is never handed out', async () => {
    const shared = { id: 'acme', apiKey: 'sk-secret', metadata: { seats: 3 } };
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.resolve(some(shared as ITenant)) },
    });
    const first = await check.check('acme');
    const tenant = first.present ? first.value : undefined;
    expect(Object.keys(tenant ?? {})).toEqual(['id', 'metadata']);
    expect(JSON.stringify(tenant)).not.toContain('sk-secret');
    expect(() => {
      (tenant!.metadata as Record<string, unknown>).seats = 99;
    }).toThrow(TypeError);
    expect(shared.metadata.seats).toBe(3);
  });

  it('R3: a stateful id getter is read exactly once', async () => {
    let reads = 0;
    const tenant = {
      get id() {
        reads++;
        return reads === 1 ? 'acme' : 'globex';
      },
    };
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.resolve(some(tenant)) },
    });
    const hit = await check.check('acme');
    expect(reads).toBe(1);
    const value = hit.present ? hit.value : undefined;
    expect(value?.id).toBe('acme');
    expect(value?.id).toBe('acme');
  });

  it('R3: a throwing accessor on the answer is a fault, not a crash', async () => {
    const answer = {
      present: true,
      get value(): never {
        throw new Error('boom');
      },
    };
    const check = new TenantCheck({
      configured: true,
      registry: { lookup: () => Promise.resolve(answer as unknown as Option<ITenant>) },
    });
    await expect(check.check('acme')).rejects.toBeInstanceOf(TenantRegistryUnavailableError);
  });

  it('snapshotAnswer: none, frozen some, and undefined for every malformed shape', () => {
    expect(snapshotAnswer(none())).toBe(none());
    const hit = snapshotAnswer(some({ id: 'a', name: 'A' }));
    expect(hit?.present && hit.value).toEqual({ id: 'a', name: 'A' });
    for (const bad of [some({ id: '' }), some({}), some(null), null, 'x', { present: 1 }]) {
      expect(snapshotAnswer(bad)).toBeUndefined();
    }
  });

  it.each<[string, (id: string) => string]>([
    ['verbatim', (id) => `no tenant ${id}`],
    ['quoted by a driver', (id) => `invalid input syntax for type uuid: "${id}"`],
    ['JSON-escaped', (id) => `no document matches ${JSON.stringify({ id })}`],
    ['upper-cased', (id) => `NO TENANT ${id.toUpperCase()}`],
    ['truncated', (id) => `no tenant ${id.slice(0, 3)}`],
  ])('F-1: the fault warn carries no registry message text — id %s', async (_label, render) => {
    const { logger, warns } = recordingLogger();
    const id = '<x>\r\nX-Evil: 1';
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: { lookup: (requested) => Promise.reject(new Error(render(requested))) },
    });
    await expect(check.check(id)).rejects.toThrow(TenantRegistryUnavailableError);
    expect(warns).toHaveLength(1);
    const logged = (warns[0]!.metadata as { error: string }).error;
    expect(logged).toBe(
      'TenantRegistryUnavailableError: The tenant registry lookup threw <- Error',
    );
    for (const fragment of ['X-Evil', 'x-evil', '<x>', '<X>', 'no tenant', 'NO TENANT']) {
      expect(logged).not.toContain(fragment);
    }
  });

  it('F-1: driver classifiers and the error name reach the warn', async () => {
    const { logger, warns } = recordingLogger();
    const driverError = Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:5432 acme'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
    });
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: {
        lookup: () =>
          Promise.reject(new AggregateError([driverError], 'all hosts failed for acme')),
      },
    });
    await expect(check.check('acme')).rejects.toThrow();
    const logged = (warns[0]!.metadata as { error: string }).error;
    expect(logged).toBe(
      'TenantRegistryUnavailableError: The tenant registry lookup threw <- AggregateError ' +
        '[Error (code=ECONNREFUSED, errno=-111, syscall=connect)]',
    );
    expect(logged).not.toContain('10.0.0.1');
    expect(logged).not.toContain('all hosts failed');
  });

  it('F-1: an id smuggled into a custom error name or code is still masked', async () => {
    const { logger, warns } = recordingLogger();
    class TenantMissing extends Error {
      code = 'acme';
    }
    const custom = new TenantMissing('x');
    custom.name = 'NoSuchTenant acme';
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: { lookup: () => Promise.reject(custom) },
    });
    await expect(check.check('acme')).rejects.toThrow();
    const logged = (warns[0]!.metadata as { error: string }).error;
    expect(logged).toBe(
      `TenantRegistryUnavailableError: The tenant registry lookup threw <- NoSuchTenant ${MASKED_TENANT_ID} (code=${MASKED_TENANT_ID})`,
    );
  });

  it('F-1: a malformed answer contributes only its type, never its contents', async () => {
    const { logger, warns } = recordingLogger();
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: {
        lookup: () =>
          Promise.resolve({
            present: 'yes',
            value: { id: 'secret-row' },
          } as unknown as Option<ITenant>),
      },
    });
    await expect(check.check('acme')).rejects.toThrow();
    const logged = (warns[0]!.metadata as { error: string }).error;
    expect(logged).toContain('malformed answer');
    expect(logged).not.toContain('secret-row');
    expect(logged).not.toContain('yes');
  });

  it('F-1: a control character in an error name cannot break the line, and long parts are bounded', async () => {
    const { logger, warns } = recordingLogger();
    const weird = new Error('x');
    weird.name = `Bad\r\nName${'z'.repeat(400)}`;
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: { lookup: () => Promise.reject(weird) },
    });
    await expect(check.check('acme')).rejects.toThrow();
    const logged = (warns[0]!.metadata as { error: string }).error;
    expect(logged).not.toMatch(/[\r\n]/);
    expect(logged).toContain('Bad Name');
    expect(logged).toContain('… [truncated]');
  });

  async function faultLine(id: string, cause: unknown): Promise<string> {
    const { logger, warns } = recordingLogger();
    const check = new TenantCheck({
      configured: true,
      logger,
      registry: { lookup: () => Promise.reject(cause) },
    });
    await expect(check.check(id)).rejects.toThrow(TenantRegistryUnavailableError);
    return (warns[0]!.metadata as { error: string }).error;
  }

  it('D-2: URL credentials in an error name or a classifier are masked', async () => {
    const error = Object.assign(new Error('down'), {
      code: 'redis://svc:classifier-pw@cache:6379',
    });
    error.name = 'RedisError redis://svc:name-pw@cache:6379';
    const logged = await faultLine('acme', error);
    expect(logged).toContain('RedisError redis://');
    expect(logged).not.toContain('name-pw');
    expect(logged).not.toContain('classifier-pw');
  });

  it('E-1: an id matching the URL scheme cannot unmask the credentials in an error name', async () => {
    for (const id of ['redis', 'redis:', '/', 'u', 'hunter2', 'db', '@']) {
      const error = new Error('down');
      error.name = 'RedisError redis://u:hunter2@db:6379';
      const logged = await faultLine(id, error);
      expect(logged, id).not.toContain('hunter2');
    }
  });

  it('D-1: the id is masked on the raw name, before control and private-use characters collapse', async () => {
    const id = 'zq\u{E000}x\u0007y';
    const error = new Error('down');
    error.name = `Bad ${id}`;
    const nested = Object.assign(new Error('outer', { cause: error }), { code: id });
    const logged = await faultLine(id, nested);
    expect(logged).toContain(`code=${MASKED_TENANT_ID}`);
    expect(logged).toContain(`Bad ${MASKED_TENANT_ID}`);
    expect(logged).not.toContain('zq');
  });

  it('D-3: the line and each part stay within their bounds, marker included', async () => {
    let chain: Error = new Error('root');
    for (let i = 0; i < 40; i++) {
      const next = new Error('x', { cause: chain });
      next.name = `N${i}${'n'.repeat(400)}`;
      chain = next;
    }
    const logged = await faultLine('acme', chain);
    expect([...logged].length).toBe(2048);
    expect(logged.endsWith('… [truncated]')).toBe(true);
    for (const part of logged.split(' <- ').slice(1, -1)) {
      expect([...part].length).toBeLessThanOrEqual(256);
    }
  });

  it('D-3: masking an id repeated in a name cannot push the line past its bound', async () => {
    let chain: Error = new Error('root');
    for (let i = 0; i < 20; i++) {
      const next = new Error('x', { cause: chain });
      next.name = Array.from({ length: 200 }, () => 'a').join(' ');
      chain = next;
    }
    const logged = await faultLine('a', chain);
    expect([...logged].length).toBeLessThanOrEqual(2048);
    expect(logged).toContain(MASKED_TENANT_ID);
  });

  it('maskTenantId leaves unrelated text alone', () => {
    expect(maskTenantId('Error: connection refused', 'acme')).toBe('Error: connection refused');
  });

  it('F1: a one-letter id does not shred the message; only standalone quotes are masked', () => {
    const text = 'TenantRegistryUnavailableError: connection refused at 10.0.0.1 <- no tenant "e"';
    expect(maskTenantId(text, 'e')).toBe(
      `TenantRegistryUnavailableError: connection refused at 10.0.0.1 <- no tenant "${MASKED_TENANT_ID}"`,
    );
    expect(maskTenantId('db 1 down; tenant 1', '1')).toBe(
      `db ${MASKED_TENANT_ID} down; tenant ${MASKED_TENANT_ID}`,
    );
    expect(maskTenantId('acme-corp and acmes are not acme', 'acme')).toBe(
      `acme-corp and acmes are not ${MASKED_TENANT_ID}`,
    );
  });

  it('F1: the inserted marker is never searched again', () => {
    expect(maskTenantId('no tenant " id"', ' id')).toBe(`no tenant "${MASKED_TENANT_ID}"`);
    expect(maskTenantId('tenant id', 'id')).toBe(`tenant ${MASKED_TENANT_ID}`);
    expect(maskTenantId('x', 'tenant')).toBe('x');
  });

  it('F1: regex metacharacters in the id are matched literally', () => {
    expect(maskTenantId('a.c abc', 'a.c')).toBe(`${MASKED_TENANT_ID} abc`);
    expect(maskTenantId('no (x) here', '(x)')).toBe(`no ${MASKED_TENANT_ID} here`);
  });

  it('A1: a cache hit during a fault does not log recovery; a real answer does', async () => {
    const { logger, warns, infos } = recordingLogger();
    let failing = false;
    const inner: ITenantRegistry = {
      lookup: (id) => (failing ? Promise.reject(new Error('down')) : Promise.resolve(some({ id }))),
    };
    const { CachingTenantRegistry } = await import('../../src/registry/caching-tenant-registry.ts');
    const cache = new CachingTenantRegistry(
      inner,
      { ttlMs: 60_000, maxEntries: 10, maxBytes: 4_096 },
      () => 0,
    );
    const check = new TenantCheck({ configured: true, registry: cache, logger });
    await check.check('acme'); // cached
    failing = true;
    for (let i = 0; i < 5; i++) {
      await expect(check.check(`unknown-${i}`)).rejects.toThrow();
      expect((await check.check('acme')).present).toBe(true); // served from cache
    }
    expect(warns).toHaveLength(1);
    expect(infos).toEqual([]);
    failing = false;
    await check.check('globex'); // a real answer
    expect(infos).toEqual([REGISTRY_RECOVERED_LOG]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a throwing method', { isCacheHit: (id: string) => id.toLowerCase() === 'x' }],
    ['a data property', { isCacheHit: true }],
    ['a method answering true', { isCacheHit: () => true }],
  ])(
    'C1: a user registry defining isCacheHit (%s) recovers normally after a fault',
    async (_label, extra) => {
      const { logger, warns, infos } = recordingLogger();
      let failing = false;
      const registry = {
        ...extra,
        lookup: (id: string) =>
          failing ? Promise.reject(new Error('db down')) : Promise.resolve(some({ id })),
      } as ITenantRegistry;
      const check = new TenantCheck({ configured: true, registry, logger });
      expect((await check.check('acme')).present).toBe(true);
      failing = true;
      await expect(check.check('acme')).rejects.toThrow(TenantRegistryUnavailableError);
      failing = false;
      for (let i = 0; i < 3; i++) {
        const hit = await check.check('acme');
        expect(hit.present && hit.value.id).toBe('acme');
      }
      expect(infos).toEqual([REGISTRY_RECOVERED_LOG]);
      // The next real outage is reported again.
      failing = true;
      await expect(check.check('acme')).rejects.toThrow();
      expect(warns).toHaveLength(2);
    },
  );

  it('A5: with no registry the admitted tenant is frozen too', async () => {
    const result = await new TenantCheck({ configured: false }).check('x');
    expect(Object.isFrozen(result.present && result.value)).toBe(true);
  });

  it('A6: Map, array and class-instance metadata are dropped, null-prototype kept', () => {
    class Meta {
      plan = 'gold';
    }
    for (const metadata of [new Map([['a', 1]]), ['a'], new Meta()]) {
      const hit = snapshotAnswer(some({ id: 'a', metadata }));
      expect(hit?.present && hit.value).toEqual({ id: 'a' });
    }
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { plan: 'gold' });
    const kept = snapshotAnswer(some({ id: 'a', metadata: bare }));
    expect(kept?.present && kept.value.metadata).toEqual({ plan: 'gold' });
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
    expect(metadata.error).toBe(
      'TenantRegistryUnavailableError: The tenant registry lookup threw <- Error',
    );
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
