/**
 * The decidable logic in `scripts/audit.ts`.
 *
 * The script itself spawns `deno audit` and sleeps, so it is not added to
 * `script-coverage.ts`'s `SCRIPT_TARGETS` — the M39 `check-deploy.ts`
 * precedent, where the orchestration is left to the real CI run and the
 * decidable parts are exported and unit-tested instead.
 *
 * What is worth pinning here is the CLASSIFICATION, because getting it wrong
 * in either direction is a real defect: retrying a genuine advisory only
 * delays the report, and treating a real advisory as transient would retry it
 * three times and then still fail — but an unclassifiable failure that got
 * retried into a pass would be the false-pass this whole wrapper exists to
 * avoid.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { AuditDeps, AuditRun } from '../../scripts/audit.ts';
import { backoffMs, classifyAudit, runAuditLoop, shouldRetry } from '../../scripts/audit.ts';

/**
 * Drives the loop against a scripted sequence of exit codes.
 *
 * The live endpoint flaps, and each failing real audit hangs for about five
 * minutes, so an end-to-end run can neither be made deterministic nor be
 * completed inside a sensible budget. The seam is what makes the loop's
 * decisions provable: this records the exact argument lists it was called
 * with, so "classified" and "retried" are observed rather than inferred.
 *
 * @param codes - One exit code per invocation, in order
 * @param msPerRun - How much the fake monotonic clock advances per audit run.
 *   A CONSTANT clock cannot exercise the budget branch at all, because the
 *   loop measures elapsed time from its own start rather than an absolute.
 * @returns The deps to pass, plus the recorded calls, waits and log lines
 */
function scripted(codes: readonly number[], msPerRun = 0): {
  deps: AuditDeps;
  calls: string[][];
  budgets: number[];
  waits: number[];
  logs: string[];
} {
  const calls: string[][] = [];
  const budgets: number[] = [];
  const waits: number[] = [];
  const logs: string[] = [];
  let clock = 0;
  let index = 0;

  const deps: AuditDeps = {
    run: (extra, timeoutMs): Promise<AuditRun> => {
      calls.push([...extra]);
      budgets.push(timeoutMs);
      // Honour the deadline the way a killed child does, so the fake cannot
      // silently overrun a bound the real runner enforces.
      const timedOut = msPerRun > timeoutMs;
      clock += Math.min(msPerRun, timeoutMs);
      if (timedOut) return Promise.resolve({ code: 143, timedOut: true });
      const code = codes[index++];
      if (code === undefined) throw new Error(`unscripted audit call #${index}`);
      return Promise.resolve({ code });
    },
    // Never a real timer: a test must not spend the backoff it asserts.
    sleep: (ms): Promise<void> => {
      waits.push(ms);
      return Promise.resolve();
    },
    now: () => clock,
    log: (message) => logs.push(message),
  };

  return { deps, calls, budgets, waits, logs };
}

describe('classifyAudit', () => {
  it('reports a zero-exit strict run as clean', () => {
    expect(classifyAudit({ code: 0 }, null)).toEqual({ kind: 'clean' });
    // The lenient run is irrelevant once strict passed.
    expect(classifyAudit({ code: 0 }, { code: 1 })).toEqual({ kind: 'clean' });
  });

  it('reports a registry failure when the lenient run flips to zero', () => {
    // `--ignore-registry-errors` exits 0 for a registry failure and stays
    // non-zero for a real advisory, so the flip IS the discriminator — no
    // matching on error text, which would rot as Deno's messages change.
    expect(classifyAudit({ code: 1 }, { code: 0 })).toEqual({ kind: 'registry' });
  });

  it('reports a real advisory when the lenient run also fails', () => {
    expect(classifyAudit({ code: 1 }, { code: 1 })).toEqual({ kind: 'advisory' });
  });

  it('FAILS CLOSED when the failure cannot be classified', () => {
    // The safety property. An unclassifiable failure must read as a real
    // advisory, so it fails the gate immediately rather than being retried —
    // and never retried into a pass.
    expect(classifyAudit({ code: 1 }, null)).toEqual({ kind: 'advisory' });
  });

  it('treats any non-zero strict code as a failure, not just 1', () => {
    // `deno audit` is not documented to use only exit 1, and a signal death
    // surfaces as a large code. Anything non-zero is ambiguous.
    for (const code of [2, 101, 130, 255, -1]) {
      expect(classifyAudit({ code }, { code: 0 }), `code ${code}`).toEqual({ kind: 'registry' });
      expect(classifyAudit({ code }, { code: 7 }), `code ${code}`).toEqual({ kind: 'advisory' });
    }
  });
});

