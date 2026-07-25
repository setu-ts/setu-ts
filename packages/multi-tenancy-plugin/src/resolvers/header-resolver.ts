// deno-lint-ignore-file no-unused-vars
/**
 * Header-based tenant resolver.
 *
 * @module
 */
import type { ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { HeaderResolverOptions } from '../interfaces/index.ts';

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
  async resolve(request: import('@hono-enterprise/common').IRequest): Promise<Option<ITenant>> {
    const raw = request.headers.get(this.headerName);
    if (!raw) return none();
    const trimmed = raw.trim();
    if (!trimmed) return none();
    return some({ id: trimmed });
  }
}
