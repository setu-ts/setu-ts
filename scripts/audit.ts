// deno-lint-ignore-file no-console -- a CI entry point; `scripts/` is exempt
/**
 * `deno audit` with bounded retries for a flaking npm advisories endpoint.
 *
 * `deno audit` asks `registry.npmjs.org/-/npm/v1/security/advisories/bulk` for
 * advisory data. That endpoint flakes, and when it does the audit fails in one
 * of two ways, neither of which says anything about this repository's
 * dependencies:
 *
 * ```
 * error: error sending request ... client error (SendRequest): connection error: connection reset
 * error: Failed to deserialize response from the npm registry API
 *   Caused by: invalid type: string "Service Unavailable", expected a sequence at line 1 column 30
 * ```
 *
 * The second is worth reading twice: the endpoint answered `503` with a JSON
 * error body, and `deno audit` tried to deserialize that body as advisory data.
 * "Failed to deserialize" reads like a corrupt lockfile, which is exactly the
 * wrong place to go looking.
 *
 * ## Why not `--ignore-registry-errors`
 *
 * `deno audit` ships a flag that makes this exit `0` — and using it would be a
 * defect, not a fix. It converts "the scan could not run" into "no
 * vulnerabilities", silently and permanently, which is the false pass this
 * repository already builds machinery against: `scripts/check-apps.ts` reserves
 * exit **77** so an unavailable prerequisite can never read as a pass, and its
 * `ALLOW_SKIP` allowlist turns a skip CI could have covered into a *failure*.
 * A security gate that greens itself during a registry outage is the same
 * defect with higher stakes.
 *
 * So the flag is used to **classify**, never to suppress:
 *
 * 1. Run the strict audit. Exit `0` → clean, done.
 * 2. Non-zero is ambiguous — a real advisory, or a registry error. Re-run once
 *    with `--ignore-registry-errors`. If that flips to `0`, the cause was the
 *    registry alone; otherwise a real advisory is present.
 * 3. A real advisory **fails immediately**, with no retries: it is
 *    deterministic, so retrying only delays the report.
 * 4. A registry error is retried with backoff, and if every attempt is a
 *    registry error the run still **FAILS**. Absorbing transience must never
 *    become tolerating an unknown.
 *
 * @module
 */

/** How the strict audit's failure was classified. */
export type AuditOutcome =
  /** No advisory at or above the configured level. */
  | { readonly kind: 'clean' }
  /** A genuine advisory. Deterministic — fail now, never retry. */
  | { readonly kind: 'advisory' }
  /** The advisory endpoint failed. Transient — worth retrying. */
  | { readonly kind: 'registry' };

/** One completed `deno audit` invocation. */
export interface AuditRun {
  /** The process exit code. */
  readonly code: number;
}

/**
 * Classifies a strict audit result, using a lenient re-run to tell a real
 * advisory from a registry failure.
 *
 * A `null` lenient run means the classification could not be made, and that
 * case is deliberately reported as `'advisory'`: an unclassifiable failure
 * must fail the gate rather than be retried into a pass. Fail closed.
 *
 * @param strict - The `deno audit --level=high` run
 * @param lenient - The same run with `--ignore-registry-errors`, or `null`
 *   when it was not or could not be performed
 * @returns What the failure was
 *
 * @example
 * ```typescript
 * classifyAudit({ code: 0 }, null);            // { kind: 'clean' }
 * classifyAudit({ code: 1 }, { code: 0 });     // { kind: 'registry' }
 * classifyAudit({ code: 1 }, { code: 1 });     // { kind: 'advisory' }
 * classifyAudit({ code: 1 }, null);            // { kind: 'advisory' } — fail closed
 * ```
 */
export function classifyAudit(strict: AuditRun, lenient: AuditRun | null): AuditOutcome {
  if (strict.code === 0) return { kind: 'clean' };
  if (lenient === null) return { kind: 'advisory' };
  return lenient.code === 0 ? { kind: 'registry' } : { kind: 'advisory' };
}

/**
 * The backoff before attempt `n`, in milliseconds.
 *
 * Doubling from two seconds, capped at thirty. The endpoint was observed
 * flapping on a scale of seconds — two consecutive successes, then another
 * `503` — so a short first wait is what actually gets through, and the cap
 * keeps three attempts inside a sensible CI budget given each audit itself
 * takes minutes.
 *
 * @param attempt - The 1-based attempt about to be made
 * @returns The delay in milliseconds; `0` before the first attempt
 *
 * @example
 * ```typescript
 * backoffMs(1); // 0
 * backoffMs(2); // 2000
 * backoffMs(3); // 4000
 * ```
 */
export function backoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return Math.min(2000 * 2 ** (attempt - 2), 30_000);
}

