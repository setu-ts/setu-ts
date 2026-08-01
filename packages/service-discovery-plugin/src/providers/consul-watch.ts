/**
 * Consul blocking-query watch loop.
 *
 * Both index hazards handled here are documented upstream requirements, not
 * defensive extras: an index that moves backwards after a server restart makes
 * the client miss updates for an unbounded time if it is not reset to zero,
 * and an index of `0` causes a busy loop against older Consul versions — a
 * request flood no test would ever surface.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, Unsubscribe } from '@hono-enterprise/common';
import type { IDiscoveryHttp } from '../interfaces/index.ts';

/** Initial reconnect delay after a failed request. */
const INITIAL_BACKOFF_MS = 250;
/** Ceiling the reconnect delay doubles up to. */
const MAX_BACKOFF_MS = 5_000;

/** Everything the loop needs, all injectable. */
export interface ConsulWatchDeps {
  /** The service being watched, for nothing but readability in errors. */
  readonly serviceName: string;
  /** Called with the full instance list after every completed response. */
  readonly listener: (instances: readonly ServiceInstance[]) => void;
  /** The HTTP seam. */
  readonly http: IDiscoveryHttp;
  /** Supplies timers for the backoff sleep. */
  readonly runtime: IRuntimeServices;
  /** Builds the blocking-query URL for an index. */
  readonly url: (index: number) => string;
  /** Headers every request carries. */
  readonly headers: Record<string, string>;
  /** Maps a parsed body onto instances. */
  readonly map: (body: unknown) => readonly ServiceInstance[];
}

/**
 * Starts a blocking-query loop and returns its unsubscribe.
 *
 * @param deps - Injected collaborators
 * @returns Unsubscribe, which aborts the in-flight request and ends the loop
 * @since 0.2.0
 */
export function watchConsulService(deps: ConsulWatchDeps): Promise<Unsubscribe> {
  const controller = new AbortController();
  let stopped = false;
  let index = 0;
  let backoffMs = INITIAL_BACKOFF_MS;

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const handle = deps.runtime.setTimeout(() => resolve(), ms);
      controller.signal.addEventListener('abort', () => {
        deps.runtime.clearTimeout(handle);
        resolve();
      }, { once: true });
    });

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const response = await deps.http.request(deps.url(index), {
          headers: deps.headers,
          signal: controller.signal,
        });
        if (stopped) {
          return;
        }
        if (!response.ok) {
          throw new Error(
            `Consul blocking query for '${deps.serviceName}' returned HTTP ${response.status}`,
          );
        }
        index = nextIndex(index, response.headers.get('X-Consul-Index'));
        backoffMs = INITIAL_BACKOFF_MS;
        deps.listener(deps.map(JSON.parse(response.text)));
      } catch {
        if (stopped) {
          return;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  };

  // Deliberately not awaited: the loop runs for the lifetime of the watch, so
  // awaiting it here would never return an unsubscribe.
  void loop();

  return Promise.resolve(() => {
    stopped = true;
    controller.abort();
  });
}

/**
 * Applies Consul's two documented index rules.
 *
 * @param current - The index the last request used
 * @param header - The `X-Consul-Index` response header, if present
 * @returns The index the next request should use
 * @since 0.2.0
 */
export function nextIndex(current: number, header: string | null): number {
  const parsed = header === null ? Number.NaN : Number.parseInt(header, 10);
  if (!Number.isFinite(parsed)) {
    return current;
  }
  // An index below 1 is invalid and busy-loops older servers.
  if (parsed <= 0) {
    return 1;
  }
  // A backwards index means the server restarted; resuming from it would miss
  // every update until the new server caught up past the old value.
  if (parsed < current) {
    return 0;
  }
  return parsed;
}