describe('backoffMs', () => {
  it('does not wait before the first attempt', () => {
    expect(backoffMs(1)).toBe(0);
    // A caller that passed 0 or a negative must not get a negative delay.
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(-1)).toBe(0);
  });

  it('doubles from two seconds', () => {
    expect(backoffMs(2)).toBe(2_000);
    expect(backoffMs(3)).toBe(4_000);
    expect(backoffMs(4)).toBe(8_000);
  });

  it('caps so a retry budget cannot grow without bound', () => {
    // Each audit itself takes minutes, so an uncapped doubling would blow the
    // job's time budget rather than help.
    expect(backoffMs(20)).toBe(30_000);
    expect(backoffMs(100)).toBe(30_000);
  });

  it('never returns a non-finite or negative delay', () => {
    // A non-finite delay would make `setTimeout` fire immediately, turning the
    // backoff into a hot loop against an endpoint that is already struggling.
    for (const attempt of [1, 2, 5, 50, 1000, Number.MAX_SAFE_INTEGER]) {
      const ms = backoffMs(attempt);
      expect(Number.isFinite(ms), `attempt ${attempt}`).toBe(true);
      expect(ms >= 0, `attempt ${attempt}`).toBe(true);
      expect(ms <= 30_000, `attempt ${attempt}`).toBe(true);
    }
  });
});

describe('shouldRetry', () => {
  it('allows a retry while attempts and budget remain', () => {
    expect(shouldRetry(1, 0)).toBe(true);
    expect(shouldRetry(2, 0)).toBe(true);
  });

  it('stops once the attempts are exhausted', () => {
    // MAX_ATTEMPTS is 3, so the third attempt is the last one.
    expect(shouldRetry(3, 0)).toBe(false);
    expect(shouldRetry(4, 0)).toBe(false);
  });

  it('stops when the wall-clock budget is spent', () => {
    // A failing audit hangs ~5 minutes, so three of them plus classification
    // runs would be a runaway job. The budget is the real bound.
    expect(shouldRetry(1, 12 * 60_000)).toBe(false);
    expect(shouldRetry(1, 5 * 60_000)).toBe(true);
    // The BACKOFF counts toward the budget, so the step cannot start a wait it
    // has no room to finish: 11m59s + a 2s backoff is over the 12m bound.
    expect(shouldRetry(1, 11 * 60_000 + 59_000)).toBe(false);
    expect(shouldRetry(1, 11 * 60_000 + 57_000)).toBe(true);
  });
});

