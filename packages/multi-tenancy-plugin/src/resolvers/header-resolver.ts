/**
 * Header-based tenant resolver.
 *
 * @module
 */
import type { ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
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
  // deno-lint-ignore require-await
  async resolve(request: import('@hono-enterprise/common').IRequest): Promise<Option<ITenant>> {
    const raw = request.headers.get(this.headerName);
    if (!raw) return none();
    const tenantId = normalizeHeaderTenant(raw);
    if (tenantId === null) return none();
    return some({ id: tenantId });
  }
}
