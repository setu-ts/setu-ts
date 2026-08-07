/**
 * Kubernetes watch loop.
 *
 * The watch stream is used as a change **signal**, not as a delta log: any
 * `ADDED`/`MODIFIED`/`DELETED` event triggers a fresh LIST and the listener
 * gets the full instance set. That removes the stateful slice-by-name merge
 * where hand-rolled Kubernetes clients most often go wrong, at the cost of one
 * extra LIST per change — bounded by endpoint churn, not by time.
 *
 * @module
 */
import type { IRuntimeServices, ServiceInstance, Unsubscribe } from '@setu-ts/common';
import type { IDiscoveryHttp } from '../interfaces/index.ts';
import { readJsonLines } from '../http/ndjson.ts';

/** Initial reconnect delay after a failed watch attempt. */
const INITIAL_BACKOFF_MS = 250;
/** Ceiling the reconnect delay doubles up to. */
const MAX_BACKOFF_MS = 5_000;

/** One line of a watch stream. */
interface WatchEvent {
  readonly type?: string;
  readonly object?: { readonly metadata?: { readonly resourceVersion?: string } };
}

/** Everything the loop needs, all injectable. */
export interface KubernetesWatchDeps {
  /** The service being watched. */
  readonly serviceName: string;
  /** Called with the full instance list on every change. */
  readonly listener: (instances: readonly ServiceInstance[]) => void;
  /** The HTTP seam. */
  readonly http: IDiscoveryHttp;
  /** Supplies timers for the backoff sleep. */
  readonly runtime: IRuntimeServices;
  /** Builds the list/watch URL, with extra query parameters. */
  readonly listUrl: (extra?: Readonly<Record<string, string>>) => string;
  /** Resolves the `Authorization` header value. */
  readonly authHeader: () => Promise<string>;
  /** Maps a parsed list response onto instances. */
  readonly map: (body: unknown) => readonly ServiceInstance[];
  /** Reads `metadata.resourceVersion` from a parsed list response. */
  readonly resourceVersionOf: (body: unknown) => string | null;
}

/**
 * Starts a watch loop and returns its unsubscribe.
 *
 * @param deps - Injected collaborators
 * @returns Unsubscribe, which aborts the stream and stops the restart loop
 * @since 0.2.0
 */
export function watchKubernetesService(deps: KubernetesWatchDeps): Promise<Unsubscribe> {
  const controller = new AbortController();
  let stopped = false;
  let backoffMs = INITIAL_BACKOFF_MS;

  // The listener is removed when the timer wins, not just when abort fires.
  // Without that, a watch retrying against a failing API server adds one
  // permanent listener per retry to a signal that lives as long as the watch.
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const onAbort = (): void => {
        deps.runtime.clearTimeout(handle);
        resolve();
      };
      const handle = deps.runtime.setTimeout(() => {
        controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });

  /** LISTs, fires the listener, and returns the version to watch from. */
  const listAndFire = async (): Promise<string | null> => {
    const response = await deps.http.request(deps.listUrl(), {
      headers: { Authorization: await deps.authHeader() },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Kubernetes list for '${deps.serviceName}' returned HTTP ${response.status}`,
      );
    }
    const body: unknown = JSON.parse(response.text);
    deps.listener(deps.map(body));
    return deps.resourceVersionOf(body);
  };

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        let version = await listAndFire();
        backoffMs = INITIAL_BACKOFF_MS;

        while (!stopped) {
          const stream = await deps.http.stream(
            deps.listUrl({
              watch: 'true',
              resourceVersion: version ?? '',
              allowWatchBookmarks: 'true',
            }),
            {
              headers: { Authorization: await deps.authHeader() },
              signal: controller.signal,
            },
          );
          // 410 Gone means the version expired: the client must discard the
          // watch, re-LIST, and restart from the new version.
          if (!stream.ok || stream.body === null) {
            break;
          }

          let resync = false;
          let sawEvent = false;
          for await (const line of readJsonLines(stream.body, controller.signal)) {
            sawEvent = true;
            const event = line as WatchEvent;
            const eventVersion = event.object?.metadata?.resourceVersion;
            if (eventVersion !== undefined) {
              version = eventVersion;
            }
            if (event.type === 'BOOKMARK') {
              // Carries no object change — it exists purely to advance the
              // version so a later reconnect does not start from an expired one.
              continue;
            }
            if (event.type === 'ERROR') {
              resync = true;
              break;
            }
            version = await listAndFire();
          }
          if (resync) {
            break;
          }
          if (!sawEvent) {
            // The stream closed without delivering anything — an idle timeout,
            // or a server refusing the watch with a 200. Reconnecting straight
            // away turns that into a request flood, so the same backoff the
            // error path uses applies here too.
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
          } else {
            backoffMs = INITIAL_BACKOFF_MS;
          }
          // Otherwise the stream ended after real events — reconnect from the
          // version we last saw rather than tearing down to a fresh LIST.
        }
      } catch {
        if (stopped) {
          return;
        }
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  };

  void loop();

  return Promise.resolve(() => {
    stopped = true;
    controller.abort();
  });
}
