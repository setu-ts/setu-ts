import { CAPABILITIES } from '@setu-ts/common';
import type {
  IAgentRunStore,
  IIdempotencyService,
  ILogger,
  IPlugin,
  IPluginContext,
  IRequestContext,
  RegistryFactory,
  TimerHandle,
} from '@setu-ts/common';
import { defineAgentRun, integer } from '../definitions/define-agent-run.ts';
import type { AgentRunDefinition } from '../definitions/define-agent-run.ts';
import { loadAi } from '../runtime/ai-runtime.ts';
import { AgentRunService } from '../service/agent-run-service.ts';
import { VERSION } from '../version.ts';

/** Durable run storage, definitions and bounded execution settings. @since 0.12.0 */
export interface AgentRunsPluginOptions {
  /** Run store or registry factory; verified during registration. */
  readonly store: IAgentRunStore | RegistryFactory<IAgentRunStore>;
  /** Nonempty run definitions with unique names. */
  readonly definitions: readonly AgentRunDefinition[];
  /** Lease duration; renewed every third of this interval. */
  readonly leaseMs?: number;
  /** Grace margin before takeover, at most sixty seconds. */
  readonly maxClockSkewMs?: number;
  /** Automatic sweep interval; zero disables scheduling. */
  readonly sweepIntervalMs?: number;
  /** Maximum rows in each sweep query. */
  readonly sweepBatch?: number;
  /** Retention after a terminal transition. */
  readonly retentionMs?: number;
  /** Maximum chunk buffering interval. */
  readonly flushIntervalMs?: number;
  /** Chunk count that triggers a batch flush. */
  readonly flushChunks?: number;
  /** Retained delta budget per run. */
  readonly maxLogBytes?: number;
  /** Polling interval for cross-instance stream tails. */
  readonly pollIntervalMs?: number;
  /** Maximum UTF-8 byte length of the JSON input. */
  readonly maxInputBytes?: number;
  /** Optional host callback receiving detached execution promises. */
  readonly background?: (ctx: IRequestContext, work: Promise<void>) => void;
}
/** Resolved numeric options, shared by one service and every execution. @internal */
export type ResolvedOptions = Required<
  Omit<AgentRunsPluginOptions, 'store' | 'definitions' | 'background'>
>;
/** Validate all bounds synchronously, including clock-skew/renewal safety. @internal */
export function resolveOptions(options: AgentRunsPluginOptions): ResolvedOptions {
  const defaults: ResolvedOptions = {
    leaseMs: 30_000,
    maxClockSkewMs: 5000,
    sweepIntervalMs: 5000,
    sweepBatch: 25,
    retentionMs: 86_400_000,
    flushIntervalMs: 100,
    flushChunks: 64,
    maxLogBytes: 8 * 1024 * 1024,
    pollIntervalMs: 250,
    maxInputBytes: 262_144,
  };
  const resolved = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof ResolvedOptions)[])
    resolved[key] = integer(
      options[key] ?? defaults[key],
      key,
      key === 'maxClockSkewMs' || key === 'sweepIntervalMs' ? 0 : 1,
      key === 'maxClockSkewMs' ? 60_000 : 2_147_483_647,
    );
  if (resolved.leaseMs < 3 || resolved.leaseMs <= 3 * resolved.maxClockSkewMs)
    throw new TypeError('Agent runs: leaseMs must exceed three clock-skew margins.');
  return resolved;
}
/**
 * Register durable agent runs. The SDK loads once; storage is verified at startup.
 * @param options - Store, immutable definitions and bounds
 * @returns Single-instance plugin providing IAgentRunService
 * @throws {TypeError} For invalid options
 * @since 0.12.0
 */
export function AgentRunsPlugin(options: AgentRunsPluginOptions): IPlugin {
  if (!options || !Array.isArray(options.definitions) || options.definitions.length === 0)
    throw new TypeError('Agent runs: definitions are required.');
  if (
    !options.store ||
    (typeof options.store !== 'function' && typeof options.store.verify !== 'function')
  )
    throw new TypeError('Agent runs: store is required.');
  if (options.background !== undefined && typeof options.background !== 'function')
    throw new TypeError('Agent runs: invalid background.');
  const bounds = resolveOptions(options);
  const definitions = new Map<string, AgentRunDefinition>();
  for (const supplied of options.definitions) {
    const definition = defineAgentRun(supplied);
    if (definitions.has(definition.name)) throw new TypeError('Agent runs: duplicate definition.');
    definitions.set(definition.name, definition);
  }
  return {
    name: 'agent-runs-plugin',
    version: VERSION,
    provides: [CAPABILITIES.AGENT_RUNS],
    dependencies: [CAPABILITIES.RUNTIME, CAPABILITIES.IDEMPOTENCY],
    optionalDependencies: [CAPABILITIES.LOGGER],
    async register(ctx: IPluginContext): Promise<void> {
      let timer: TimerHandle | undefined;
      // eslint-disable-next-line prefer-const -- Failed startup closes before service construction.
      let service: AgentRunService | undefined;
      ctx.lifecycle.onClose(() => {
        if (timer !== undefined) ctx.runtime.clearInterval(timer);
        service?.close();
      });
      const store =
        typeof options.store === 'function' ? await options.store(ctx.services) : options.store;
      await store.verify();
      const ai = await loadAi();
      service = new AgentRunService({
        store,
        runtime: ctx.runtime,
        services: ctx.services,
        idempotency: ctx.services.get<IIdempotencyService>(CAPABILITIES.IDEMPOTENCY),
        ai,
        definitions,
        options: bounds,
        ...(options.background === undefined ? {} : { background: options.background }),
      });
      const registered = service;
      ctx.services.register(CAPABILITIES.AGENT_RUNS, registered);
      if (bounds.sweepIntervalMs > 0)
        timer = ctx.runtime.setInterval(() => {
          void registered.sweep().catch(() => {
            if (ctx.services.has(CAPABILITIES.LOGGER))
              ctx.services.get<ILogger>(CAPABILITIES.LOGGER).warn('Agent run sweep failed.');
          });
        }, bounds.sweepIntervalMs);
    },
  };
}
