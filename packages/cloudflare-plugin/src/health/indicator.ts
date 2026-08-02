/**
 * The `cloudflare` health indicator.
 *
 * @module
 */

import type {
  HealthCheckResult,
  HealthIndicatorFn,
  RuntimePlatform,
} from '@hono-enterprise/common';

/** What the indicator reports on. */
export interface CloudflareHealthInput {
  /** The binding names the Worker carries. */
  readonly bindings: readonly string[];
  /** How many string variables the Worker carries. */
  readonly varCount: number;
  /** Whether `CAPABILITIES.CACHE` is served from KV. */
  readonly cache: boolean;
  /** Whether `CAPABILITIES.STORAGE` is served from R2. */
  readonly storage: boolean;
  /** Whether a platform `waitUntil` sink was injected. */
  readonly waitUntil: boolean;
  /** The detected platform, from `runtime.platform()`. */
  readonly platform: RuntimePlatform;
}

/**
 * Builds the `cloudflare` health indicator.
 *
 * The indicator performs **no binding I/O**. Two reasons, both load-bearing:
 * Cloudflare prohibits I/O outside a request context, so a probe read would
 * throw on a real deployment while passing against any fake; and a KV read per
 * liveness check is a billable operation on every probe interval.
 *
 * That leaves one genuinely actionable signal, and it is reported: running
 * off Cloudflare Workers is `degraded`, because every store method is about to
 * fail against a binding the platform cannot honor.
 *
 * @param input - The registration facts to report
 * @returns The indicator function to hand to `ctx.health.register`
 * @since 0.2.0
 */
export function createCloudflareIndicator(input: CloudflareHealthInput): HealthIndicatorFn {
  const offPlatform = input.platform !== 'cloudflare-workers';

  const result: HealthCheckResult = {
    status: offPlatform ? 'degraded' : 'up',
    data: {
      platform: input.platform,
      bindings: input.bindings,
      vars: input.varCount,
      cache: input.cache,
      storage: input.storage,
      waitUntil: input.waitUntil ? 'injected' : 'absent',
      ...(offPlatform
        ? {
          detail:
            `CloudflarePlugin is registered on '${input.platform}', not cloudflare-workers. ` +
            'Bindings passed through `env` will still be used, but anything the platform ' +
            'itself provides is absent.',
        }
        : {}),
    },
  };

  // Built once: the reported facts are fixed at registration, so a probe should
  // not re-derive them on every call.
  return (): Promise<HealthCheckResult> => Promise.resolve(result);
}
