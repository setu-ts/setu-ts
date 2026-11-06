import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';
import type { IPlugin, IPluginContext } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { SEED_ORDERS } from '../modules/support/support.orders.ts';
import type { Order } from '../modules/support/support.orders.ts';

/** Capability token this plugin provides. */
export const SUPPORT_DATA = createCapabilityToken('support-data');

/** The service registered under {@linkcode SUPPORT_DATA}. */
export interface ISupportDataService {
  /** How many demonstration orders were inserted at startup; 0 when they already existed. */
  readonly seeded: number;
}

/**
 * Registers the support-data capability: the demonstration orders, inserted
 * at startup when missing.
 *
 * Registered for you through the `GENERATED_PLUGINS` barrel in
 * `src/plugins/index.ts`, which `setu.config.ts` spreads into
 * `createApplication({ plugins })` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * On PostgreSQL `schema.sql` already inserts the same rows, so this inserts
 * nothing there; the memory database starts empty on every boot.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function SupportDataPlugin(): IPlugin {
  return {
    name: 'support-data',
    version: '0.1.0',
    provides: [SUPPORT_DATA],
    register(ctx: IPluginContext): void {
      const service = { seeded: 0 };
      ctx.lifecycle.onInit(async () => {
        const orders = ctx.services
          .get<IDatabaseService>(CAPABILITIES.DATABASE)
          .getRepository<Order>('Order');
        for (const order of SEED_ORDERS)
          if (!(await orders.findById(order.id))) {
            await orders.create(order);
            service.seeded++;
          }
      });
      ctx.services.register(SUPPORT_DATA, service as ISupportDataService);
    },
  };
}
