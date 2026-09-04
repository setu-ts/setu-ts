/**
 * The C1/X16-2 proof (M89c plan §3.4/§3.6): the tenant concern the `0.3.0`
 * release notes advertise is now WRITABLE — a `RegistryFactory` behaviour
 * resolves `IMultiTenancyService`, reads the tenant id from `ctx.payload`
 * (the only channel the envelope offers, by design), and scopes its write
 * through the ctx-free `getRepositoryFor(tenantId, entity)`. Two dispatches
 * carrying different tenant ids write into partitions that cannot see each
 * other.
 *
 * The messaging side under test is the composition: factory-arm resolution,
 * the payload tenant, and the ctx-free member call. The concrete
 * `IMultiTenancyService` under the behaviour is a contract-faithful stand-in
 * over a per-tenant-keyed map — AI_GUIDELINES §2.2 forbids this package (and
 * its tests, which publish with it) from importing `multi-tenancy-plugin`, so
 * the REAL service's `getRepositoryFor` isolation is proven in that package's
 * own `ctx-free-members.test.ts`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IIngressBehavior,
  IngressContext,
  IPluginContext,
  ITenantRepository,
  RegistryFactory,
} from '@setu-ts/common';
import type { IMultiTenancyService, ITenant } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/plugin/messaging-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** A widget row the behaviours write. */
interface Widget {
  readonly id: string;
  readonly label: string;
  readonly tenantId: string;
}

/**
 * Contract-faithful `IMultiTenancyService`: every member of the `common`
 * interface, with `getRepositoryFor` scoping rows by the id it is GIVEN
 * (stamped on write, filtered on read) — the isolation shape the real
 * service's tenant-threaded repository provides.
 */
class PerTenantMapTenancy implements IMultiTenancyService {
  readonly #rows = new Map<string, Widget>();

  getCurrentTenant(ctx: import('@setu-ts/common').IRequestContext): ITenant | undefined {
    return ctx.request.tenant;
  }

  getRepository<Entity, Id = string>(
    ctx: import('@setu-ts/common').IRequestContext,
  ): ITenantRepository<Entity, Id> {
    const tenant = ctx.request.tenant;
    if (tenant === undefined) {
      throw new Error('tenant not resolved');
    }
    return this.#repoFor<Entity, Id>(tenant.id);
  }

  getRepositoryFor<Entity, Id = string>(
    tenantId: string,
  ): ITenantRepository<Entity, Id> {
    return this.#repoFor<Entity, Id>(tenantId);
  }

  prefixCacheKey(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  /** The rows of ONE tenant, visible to nobody else. */
  rowsFor(tenantId: string): readonly Widget[] {
    return [...this.#rows.values()].filter((row) => row.tenantId === tenantId);
  }

  #repoFor<Entity, Id = string>(tenantId: string): ITenantRepository<Entity, Id> {
    const rows = this.#rows;
    return {
      findAll: () =>
        Promise.resolve(
          [...rows.values()].filter((row) =>
            row.tenantId === tenantId
          ) as unknown as readonly Entity[],
        ),
      findById: (id: Id) =>
        Promise.resolve(
          (rows.get(`${tenantId}:${String(id)}`) ?? null) as Entity | null,
        ),
      find: (filter) =>
        Promise.resolve(
          [...rows.values()].filter((row) =>
            row.tenantId === tenantId &&
            Object.entries(filter).every(([key, value]) =>
              (row as unknown as Record<string, unknown>)[key] === value
            )
          ) as unknown as readonly Entity[],
        ),
      create: (data) => {
        const row = { ...(data as Record<string, unknown>), tenantId } as unknown as Widget;
        rows.set(`${tenantId}:${String(row.id)}`, row);
        return Promise.resolve(row as unknown as Entity);
      },
      update: () => Promise.resolve(null),
      delete: () => Promise.resolve(false),
    };
  }
}

interface Harness {
  readonly ctx: IPluginContext;
  readonly registered: Map<string, unknown>;
  readonly initHooks: (() => void | Promise<void>)[];
}

function createHarness(service: IMultiTenancyService): Harness {
  const registered = new Map<string, unknown>([
    [CAPABILITIES.MULTI_TENANCY, service],
  ]);
  const initHooks: (() => void | Promise<void>)[] = [];

  const ctx = {
    runtime: createFakeRuntime(),
    services: {
      has: (token: string): boolean => registered.has(token),
      get: <T>(token: string): T => {
        const found = registered.get(token);
        if (found === undefined) {
          throw new Error(`no service for ${token}`);
        }
        return found as T;
      },
      register: <T>(token: string, value: T): void => {
        registered.set(token, value);
      },
    },
    health: {
      register: (): void => {},
    },
    lifecycle: {
      onClose: (): void => {},
      onInit: (hook: () => void | Promise<void>): void => {
        initHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;

  return { ctx, registered, initHooks };
}

describe('a tenant behaviour written through the RegistryFactory arm (C1/X16-2)', () => {
  it('resolves IMultiTenancyService, reads the tenant from the payload, and writes tenant-scoped rows', async () => {
    const tenancy = new PerTenantMapTenancy();
    const harness = createHarness(tenancy);

    // The tenant concern, expressed ONCE for this ingress kind: resolved
    // through the factory arm, tenant read from the payload, write through
    // the ctx-free member. This exact shape is what the 0.3.0 release notes
    // advertise and what no IRequestContext-taking member could serve.
    const tenantWriteBehavior: RegistryFactory<IIngressBehavior> = (services) => {
      const service = services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      return {
        handle(ctx: IngressContext, next: () => Promise<void>): void | Promise<void> {
          const payload = ctx.payload as {
            tenantId: string;
            widget: { id: string; label: string };
          };
          const repo = service.getRepositoryFor<Widget>(payload.tenantId, 'Widget');
          return repo
            .create({ id: payload.widget.id, label: payload.widget.label })
            .then(() => next());
        },
      };
    };

    const messaging = MessagingPlugin({
      broker: 'memory',
      behaviors: [tenantWriteBehavior],
      subscriptions: [
        {
          topic: 'widgets.created',
          handler: () => {}, // the handler observes nothing tenant-specific
        },
      ],
    });
    await messaging.register(harness.ctx);
    for (const hook of harness.initHooks) {
      await hook();
    }

    const broker = harness.registered.get(CAPABILITIES.MESSAGING) as {
      publish: (topic: string, message: unknown) => Promise<void>;
    };

    // Two tenants publish on the SAME topic; each payload names its own
    // tenant.
    await broker.publish('widgets.created', {
      tenantId: 'tenant-a',
      widget: { id: 'w1', label: 'A widget' },
    });
    await broker.publish('widgets.created', {
      tenantId: 'tenant-b',
      widget: { id: 'w1', label: 'B widget' },
    });
    await new Promise((r) => setTimeout(r, 10));

    // Tenant A's write is invisible to tenant B, and vice versa — same entity
    // name, same row id, disjoint partitions.
    expect(tenancy.rowsFor('tenant-a')).toEqual([
      { id: 'w1', label: 'A widget', tenantId: 'tenant-a' },
    ]);
    expect(tenancy.rowsFor('tenant-b')).toEqual([
      { id: 'w1', label: 'B widget', tenantId: 'tenant-b' },
    ]);
  });
});
