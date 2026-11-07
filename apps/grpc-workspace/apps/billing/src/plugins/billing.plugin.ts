import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IGrpcService, IPlugin, IPluginContext } from '@setu-ts/common';
import { BillingService } from '@grpc-workspace/contracts';

/** Fixed in-memory price table, in cents per unit. */
const PRICE_CENTS: Readonly<Record<string, number>> = {
  widget: 999,
  gadget: 1499,
};

/**
 * The server-side implementation of `billing.v1.BillingService`. `satisfies` checks
 * it against the generated service, so a change to the proto fails to compile
 * here rather than at runtime: the plugin types `implementation` as `unknown`.
 */
const implementation = {
  quote(request) {
    let totalCents = 0n;
    for (const item of request.items) {
      const priceCents = PRICE_CENTS[item.sku];
      if (priceCents === undefined) {
        throw new ConnectError(`unknown SKU '${item.sku}'`, Code.InvalidArgument);
      }
      if (item.quantity <= 0) {
        throw new ConnectError('quantity must be a positive integer', Code.InvalidArgument);
      }
      totalCents += BigInt(priceCents) * BigInt(item.quantity);
    }
    return { totalCents };
  },
} satisfies Partial<ServiceImpl<typeof BillingService>>;

/**
 * Serves `billing.v1.BillingService`. The CLI owns `GrpcPlugin` (in
 * `src/transport/index.ts`), so the service is added through
 * {@linkcode IGrpcService.addService} once that plugin has registered, rather
 * than through `GrpcPlugin({ services })`.
 *
 * Registered for you through the `GENERATED_PLUGINS` barrel in
 * `src/plugins/index.ts`, which `setu.config.ts` spreads into
 * `createApplication({ plugins })` — so this module needs no further wiring. Delete
 * this file to stop registering it; the barrel is regenerated from the directory.
 *
 * @returns The plugin to pass to `createApplication({ plugins: [...] })`
 */
export function BillingPlugin(): IPlugin {
  return {
    name: 'billing',
    version: '0.1.0',
    dependencies: [CAPABILITIES.GRPC],
    register(ctx: IPluginContext): void {
      ctx.services.get<IGrpcService>(CAPABILITIES.GRPC).addService(BillingService, implementation);
    },
  };
}
