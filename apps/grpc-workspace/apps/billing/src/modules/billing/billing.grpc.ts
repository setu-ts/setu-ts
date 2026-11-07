import { Code, ConnectError, type ServiceImpl } from '@connectrpc/connect';
import { CAPABILITIES, type IGrpcService, type IPlugin } from '@setu-ts/common';
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
 * Registers `BillingService` with the member's gRPC service. The CLI owns the
 * `GrpcPlugin` itself (`src/transport/index.ts`), so the service is added from
 * a plugin that depends on the capability rather than through
 * `GrpcPlugin({ services })`.
 *
 * @returns The plugin `setu.config.ts` registers after `transportPlugins()`
 */
export function BillingGrpcPlugin(): IPlugin {
  return {
    name: 'billing-grpc',
    version: '0.0.0',
    dependencies: [CAPABILITIES.GRPC],
    register(ctx) {
      ctx.services.get<IGrpcService>(CAPABILITIES.GRPC).addService(BillingService, implementation);
    },
  };
}
