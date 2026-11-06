import {
  AgentRunLeaseLostError,
  AgentRunStoreUnavailableError,
  CAPABILITIES,
  createCapabilityToken,
  DuplicateKeyError,
} from '@setu-ts/common';
import type {
  AgentRunRow,
  AgentRunEntryRow,
  AgentRunChunkBatch,
  AgentRunApprovalRow,
  IAgentRunStore,
  IServiceRegistry,
  RegistryFactory,
  WritePrecondition,
  FilterExpression,
} from '@setu-ts/common';
import type { IDatabaseService, IRepository } from '../interfaces/index.ts';

/** Entity and named-connection mapping for durable runs. @since 0.12.0 */
export interface DatabaseAgentRunStoreOptions {
  /** Optional mapping of the four run entities. */
  readonly entities?: {
    /** Run entity name; defaults to `AgentRun`. */
    readonly run?: string;
    /** Entry entity name; defaults to `AgentRunEntry`. */
    readonly entry?: string;
    /** Chunk-batch entity name; defaults to `AgentRunChunks`. */
    readonly chunks?: string;
    /** Approval entity name; defaults to `AgentRunApproval`. */
    readonly approval?: string;
  };
  /** Named database capability; omitted selects the default. */
  readonly database?: string;
}
type Row = Record<string, unknown>;
const DEFAULTS = {
  run: 'AgentRun',
  entry: 'AgentRunEntry',
  chunks: 'AgentRunChunks',
  approval: 'AgentRunApproval',
} as const;
const TERMINAL = ['completed', 'failed', 'cancelled'];
/** How many pages of overdue approvals one `expired()` call reads at most. */
const EXPIRY_PAGES = 4;
function comparison(field: string, operator: 'lt' | 'gte', value: number): FilterExpression {
  return { type: 'comparison', field, operator, value };
}
function decode<T>(row: Row): T {
  const copy = { ...row };
  for (const key of [
    'leaseVersion',
    'leaseUntil',
    'entryCount',
    'chunkCount',
    'stepChunkStart',
    'createdAt',
    'updatedAt',
    'seq',
    'deadline',
    'decidedAt',
  ])
    if (typeof copy[key] === 'bigint') copy[key] = Number(copy[key]);
  return copy as T;
}
function valid(run: AgentRunRow): boolean {
  return (
    typeof run.id === 'string' &&
    typeof run.tenantId === 'string' &&
    typeof run.leaseOwner === 'string' &&
    ['running', 'waiting', 'ready', ...TERMINAL].includes(run.status) &&
    Array.isArray(run.input) &&
    Array.isArray(run.approvalIds) &&
    run.approvalIds.every((id) => typeof id === 'string') &&
    [
      'leaseVersion',
      'leaseUntil',
      'entryCount',
      'chunkCount',
      'stepChunkStart',
      'createdAt',
      'updatedAt',
    ].every(
      (key) =>
        Number.isSafeInteger((run as unknown as Row)[key]) &&
        ((run as unknown as Row)[key] as number) >= 0,
    )
  );
}
/**
 * Durable run store over repositories outside transactions.
 * @since 0.12.0
 */
