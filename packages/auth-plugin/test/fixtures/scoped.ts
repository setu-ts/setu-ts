/**
 * Shared fixtures for the scoped RBAC unit tests: a manual clock and timer
 * surface, a recording logger, a request context, and a harness that wires
 * the real resolver, evaluator and policy over them.
 *
 * @module
 */
import type {
  ILogger,
  IPrincipal,
  IRequestContext,
  LogMetadata,
  ProbeTiming,
  RbacConfig,
  TimerHandle,
} from '@setu-ts/common';
import type { ScopedRbacOptions } from '../../src/interfaces/index.ts';
import { compileScopedRbac } from '../../src/scoped/options.ts';
import type { CompiledScopedRbac } from '../../src/scoped/options.ts';
import { createScopedRbac } from '../../src/scoped/scoped-policy.ts';
import type { ScopedRbac } from '../../src/scoped/scoped-policy.ts';

/** A timer surface whose clock only moves when told to. */
export interface ManualTiming extends ProbeTiming {
  /** Advances the clock, firing every timer that comes due. */
  advance(ms: number): void;
  /** Timers armed and not yet fired or cleared. */
  pending(): number;
}

/**
 * Builds a manual timer surface, the shape `resolveProbeTiming` returns —
 * `hrtime` is monotonic and timers fire only through `advance`.
 *
 * @returns The timing
 */
export function manualTiming(): ManualTiming {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { readonly at: number; readonly fn: () => void }>();
  return {
    hrtime: () => now,
    setTimer: (fn: () => void, ms: number): TimerHandle => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (handle: TimerHandle) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

/** One recorded log call. */
export interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly fields: LogMetadata | undefined;
}

/** A logger recording every call, honouring the whole `ILogger` contract. */
export interface RecordingLogger extends ILogger {
  /** Every call, in order. */
  readonly records: LogRecord[];
}

/**
 * Builds a recording logger.
 *
 * @returns The logger
 */
export function recordingLogger(): RecordingLogger {
  const records: LogRecord[] = [];
  const at = (level: string) => (message: string, fields?: LogMetadata) => {
    records.push({ level, message, fields });
  };
  const logger: RecordingLogger = {
    level: 'trace',
    records,
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    child: () => logger,
  };
  return logger;
}

/**
 * Builds a request context carrying a fresh `state` map — the per-request memo
 * is keyed by it — and, optionally, a resolved tenant and route parameters.
 *
 * @param options - The tenant and parameters
 * @returns The context
 */
export function requestContext(
  options: { tenant?: string; params?: Record<string, string> } = {},
): IRequestContext {
  return {
    request: options.tenant === undefined ? {} : { tenant: { id: options.tenant } },
    params: options.params ?? {},
    state: new Map(),
  } as unknown as IRequestContext;
}

/** The catalogue every scoped test uses unless it brings its own. */
export const CATALOGUE: RbacConfig = {
  roles: {
    viewer: { permissions: ['invoices:read'] },
    approver: { permissions: ['invoices:approve'], inherits: ['viewer'] },
    owner: { permissions: ['*'] },
  },
};

/** A signed-in principal. */
export function principal(id = 'u1', extra: Partial<IPrincipal> = {}): IPrincipal {
  return { id, ...extra };
}

/** The harness: the real scoped parts over a manual clock and a recording logger. */
export interface ScopedHarness extends ScopedRbac {
  readonly config: CompiledScopedRbac;
  readonly timing: ManualTiming;
  readonly logger: RecordingLogger;
}

/**
 * Compiles `options` against the catalogue and wires the real resolver,
 * evaluator and policy, bound to an empty registry.
 *
 * @param options - The `scopedRbac` option
 * @param rbac - The catalogue
 * @returns The harness
 */
export function scopedHarness(
  options: ScopedRbacOptions,
  rbac: RbacConfig = CATALOGUE,
): ScopedHarness {
  const config = compileScopedRbac(options, rbac, true);
  const timing = manualTiming();
  const logger = recordingLogger();
  const parts = createScopedRbac(config, timing, () => logger);
  parts.resolver.bind({} as never);
  return { ...parts, config, timing, logger };
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}
