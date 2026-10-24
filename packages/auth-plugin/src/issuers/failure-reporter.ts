/**
 * De-duplicates a provider's failure reports into one line per state change.
 * Internal: used by the issuer key-set caches and the sign-in routes, never
 * exported from the package barrel.
 *
 * A provider outage lasts many requests, and an unauthenticated login route is
 * an easy log-flood target. Each key therefore remembers the last reason it
 * reported: a new or changed reason goes to `warn`, a repeat to `debug`, and
 * {@linkcode StateChangeReporter.recovered} forgets the key so the next outage
 * warns again. Both sinks are best-effort — a throwing logger must not change
 * the outcome whose failure it describes.
 *
 * @module
 */

/** The two log sinks a state-change reporter writes to. */
export interface StateChangeSinks {
  /** Receives the first report of a reason, and any change of reason. */
  readonly warn: (message: string) => void;
  /** Receives a repeat of the reason already reported for the key. */
  readonly debug: (message: string) => void;
}

/**
 * A per-key failure reporter whose level depends on whether the reason changed.
 */
export interface StateChangeReporter {
  /**
   * Reports one failure for `key`.
   *
   * @param key - The provider or issuer the failure belongs to
   * @param reason - A fixed reason code, never response data
   * @param message - The operator line to write
   */
  failed(key: string, reason: string, message: string): void;
  /**
   * Forgets `key`, so its next failure reports at `warn` again.
   *
   * @param key - The provider or issuer that recovered
   */
  recovered(key: string): void;
}

/**
 * Builds a reporter that warns once per reason change and debugs repeats.
 *
 * @param sinks - The warn and debug sinks, both called best-effort
 * @returns A reporter keyed by provider or issuer name
 */
export function createStateChangeReporter(sinks: StateChangeSinks): StateChangeReporter {
  const reasons = new Map<string, string>();

  const notify = (sink: (message: string) => void, message: string): void => {
    try {
      sink(message);
    } catch {
      // A failing log sink must never change the outcome being reported.
    }
  };

  return {
    failed(key: string, reason: string, message: string): void {
      if (reasons.get(key) === reason) {
        notify(sinks.debug, message);
        return;
      }
      reasons.set(key, reason);
      notify(sinks.warn, message);
    },
    recovered(key: string): void {
      reasons.delete(key);
    },
  };
}
