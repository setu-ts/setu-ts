/**
 * Cloudflare Workers runtime adapter — currently a stub that throws.
 *
 * Cloudflare Workers support is planned but deferred; this adapter exists as a
 * placeholder so the detection path is complete.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Creates Cloudflare Workers runtime services.
 *
 * @throws {Error} Cloudflare Workers runtime is not yet implemented
 */
export function createCloudflareRuntimeServices(): IRuntimeServices {
  throw new Error('Cloudflare Workers runtime is not yet implemented.');
}
