/**
 * Header-based tenant resolver.
 *
 * @module
 */
import type { IRequest, ITenant, ITenantResolver } from '@setu-ts/common';
import { none, type Option, some } from '@setu-ts/common';
import type { HeaderResolverOptions } from '../interfaces/index.ts';

/**
 * Normalizes a raw header value into a tenant id or `null` when empty/whitespace.
 *
 * This is the decidable core of {@linkcode HeaderResolver.resolve} — the
 * `resolve()` method delegates to this helper so every branch of the
 * normalization logic can be tested directly and independently.
 *
 * @internal
 */
export function normalizeHeaderTenant(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Resolves the tenant id from an HTTP header.
 *
 * @example
 * ```typescript
 * const resolver = new HeaderResolver({ name: 'x-tenant-id' });
 * const result = await resolver.resolve(request);
 * // => some({ id: 'acme' })  when header is 'x-tenant-id: acme'
 * ```
 */
export class HeaderResolver implements ITenantResolver {
  private readonly headerName: string;

  constructor(options?: HeaderResolverOptions) {
    this.headerName = options?.name ?? 'x-tenant-id';
  }

  /**
   * Resolve the tenant id from the configured request header.
   */
  resolve(request: IRequest): Promise<Option<ITenant>> {
    const raw = request.headers.get(this.headerName);
    if (!raw) return Promise.resolve(none());
    const result = normalizeHeaderTenant(raw);
    return Promise.resolve(result !== null ? some({ id: result }) : none());
  }
}
