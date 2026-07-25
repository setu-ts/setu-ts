/**
 * Path-segment-based tenant resolver.
 *
 * @module
 */
import type { ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { PathResolverOptions } from '../interfaces/index.ts';

/**
 * Resolves the tenant id from a path segment in `request.path`.
 *
 * **Limitation:** This resolver parses `request.path` directly by segment
 * index — it cannot read router `:param` values because those live on
 * `IRequestContext.params`, which the resolver interface does not receive.
 *
 * @example
 * ```typescript
 * // For request.path = '/api/acme/users'
 * const resolver = new PathResolver({ segment: 1 });
 * const result = await resolver.resolve(request);
 * // => some({ id: 'acme' })
 * ```
 */
export class PathResolver implements ITenantResolver {
  private readonly segmentIndex: number;

  constructor(options?: PathResolverOptions) {
    this.segmentIndex = options?.segment ?? 0;
  }

  /**
   * Resolve the tenant id from a segment of `request.path`.
   */
  // deno-lint-ignore require-await
  async resolve(request: import('@hono-enterprise/common').IRequest): Promise<Option<ITenant>> {
    const parts = request.path.split('/').filter(Boolean);
    if (this.segmentIndex < 0 || this.segmentIndex >= parts.length) {
      return none();
    }
    const segment = parts[this.segmentIndex];
    if (!segment) return none();
    return some({ id: segment });
  }
}
