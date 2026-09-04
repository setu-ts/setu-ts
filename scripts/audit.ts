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
  /**
   * Whether the run was killed for exceeding its share of the budget.
   *
   * A killed run produced NO advisory data, so it is never classified: a
   * timed-out strict run plus a timed-out lenient run would otherwise read as
   * a real advisory, which is fail-closed but names the wrong cause.
   */
  readonly timedOut?: boolean;
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
 * rather than a retry.
 *
 * The bound is enforced by giving every child process the REMAINING budget as
 * a hard timeout, so total elapsed time cannot exceed this no matter how many
 * attempts run or how slow any one of them is. Checking elapsed time only
 * between attempts is NOT sufficient and was measured so: with 5-minute runs
 * the loop reached 15 minutes, because the check reserved only the backoff and
 * never accounted for the classification run or the next attempt.
 */
const TOTAL_BUDGET_MS = 12 * 60_000;

/**
 * Whether another attempt is worth starting.
 *
 * This decides whether to bother, NOT whether the step stays inside its
 * budget — that is guaranteed by the per-process timeout in `runAuditLoop`,
 * because no prediction about how long an audit will take can be trusted.
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
  /**
   * Runs `deno audit --level=high`, plus any extra flags.
   *
   * @param extra - Additional flags for this invocation
   * @param timeoutMs - Hard bound; the child is killed when it elapses, and
   *   the result then carries `timedOut: true`
   */
  readonly run: (extra: readonly string[], timeoutMs: number) => Promise<AuditRun>;
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
  /** Milliseconds left in the whole step's budget. */
  const remaining = (): number => TOTAL_BUDGET_MS - (deps.now() - started);
  const spent = (): number => Math.round((deps.now() - started) / 1000);

  /** Reports a budget exhaustion and the exit code to fail with. */
  const exhausted = (attempt: number): number => {
    deps.log(
      `audit: FAILED — the ${TOTAL_BUDGET_MS / 60_000}-minute budget is spent ` +
        `(attempt ${attempt}/${MAX_ATTEMPTS}, ${spent()}s). The npm advisory endpoint ` +
        'did not answer in time, so nothing was scanned. This is deliberately not a ' +
        'pass: a scan that produced no data is not a clean scan.',
    );
    return 1;
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const wait = backoffMs(attempt);
      deps.log(`audit: retrying in ${wait / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await deps.sleep(wait);
    }

    const strictBudget = remaining();
    if (strictBudget <= 0) return exhausted(attempt);

    const strict = await deps.run([], strictBudget);
    // A killed run scanned nothing, so it is neither clean nor classifiable.
    if (strict.timedOut === true) return exhausted(attempt);

    if (strict.code === 0) {
      if (attempt > 1) deps.log(`audit: clean on attempt ${attempt}`);
      return 0;
    }

    // Classify only when the answer can still change what we do. On the final
    // attempt the run fails either way, and the label costs another full audit.
    const lenientBudget = remaining();
    if (!shouldRetry(attempt, deps.now() - started) || lenientBudget <= 0) {
      deps.log(
        `audit: FAILED (attempt ${attempt}/${MAX_ATTEMPTS}, ${spent()}s). ` +
          'Read the audit output above: it is either a real advisory at or above ' +
          '--level=high, or the npm advisory endpoint was unavailable. This is ' +
          'deliberately not a pass — a scan that produced no data is not a clean scan.',
      );
      return strict.code === 0 ? 1 : strict.code;
    }

    deps.log('audit: non-zero exit — classifying (advisory vs registry failure)');
    const lenient = await deps.run(['--ignore-registry-errors'], lenientBudget);
    if (lenient.timedOut === true) return exhausted(attempt);

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

/**
 * Spawns one real `deno audit`, inheriting stdio so CI shows its output.
 *
 * The child is killed when `timeoutMs` elapses. `Deno.Command` with a `signal`
 * RESOLVES rather than rejecting on abort (probed: `code 143`, `SIGTERM`), so
 * the timeout is reported through `timedOut` instead of an exception — and it
 * is read from our own controller rather than from `signal === 'SIGTERM'`,
 * which something other than this deadline could also produce.
 *
 * @param extra - Additional flags for this invocation
 * @param timeoutMs - Hard bound on the child's lifetime
 * @returns The exit code, and whether the deadline killed it
 */
async function spawnAudit(extra: readonly string[], timeoutMs: number): Promise<AuditRun> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { code } = await new Deno.Command(Deno.execPath(), {
      args: ['audit', '--level=high', ...extra],
      stdout: 'inherit',
      stderr: 'inherit',
      signal: controller.signal,
    }).output();
    return { code, timedOut: controller.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
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