describe('runAuditLoop', () => {
  it('costs exactly one invocation when the audit is clean', async () => {
    // The wrapper must add nothing in the common case — no classification
    // run, no wait.
    const { deps, calls, waits } = scripted([0]);

    expect(await runAuditLoop(deps)).toBe(0);
    expect(calls).toEqual([[]]);
    expect(waits).toEqual([]);
  });

  it('fails immediately on a real advisory, with no retry', async () => {
    // strict fails, lenient also fails => a genuine advisory. Retrying a
    // deterministic result only delays the report.
    const { deps, calls, waits, logs } = scripted([1, 1]);

    expect(await runAuditLoop(deps)).toBe(1);
    expect(calls).toEqual([[], ['--ignore-registry-errors']]);
    expect(waits).toEqual([]);
    expect(logs.some((line) => line.includes('real advisory'))).toBe(true);
  });

  it('retries a registry failure and returns 0 once it clears', async () => {
    // strict fails, lenient passes => registry. Second strict run is clean.
    const { deps, calls, waits } = scripted([1, 0, 0]);

    expect(await runAuditLoop(deps)).toBe(0);
    expect(calls).toEqual([[], ['--ignore-registry-errors'], []]);
    expect(waits).toEqual([2_000]);
  });

  it('FAILS after every attempt is a registry failure', async () => {
    // The safety property, and the whole reason this wrapper is not
    // `--ignore-registry-errors`: no advisory data was received, so nothing
    // was scanned, so the run must not be a pass.
    const { deps, calls, logs } = scripted([1, 0, 1, 0, 1]);

    expect(await runAuditLoop(deps)).toBe(1);
    // 3 strict + 2 classifications; the LAST attempt does not classify,
    // because the answer could no longer change what we do.
    expect(calls.length).toBe(5);
    expect(logs.some((line) => line.includes('FAILED'))).toBe(true);
    expect(logs.some((line) => line.includes('not a pass'))).toBe(true);
  });

  it('skips the classification run on the final attempt', async () => {
    // A failing audit costs ~5 minutes; labelling a failure that fails either
    // way is pure waste. Three registry failures reach the last attempt, which
    // must not spend another audit on a label.
    const { deps, calls } = scripted([1, 0, 1, 0, 1]);

    expect(await runAuditLoop(deps)).toBe(1);
    // 3 strict + 2 classifications, NOT 3 + 3.
    expect(calls.filter((c) => c.length === 0).length).toBe(3);
    expect(calls.filter((c) => c.includes('--ignore-registry-errors')).length).toBe(2);
  });

  it('bounds total elapsed time however slow the audits are', async () => {
    // The invariant, and the reason the bound is a per-process timeout rather
    // than an elapsed check between attempts: with 5-minute runs the earlier
    // between-attempts form reached 15 minutes against a 12-minute budget,
    // because it reserved only the backoff and never accounted for the
    // classification run or the next attempt.
    let clock = 0;
    const FIVE_MIN = 5 * 60_000;
    const codes = [1, 0, 1, 0, 1];
    let i = 0;

    const code = await runAuditLoop({
      run: (_extra, timeoutMs) => {
        const ran = Math.min(FIVE_MIN, timeoutMs);
        clock += ran;
        return Promise.resolve(
          ran < FIVE_MIN ? { code: 143, timedOut: true } : { code: codes[i++] ?? 1 },
        );
      },
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      log: () => {},
    });

    expect(code).not.toBe(0);
    expect(clock).toBeLessThanOrEqual(12 * 60_000);
  });

  it('hands every run the REMAINING budget, never the full one', async () => {
    // Each successive process must get less, or a late attempt could run for
    // the whole budget again.
    const { deps, budgets } = scripted([1, 0, 1, 0, 1], 60_000);

    await runAuditLoop(deps);
    expect(budgets.length).toBe(5);
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]! < budgets[i - 1]!, `budget ${i} shrank`).toBe(true);
    }
    expect(budgets[0]).toBe(12 * 60_000);
  });

  it('fails closed on a timed-out run rather than classifying it', async () => {
    // A killed audit produced no advisory data. Classifying it would report a
    // real advisory (fail-closed, but naming the wrong cause).
    const { deps, calls, logs } = scripted([1], 13 * 60_000);

    expect(await runAuditLoop(deps)).toBe(1);
    expect(calls).toEqual([[]]);
    expect(logs.some((line) => line.includes('budget is spent'))).toBe(true);
    expect(logs.some((line) => line.includes('nothing was scanned'))).toBe(true);
  });

  it('propagates a non-1 exit code rather than normalising it', async () => {
    const { deps } = scripted([101, 101]);

    expect(await runAuditLoop(deps)).toBe(101);
  });
});
