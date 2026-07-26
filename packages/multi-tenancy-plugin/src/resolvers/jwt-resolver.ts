/**
 * JWT-claim-based tenant resolver.
 *
 * @module
 */
import type { IRequest, ITenant, ITenantResolver } from '@hono-enterprise/common';
import { none, type Option, some } from '@hono-enterprise/common';
import type { JwtResolverOptions } from '../interfaces/index.ts';

/**
 * Resolves the tenant id from a claim in an unverified JWT payload.
 *
 * **Security note:** This resolver uses **unverified** decode — tenant identity
 * is taken from an unsigned token claim. An application using this without
 * auth middleware must understand a client could spoof the tenant claim.
 *
 * @example
 * ```typescript
 * const resolver = new JwtResolver({ claim: 'tenant_id' });
 * const result = await resolver.resolve(request);
 * // => some({ id: 'acme' })  when payload has tenant_id='acme'
 * ```
 */
export class JwtResolver implements ITenantResolver {
  private readonly claimName: string;
  private readonly headerName: string;
  private readonly decode: (token: string) => Record<string, unknown> | null;

  constructor(
    options: JwtResolverOptions & { decode: (token: string) => Record<string, unknown> | null },
  ) {
    this.claimName = options.claim ?? 'tenant_id';
    this.headerName = options.headerName ?? 'authorization';
    this.decode = options.decode;
  }

  /**
   * Resolve the tenant id from the configured JWT claim.
   */
  resolve(request: IRequest): Promise<Option<ITenant>> {
    const rawHeader = request.headers.get(this.headerName);
    if (!rawHeader) return Promise.resolve(none());

    // Extract the token from "Bearer <token>" or use the raw header value.
    let token: string;
    if (rawHeader.startsWith('Bearer ') || rawHeader.startsWith('bearer ')) {
      token = rawHeader.slice(7);
    } else {
      token = rawHeader;
    }

    if (!token) return Promise.resolve(none());

    const payload = this.decode(token);
    if (!payload) return Promise.resolve(none());

    const tenantId = payload[this.claimName];
    if (typeof tenantId !== 'string' || !tenantId) return Promise.resolve(none());

    return Promise.resolve(some({ id: tenantId }));
  }
}
