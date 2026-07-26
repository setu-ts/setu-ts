/**
 * Path-segment-based tenant resolver.
 *
 * @module
 */
import type { IRequest, ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { PathResolverOptions } from '../interfaces/index.ts';

/**
 * Extracts the tenant id from the given path segments at the specified index.
 *
 * Returns the segment when non-empty, otherwise `null`. This pure function
 * allows every branch of the extraction logic to be tested directly.
 *
 * @internal
 */
export function extractPathTenant(segments: string[], index: number): string | null {
  if (index < 0 || index >= segments.length) return null;
  const segment = segments[index];
  if (!segment) return null;
  return segment;
}

/**
 * Resolves the tenant id from a segment of `request.path`.
 */
export class PathResolver implements ITenantResolver {
  private readonly segmentIndex: number;

  constructor(options?: PathResolverOptions) {
    this.segmentIndex = options?.segment ?? 0;
  }

  /**
   * Resolve the tenant id from a segment of `request.path`.
   */
  resolve(request: IRequest): Promise<Option<ITenant>> {
    const parts = request.path.split('/').filter(Boolean);
    const tenantId = extractPathTenant(parts, this.segmentIndex);
    return Promise.resolve(tenantId === null ? none() : some({ id: tenantId }));
  }
}
