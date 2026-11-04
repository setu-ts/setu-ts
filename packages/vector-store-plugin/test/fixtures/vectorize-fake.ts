/**
 * A Vectorize binding fake implementing only documented semantics of the
 * current `Vectorize` API (developers.cloudflare.com/vectorize/):
 * namespaces apply before metadata filters; a filter is an implicit AND of
 * `{ field: { $op: value } }`; ids are unique per index; `describe()` reports
 * dimensions. Writes apply synchronously here, unlike the real service.
 */
import type { VectorizeIndexLike, VectorizeVectorLike } from '@setu-ts/cloudflare-plugin';

function matches(value: unknown, condition: Record<string, unknown>): boolean {
  return Object.entries(condition).every(([op, operand]) => {
    switch (op) {
      case '$eq':
        return value === operand;
      case '$in':
        return (operand as unknown[]).includes(value);
      case '$gt':
        return typeof value === 'number' && value > (operand as number);
      case '$gte':
        return typeof value === 'number' && value >= (operand as number);
      case '$lt':
        return typeof value === 'number' && value < (operand as number);
      case '$lte':
        return typeof value === 'number' && value <= (operand as number);
      default:
        throw new Error(`vectorize fake: unexpected operator ${op}`);
    }
  });
}

/**
 * Creates a fake index.
 *
 * @param dimensions - What `describe()` reports
 * @returns The fake binding
 */
export function vectorizeFake(dimensions: number): VectorizeIndexLike {
  const vectors = new Map<string, VectorizeVectorLike>();
  return {
    describe() {
      return Promise.resolve({ dimensions });
    },
    query(vector, options) {
      const norm = Math.hypot(...vector);
      const found = [...vectors.values()]
        .filter((v) => (v.namespace ?? '') === options.namespace)
        .filter((v) =>
          Object.entries(options.filter ?? {}).every(([field, condition]) =>
            matches(v.metadata?.[field], condition as Record<string, unknown>),
          ),
        )
        .map((v) => ({
          id: v.id,
          score:
            v.values.reduce((sum, x, i) => sum + x * vector[i]!, 0) /
            (norm * Math.hypot(...v.values)),
          metadata: { ...v.metadata },
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.topK);
      return Promise.resolve({ matches: found });
    },
    upsert(batch) {
      for (const v of batch) vectors.set(v.id, v);
      return Promise.resolve({ mutationId: 'fake' });
    },
    deleteByIds(ids) {
      for (const id of ids) vectors.delete(id);
      return Promise.resolve({ mutationId: 'fake' });
    },
  };
}