/** How many times a registry failure is retried before the run fails. */
const MAX_ATTEMPTS = 3;

/**
 * The whole step's wall-clock budget.
 *
 * Attempt COUNT alone is not a bound here, and that was found by running it: a
 * healthy audit finishes in about a minute, but a failing one *hangs* on the
 * advisory endpoint for roughly five before giving up. Three attempts plus a
 * classification run each is therefore ~25 minutes, which is a runaway CI job
 * rather than a retry. The budget bounds the step no matter how slow an
 * individual attempt turns out to be.
 */
const TOTAL_BUDGET_MS = 12 * 60_000;

/**
 * Whether another attempt should be made.
 *
 * @param attempt - The 1-based attempt just completed
 * @param elapsedMs - Wall-clock milliseconds since the step began
 * @returns `true` when a further attempt is both allowed and affordable
 *
 * @example
 * ```typescript
 * shouldRetry(1, 0);            // true
 * shouldRetry(3, 0);            // false — attempts exhausted
 * shouldRetry(1, 11 * 60_000);  // false — no room for another ~5m attempt
 * ```
 */
export function shouldRetry(attempt: number, elapsedMs: number): boolean {
  if (attempt >= MAX_ATTEMPTS) return false;
  // Require room for the backoff AND a further attempt, so the step cannot
  // start work it has no budget to finish.
  return elapsedMs + backoffMs(attempt + 1) < TOTAL_BUDGET_MS;
}

/** The seams the loop drives, injectable so it is testable without spawning. */
export interface AuditDeps {
  /** Runs `deno audit --level=high`, plus any extra flags. */
  readonly run: (extra: readonly string[]) => Promise<AuditRun>;
  /** Waits, so a flapping endpoint gets a moment to recover. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. NEVER `Date.now()` — this measures a duration. */
  readonly now: () => number;
  /** Where progress and failures are reported. */
  readonly log: (message: string) => void;
}

/**
 * Runs the audit, retrying only a registry failure.
 *
 * Strict runs FIRST, so the common case — a clean audit — costs exactly one
 * invocation and the wrapper adds nothing. The classification run happens only
 * on a failure, and only while an attempt remains: on the last attempt there
 * is nothing left to decide, so paying five minutes to label the failure would
 * be waste.
 *
 * @param deps - The injected runner, clock, sleeper and log sink
 * @returns The exit code to leave the process with
 */
export async function runAuditLoop(deps: AuditDeps): Promise<number> {
  const started = deps.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const wait = backoffMs(attempt);
      deps.log(`audit: retrying in ${wait / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await deps.sleep(wait);
    }

    const strict = await deps.run([]);
    if (strict.code === 0) {
      if (attempt > 1) deps.log(`audit: clean on attempt ${attempt}`);
      return 0;
    }

    const elapsed = deps.now() - started;
    const retrying = shouldRetry(attempt, elapsed);

    // Classify only when the answer can still change what we do. On the final
    // attempt the run fails either way, and the label costs another full audit.
    if (!retrying) {
      deps.log(
        `audit: FAILED (attempt ${attempt}/${MAX_ATTEMPTS}, ${Math.round(elapsed / 1000)}s). ` +
          'Read the audit output above: it is either a real advisory at or above ' +
          '--level=high, or the npm advisory endpoint was unavailable. This is ' +
          'deliberately not a pass — a scan that produced no data is not a clean scan.',
      );
      return strict.code === 0 ? 1 : strict.code;
    }

    deps.log('audit: non-zero exit — classifying (advisory vs registry failure)');
    const lenient = await deps.run(['--ignore-registry-errors']);

    if (classifyAudit(strict, lenient).kind === 'advisory') {
      deps.log(
        'audit: a real advisory at or above --level=high is present. ' +
          'Not retried: the result is deterministic.',
      );
      return strict.code;
    }

    deps.log(
      `audit: the npm advisory endpoint failed (attempt ${attempt}/${MAX_ATTEMPTS}). ` +
        'No advisory data was received, so nothing was scanned.',
    );
  }

  // Unreachable: `shouldRetry` returns false on the last attempt, so the loop
  // always returns from inside. Kept as a total function rather than a throw.
  return 1;
}

/** Spawns one real `deno audit`, inheriting stdio so CI shows its output. */
async function spawnAudit(extra: readonly string[]): Promise<AuditRun> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ['audit', '--level=high', ...extra],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  return { code };
}

if (import.meta.main) {
  Deno.exit(
    await runAuditLoop({
      run: spawnAudit,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      // Monotonic: this measures an elapsed duration, so a wall-clock jump
      // (an NTP correction mid-job) must not shorten or extend the budget.
      now: () => performance.now(),
      log: (message) => console.log(message),
    }),
  );
}
