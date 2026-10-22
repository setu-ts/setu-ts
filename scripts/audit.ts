/* eslint-disable no-console -- vulnerability gate */
/** Audits the pnpm lock, retrying registry failures within a fixed budget. @module */

import { run as runProcess } from './lib/run.ts';

/** Captured pnpm audit output. */
export interface AuditRun {
  readonly code: number;
  readonly stdout: string;
  readonly timedOut?: boolean;
}

/** A failed scan is never classified as a clean scan. */
export type AuditOutcome = { readonly kind: 'clean' | 'advisory' | 'registry' };

/** Classifies pnpm's JSON; high or critical advisories always fail immediately. */
export function classifyAudit(result: AuditRun): AuditOutcome {
  if (result.code === 0) return { kind: 'clean' };
  let json: {
    error?: unknown;
    metadata?: { vulnerabilities?: { high?: number; critical?: number } };
  };
  try {
    json = JSON.parse(result.stdout);
  } catch {
    return { kind: 'advisory' };
  }
  const counts = json?.metadata?.vulnerabilities;
  if ((counts?.high ?? 0) > 0 || (counts?.critical ?? 0) > 0) return { kind: 'advisory' };
  return { kind: json?.error === undefined ? 'advisory' : 'registry' };
}

/** Backoff before a one-based attempt. */
export function backoffMs(attempt: number): number {
  return attempt <= 1 ? 0 : Math.min(2000 * 2 ** (attempt - 2), 30_000);
}
const MAX_ATTEMPTS = 3;
const TOTAL_BUDGET_MS = 12 * 60_000;

/** Whether a further attempt fits the count and remaining budget. */
export function shouldRetry(attempt: number, elapsedMs: number): boolean {
  return attempt < MAX_ATTEMPTS && elapsedMs + backoffMs(attempt + 1) < TOTAL_BUDGET_MS;
}

/** Process, clock and sleep seams for deterministic retry tests. */
export interface AuditDeps {
  readonly run: (timeoutMs: number) => Promise<AuditRun>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
}

/** Retries registry errors, never advisories or unclassifiable failures. */
export async function runAuditLoop(deps: AuditDeps): Promise<number> {
  const started = deps.now();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await deps.sleep(backoffMs(attempt));
    const remaining = TOTAL_BUDGET_MS - (deps.now() - started);
    if (remaining <= 0) {
      deps.log('audit: FAILED — budget is spent; nothing was scanned');
      return 1;
    }
    const result = await deps.run(remaining);
    if (result.timedOut) {
      deps.log('audit: FAILED — budget is spent; nothing was scanned');
      return 1;
    }
    const outcome = classifyAudit(result);
    if (outcome.kind === 'clean') return 0;
    if (outcome.kind === 'advisory') {
      deps.log('audit: real advisory or unclassifiable failure; not retried');
      return result.code;
    }
    if (!shouldRetry(attempt, deps.now() - started)) {
      deps.log('audit: FAILED — registry unavailable; a scan with no data is not a pass');
      return result.code;
    }
    deps.log('audit: registry failure; retrying');
  }
  return 1;
}

/** Runs the real audit while preserving JSON for classification and CI evidence. */
export async function runAudit(
  timeoutMs: number,
  run: typeof runProcess = runProcess,
): Promise<AuditRun> {
  const result = await run('pnpm', ['audit', '--audit-level', 'high', '--json'], {
    timeoutMs,
  });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return { ...result, timedOut: result.code === 124 };
}

/** Production audit dependencies, shared with the command entry. */
export const auditDeps: AuditDeps = {
  run: runAudit,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
  log: (message) => console.log(message),
};

if (import.meta.main) process.exitCode = await runAuditLoop(auditDeps);
