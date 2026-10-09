/** Internal conditional-write dispatch for the tenant, outbox and inbox stores. @module */
import type { EntityKey, WritePrecondition } from '@setu-ts/common';
import type { IRepository } from '../interfaces/index.ts';
import { UnsupportedQueryFeatureError } from '../errors.ts';

/** A conditional update's result; unsupported is guaranteed to precede I/O. */
type UpdateOutcome<Entity> =
  | { outcome: 'applied'; row: Entity }
  | { outcome: 'not-matched' }
  | { outcome: 'unsupported' };
/** A conditional delete's result. */
type DeleteOutcome = { outcome: 'applied' } | { outcome: 'not-matched' } | {
  outcome: 'unsupported';
};

/** Tries a native conditional update, exposing only the named unsupported refusal as fallback. */
export async function conditionalUpdate<Entity, Id extends EntityKey>(
  repo: IRepository<Entity, Id>,
  id: Id,
  where: WritePrecondition,
  data: Partial<Entity>,
): Promise<UpdateOutcome<Entity>> {
  if (repo.updateWhere === undefined) return { outcome: 'unsupported' };
  try {
    const row = await repo.updateWhere(id, where, data);
    return row === null ? { outcome: 'not-matched' } : { outcome: 'applied', row };
  } catch (error) {
    if (error instanceof UnsupportedQueryFeatureError && error.feature === 'conditional-write') {
      return { outcome: 'unsupported' };
    }
    throw error;
  }
}

/** Tries a native conditional delete, exposing only the named unsupported refusal as fallback. */
export async function conditionalDelete<Entity, Id extends EntityKey>(
  repo: IRepository<Entity, Id>,
  id: Id,
  where: WritePrecondition,
): Promise<DeleteOutcome> {
  if (repo.deleteWhere === undefined) return { outcome: 'unsupported' };
  try {
    return (await repo.deleteWhere(id, where))
      ? { outcome: 'applied' }
      : { outcome: 'not-matched' };
  } catch (error) {
    if (error instanceof UnsupportedQueryFeatureError && error.feature === 'conditional-write') {
      return { outcome: 'unsupported' };
    }
    throw error;
  }
}
