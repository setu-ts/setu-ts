import type { IPrincipal, IServiceRegistry } from '@setu-ts/common';
import { AgentRunDefinitionError } from '@setu-ts/common';
import type { LanguageModel, ToolSet } from 'ai';

/** Server-owned identity supplied on every model and tool call. @since 0.12.0 */
export interface AgentRunContext {
  /** Parent run id. */
  readonly runId: string;
  /** Persisted tenant id; the empty string denotes a tenant-less run. */
  readonly tenantId: string;
  /** Original authenticated subject, or null when absent. */
  readonly principalId: string | null;
  /** Application service registry available after a restart. */
  readonly services: IServiceRegistry;
  /** Abort signal for cancellation, fencing or the configured call deadline. */
  readonly signal: AbortSignal;
}
/** Stable key and transaction scope available to a tool context builder. @since 0.12.0 */
export interface AgentRunToolCall {
  /** SDK tool-call id. */
  readonly toolCallId: string;
  /** Application tool name. */
  readonly toolName: string;
  /** Stable SHA-256 key for this run, model entry and tool call. */
  readonly idempotencyKey: string;
  /** Transaction scope supplied by the idempotency service. */
  readonly unitOfWork: unknown;
}
/** Durable server-side approval policy. @since 0.12.0 */
export interface AgentRunApprovalOptions {
  /** Approval policy per tool name: always, or a predicate over the call input. */
  readonly tools: Readonly<
    Record<string, true | ((input: unknown, run: AgentRunContext) => boolean | Promise<boolean>)>
  >;
  /** Approval deadline duration; defaults to one day. */
  readonly timeoutMs?: number;
  /** Custom authorization predicate for an approval decision. */
  readonly canDecide?: (principal: IPrincipal | undefined, run: AgentRunContext) => boolean;
}
/** Immutable application definition for new and recovered runs. @since 0.12.0 */
export interface AgentRunDefinition {
  /** Unique definition name, stored on each run to find its definition on resume. */
  readonly name: string;
  /** Definition version stamped at creation. */
  readonly version: string;
  /** Older definition versions this release can resume. */
  readonly compatibleVersions?: readonly string[];
  /** Factory evaluated for every model call with persisted run identity. */
  readonly model: (run: AgentRunContext) => LanguageModel;
  /** Optional system prompt supplied on each model call. */
  readonly system?: string;
  /** SDK tool definitions, each with an `execute`. */
  readonly tools?: ToolSet;
  /** Builds context keyed by tool name from server identity and transaction scope. */
  readonly toolsContext?: (run: AgentRunContext, call: AgentRunToolCall) => Record<string, unknown>;
  /** Maximum model calls; defaults to twenty. */
  readonly maxSteps?: number;
  /** Required output-token bound supplied to the model. */
  readonly maxOutputTokens: number;
  /** Durable approval configuration. */
  readonly approval?: AgentRunApprovalOptions;
  /**
   * Who may read, stream or cancel a run. Defaults to the principal that
   * started it; a run started without a principal is open to its tenant.
   * A refusal is the same 404 as a missing run.
   */
  readonly canAccess?: (principal: IPrincipal | undefined, run: AgentRunContext) => boolean;
  /** Per-call deadlines and tool timeout recovery bounds. */
  readonly timeouts?: {
    /** Model deadline in milliseconds; a timeout fails the run. */
    readonly modelMs?: number;
    /** Tool deadline in milliseconds; a timeout defers to sweep recovery. */
    readonly toolMs?: number;
    /** Timed-out attempts per call before failure; defaults to 3, used only with toolMs. @since 0.12.0 */
    readonly toolAttempts?: number;
  };
}
/** Validate a finite positive integer bound. @internal */
export function integer(value: number, name: string, min = 1, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`Agent runs: invalid ${name}.`);
  return value;
}
/**
 * Validate and freeze a run definition, including its nested configuration.
 * @param definition - Application model, tools, approval policy and version
 * @returns A frozen snapshot
 * @throws {AgentRunDefinitionError} For invalid configuration
 * @since 0.12.0
 */
export function defineAgentRun(definition: AgentRunDefinition): AgentRunDefinition {
  try {
    if (
      !definition ||
      !definition.name?.trim() ||
      !definition.version?.trim() ||
      typeof definition.model !== 'function'
    )
      throw new TypeError();
    integer(definition.maxOutputTokens, 'maxOutputTokens');
    integer(definition.maxSteps ?? 20, 'maxSteps', 1, 1000);
    if (definition.compatibleVersions?.some((v) => typeof v !== 'string' || !v.trim()))
      throw new TypeError();
    if (definition.system !== undefined && typeof definition.system !== 'string')
      throw new TypeError();
    for (const [name, value] of Object.entries(definition.timeouts ?? {}))
      integer(value, `timeouts.${name}`);
    if (definition.toolsContext !== undefined && typeof definition.toolsContext !== 'function')
      throw new TypeError();
    if (definition.canAccess !== undefined && typeof definition.canAccess !== 'function')
      throw new TypeError();
    for (const tool of Object.values(definition.tools ?? {}))
      if (!tool || !tool.inputSchema || typeof tool.execute !== 'function') throw new TypeError();
    if (definition.approval) {
      integer(definition.approval.timeoutMs ?? 86_400_000, 'approval.timeoutMs', 1, 2_592_000_000);
      if (
        !definition.approval.tools ||
        (definition.approval.canDecide !== undefined &&
          typeof definition.approval.canDecide !== 'function')
      )
        throw new TypeError();
      for (const [name, policy] of Object.entries(definition.approval.tools))
        if (
          !Object.hasOwn(definition.tools ?? {}, name) ||
          (policy !== true && typeof policy !== 'function')
        )
          throw new TypeError();
    }
  } catch (cause) {
    throw new AgentRunDefinitionError(
      cause instanceof Error
        ? cause.message || 'Invalid agent run definition.'
        : 'Invalid agent run definition.',
    );
  }
  return Object.freeze({
    ...definition,
    maxSteps: definition.maxSteps ?? 20,
    ...(definition.tools
      ? {
          tools: Object.freeze(
            Object.fromEntries(
              Object.entries(definition.tools).map(([name, tool]) => [
                name,
                Object.freeze({ ...tool }),
              ]),
            ),
          ),
        }
      : {}),
    ...(definition.compatibleVersions
      ? { compatibleVersions: Object.freeze([...definition.compatibleVersions]) }
      : {}),
    ...(definition.timeouts ? { timeouts: Object.freeze({ ...definition.timeouts }) } : {}),
    ...(definition.approval
      ? {
          approval: Object.freeze({
            ...definition.approval,
            tools: Object.freeze({ ...definition.approval.tools }),
          }),
        }
      : {}),
  });
}