export class DatabaseAgentRunStore implements IAgentRunStore {
  #waitingAfter: string | undefined;
  readonly #service: IDatabaseService;
  readonly #entities: Readonly<Record<keyof typeof DEFAULTS, string>>;
  /** @param service - Database capability @param options - Entity mapping */
  constructor(service: IDatabaseService, options: DatabaseAgentRunStoreOptions = {}) {
    this.#service = service;
    this.#entities = { ...DEFAULTS, ...options.entities };
  }
  #repo(kind: keyof typeof DEFAULTS): IRepository<Row> {
    return this.#service.getRepository<Row>(this.#entities[kind]);
  }
  /** @inheritdoc */
  async verify(): Promise<void> {
    try {
      // Probe every entity: a missing child table or an adapter without
      // conditional deletes would otherwise fail the first run or every purge.
      for (const kind of ['run', 'entry', 'chunks', 'approval'] as const) {
        const repo = this.#repo(kind);
        if (!repo.deleteWhere || ((kind === 'run' || kind === 'approval') && !repo.updateWhere))
          throw new AgentRunStoreUnavailableError('conditional-writes-unsupported');
        if (repo.updateWhere)
          await repo.updateWhere(
            'setu-agent-runs-probe',
            { leaseVersion: -1 },
            { leaseVersion: 0 },
          );
        await repo.deleteWhere('setu-agent-runs-probe', { leaseVersion: -1 });
      }
    } catch (cause) {
      if (cause instanceof AgentRunStoreUnavailableError) throw cause;
      throw new AgentRunStoreUnavailableError('conditional-writes-unsupported', { cause });
    }
  }
  /** @inheritdoc */
  async create(row: AgentRunRow): Promise<void> {
    await this.#repo('run').create({ ...row });
  }
  /** @inheritdoc */
  async get(id: string): Promise<AgentRunRow | null> {
    const raw = await this.#repo('run').findById(id);
    if (!raw) return null;
    const row = decode<AgentRunRow>(raw);
    if (!valid(row)) throw new AgentRunStoreUnavailableError('invalid-row');
    return row;
  }
  /** @inheritdoc */
  async update(
    id: string,
    where: WritePrecondition,
    data: Partial<AgentRunRow>,
  ): Promise<AgentRunRow | null> {
    const repo = this.#repo('run');
    if (!repo.updateWhere)
      throw new AgentRunStoreUnavailableError('conditional-writes-unsupported');
    const row = await repo.updateWhere(id, where, { ...data });
    return row ? decode<AgentRunRow>(row) : null;
  }
  async #held(run: AgentRunRow): Promise<void> {
    const current = await this.get(run.id);
    if (!current || current.leaseVersion !== run.leaseVersion) throw new AgentRunLeaseLostError();
  }
  async #insert(
    kind: 'entry' | 'chunks' | 'approval',
    run: AgentRunRow,
    value: Row,
  ): Promise<void> {
    await this.#held(run);
    const repo = this.#repo(kind);
    try {
      await repo.create({ ...value, leaseVersion: run.leaseVersion });
    } catch (error) {
      if (!(error instanceof DuplicateKeyError)) throw error;
      await this.#held(run);
      // Decoded like every other read: some drivers return a bigint column as
      // a bigint, which the number check below would otherwise refuse.
      const raw = await repo.findById(value.id as string);
      const orphan = raw ? decode<{ leaseVersion?: unknown }>(raw) : null;
      if (
        !orphan ||
        typeof orphan.leaseVersion !== 'number' ||
        orphan.leaseVersion >= run.leaseVersion
      )
        throw new AgentRunLeaseLostError();
      if (
        !repo.deleteWhere ||
        !(await repo.deleteWhere(value.id as string, { leaseVersion: orphan.leaseVersion }))
      )
        throw new AgentRunLeaseLostError();
      await repo.create({ ...value, leaseVersion: run.leaseVersion });
    }
  }
  async #append(
    kind: 'entry' | 'chunks',
    run: AgentRunRow,
    value: Row,
    counter: 'entryCount' | 'chunkCount',
  ): Promise<AgentRunRow> {
    await this.#insert(kind, run, value);
    const updated = await this.update(
      run.id,
      { leaseVersion: run.leaseVersion, [counter]: run[counter] },
      { [counter]: run[counter] + 1 },
    );
    if (!updated) throw new AgentRunLeaseLostError();
    return updated;
  }
  /** @inheritdoc */
  async appendEntry(run: AgentRunRow, entry: AgentRunEntryRow): Promise<AgentRunRow> {
    return await this.#append('entry', run, { ...entry }, 'entryCount');
  }
  /** @inheritdoc */
  async appendChunks(run: AgentRunRow, batch: AgentRunChunkBatch): Promise<AgentRunRow> {
    return await this.#append('chunks', run, { ...batch }, 'chunkCount');
  }
  /** @inheritdoc */
  async entries(run: AgentRunRow): Promise<readonly AgentRunEntryRow[]> {
    return (
      await this.#repo('entry').findAll({
        where: { runId: run.id, tenantId: run.tenantId },
        filter: comparison('seq', 'lt', run.entryCount),
        orderBy: { seq: 'asc' },
      })
    ).map((row) => decode<AgentRunEntryRow>(row));
  }
  /** @inheritdoc */
  async chunks(run: AgentRunRow, from: number): Promise<readonly AgentRunChunkBatch[]> {
    return (
      await this.#repo('chunks').findAll({
        where: { runId: run.id, tenantId: run.tenantId },
        filter: {
          type: 'and',
          filters: [comparison('seq', 'lt', run.chunkCount), comparison('seq', 'gte', from)],
        },
        orderBy: { seq: 'asc' },
      })
    ).map((row) => decode<AgentRunChunkBatch>(row));
  }
  /** @inheritdoc */
  async createApproval(run: AgentRunRow, approval: AgentRunApprovalRow): Promise<AgentRunRow> {
    await this.#insert('approval', run, { ...approval });
    const updated = await this.update(
      run.id,
      { leaseVersion: run.leaseVersion },
      { approvalIds: [...run.approvalIds, approval.id] },
    );
    if (!updated) throw new AgentRunLeaseLostError();
    return updated;
  }
  /** @inheritdoc */
  async approvals(runId: string): Promise<readonly AgentRunApprovalRow[]> {
    const run = await this.get(runId);
    if (!run) return [];
    return (await this.#repo('approval').findAll({ where: { runId }, orderBy: { seq: 'asc' } }))
      .filter((row) => run.approvalIds.includes(row.id as string))
      .map((row) => decode<AgentRunApprovalRow>(row));
  }
  /** @inheritdoc */
  async decide(
    id: string,
    data: Partial<AgentRunApprovalRow>,
  ): Promise<AgentRunApprovalRow | null> {
    const repo = this.#repo('approval');
    if (!repo.updateWhere)
      throw new AgentRunStoreUnavailableError('conditional-writes-unsupported');
    const row = await repo.updateWhere(id, { status: 'pending' }, { ...data });
    return row ? decode<AgentRunApprovalRow>(row) : null;
  }
  /** @inheritdoc */
  async expired(now: number, limit: number): Promise<readonly AgentRunApprovalRow[]> {
    // Uncommitted approvals and ones whose run cannot be read are skipped, so
    // page past them (a bounded number of pages) rather than let a batch of
    // them hide every later overdue approval.
    const committed: AgentRunApprovalRow[] = [];
    for (let page = 0; page < EXPIRY_PAGES && committed.length < limit; page++) {
      const candidates = await this.#repo('approval').findAll({
        where: { status: 'pending' },
        filter: comparison('deadline', 'lt', now),
        orderBy: { deadline: 'asc' },
        limit,
        offset: page * limit,
      });
      for (const row of candidates) {
        if (committed.length === limit) break;
        let run: AgentRunRow | null;
        try {
          run = await this.get(row.runId as string);
        } catch (error) {
          if (error instanceof AgentRunStoreUnavailableError && error.reason === 'invalid-row')
            continue;
          throw error;
        }
        if (run?.approvalIds.includes(row.id as string))
          committed.push(decode<AgentRunApprovalRow>(row));
      }
      if (candidates.length < limit) break;
    }
    return committed;
  }
  /** @inheritdoc */
  async resumable(now: number, limit: number): Promise<readonly AgentRunRow[]> {
    const rows = await this.#repo('run').findAll({
      filter: {
        type: 'or',
        filters: [
          { type: 'comparison', field: 'status', operator: 'eq', value: 'ready' },
          {
            type: 'and',
            filters: [
              { type: 'comparison', field: 'status', operator: 'eq', value: 'running' },
              comparison('leaseUntil', 'lt', now),
            ],
          },
        ],
      },
      orderBy: { updatedAt: 'asc' },
      limit,
    });
    // Decisions and waking a run span two entities. Rotate a bounded waiting
    // scan so a crash between those writes cannot strand an accepted decision.
    const waiting = await this.#repo('run').findAll({
      where: { status: 'waiting' },
      ...(this.#waitingAfter === undefined
        ? {}
        : {
            filter: {
              type: 'comparison' as const,
              field: 'id',
              operator: 'gt' as const,
              value: this.#waitingAfter,
            },
          }),
      orderBy: { id: 'asc' },
      limit,
    });
    this.#waitingAfter = waiting.length < limit ? undefined : (waiting.at(-1)!.id as string);
    return await this.#valid([...rows, ...waiting], 'quarantine');
  }
  /** @inheritdoc */
  async terminal(before: number, limit: number): Promise<readonly AgentRunRow[]> {
    const rows = await this.#repo('run').findAll({
      filter: {
        type: 'and',
        filters: [
          { type: 'comparison', field: 'status', operator: 'in', value: TERMINAL },
          comparison('updatedAt', 'lt', before),
        ],
      },
      orderBy: { updatedAt: 'asc' },
      limit,
    });
    return await this.#valid(rows, 'purge');
  }
  /**
   * Drop ill-formed rows from a bounded sweep query, and take each out of the
   * query it matched, so a full batch of them cannot starve later sweeps: a
   * resumable one is marked `failed` (`invalid-row`), a terminal one past
   * retention is deleted with its children. Both writes are conditional.
   */
  async #valid(rows: readonly Row[], invalid: 'quarantine' | 'purge'): Promise<AgentRunRow[]> {
    const result: AgentRunRow[] = [];
    const repo = this.#repo('run');
    for (const raw of rows) {
      const row = decode<AgentRunRow>(raw);
      if (valid(row)) {
        result.push(row);
        continue;
      }
      if (typeof raw.id !== 'string' || typeof raw.status !== 'string' || !repo.deleteWhere)
        continue;
      if (invalid === 'quarantine') {
        await repo.updateWhere?.(
          raw.id,
          { status: raw.status },
          { status: 'failed', error: 'invalid-row', leaseOwner: '' },
        );
        continue;
      }
      // Page through every child, as purge() does; the parent goes last and
      // only once no child is left, so a failed page is retried next sweep.
      if (await this.#deleteChildren(raw.id))
        await repo.deleteWhere(raw.id, { status: raw.status });
    }
    return result;
  }
  async #deleteChildren(runId: string, page = 100): Promise<boolean> {
    for (const kind of ['entry', 'chunks', 'approval'] as const) {
      const children = this.#repo(kind);
      if (!children.deleteWhere) return false;
      while (true) {
        const rows = await children.findAll({ where: { runId }, limit: page });
        let removed = 0;
        for (const child of rows)
          if (await children.deleteWhere(child.id as string, { runId })) removed++;
        if (rows.length < page) break;
        if (removed === 0) return false;
      }
    }
    return true;
  }
  /** @inheritdoc */
  async purge(run: AgentRunRow, limit = 25): Promise<boolean> {
    if (!TERMINAL.includes(run.status)) return false;
    const repo = this.#repo('run');
    if (!repo.deleteWhere)
      throw new AgentRunStoreUnavailableError('conditional-writes-unsupported');
    const current = await this.get(run.id);
    if (!current || current.status !== run.status || current.leaseVersion !== run.leaseVersion)
      return false;
    // Keep the terminal parent until cleanup succeeds, so a failed child
    // delete is retried by the next sweep rather than becoming an orphan.
    for (const kind of ['entry', 'chunks', 'approval'] as const) {
      const children = this.#repo(kind);
      if (!children.deleteWhere)
        throw new AgentRunStoreUnavailableError('conditional-writes-unsupported');
      while (true) {
        const rows = await children.findAll({
          where: { runId: run.id, tenantId: run.tenantId },
          limit,
        });
        let removed = 0;
        for (const row of rows)
          if (
            await children.deleteWhere(row.id as string, { runId: run.id, tenantId: run.tenantId })
          )
            removed++;
        if (rows.length < limit) break;
        if (removed === 0) return false;
      }
    }
    return await repo.deleteWhere(run.id, { status: run.status, leaseVersion: run.leaseVersion });
  }
}
/**
 * Resolve a durable run store from the application database capability.
 * @param options - Four entity names and optional named database
 * @returns Registry factory accepted by AgentRunsPlugin
 * @throws {TypeError} For empty entity names or invalid database tokens
 * @since 0.12.0
 */
export function createDatabaseAgentRunStore(
  options: DatabaseAgentRunStoreOptions = {},
): RegistryFactory<IAgentRunStore> {
  for (const name of Object.values({ ...DEFAULTS, ...options.entities }))
    if (typeof name !== 'string' || !name.trim())
      throw new TypeError('Agent run entity names must be non-empty.');
  const token =
    options.database === undefined || options.database === 'default'
      ? CAPABILITIES.DATABASE
      : createCapabilityToken(`database.${options.database}`);
  return (services: IServiceRegistry): IAgentRunStore =>
    new DatabaseAgentRunStore(services.get<IDatabaseService>(token), options);
}
