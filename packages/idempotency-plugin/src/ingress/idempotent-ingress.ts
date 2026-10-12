/**
 * The ingress entry point: `idempotentIngress(options)` (plan §3.7).
 *
 * @module
 */
import type {
  IdempotentIngressOptions,
  IIdempotencyService,
  IIngressBehavior,
  IServiceRegistry,
  RegistryFactory,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { validateIngressOptionShape } from '../core/options.ts';

/**
 * Builds the ingress idempotency behaviour, shape-validated at the call. The
 * returned factory resolves the service from the registry, so a missing
 * provider fails the host plugin's `onInit`.
 *
 * @param options - The ingress idempotency options (a required allow-list)
 * @returns A `RegistryFactory<IIngressBehavior>`
 * @throws {IdempotencyConfigurationError} When an option's shape is invalid
 * @since 0.9.0
 */
export function idempotentIngress(
  options: IdempotentIngressOptions,
): RegistryFactory<IIngressBehavior> {
  validateIngressOptionShape(options);
  return (services: IServiceRegistry): IIngressBehavior =>
    services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY).behavior(options);
}
