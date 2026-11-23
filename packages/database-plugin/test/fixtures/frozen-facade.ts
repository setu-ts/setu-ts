/** A recording client that cooperates with the driver's cancellation contract. */
export function frozenFacade<T extends object>(client: T) {
  let frozen = false;
  let failure: unknown;
  const calls: {
    method: string;
    args: unknown[];
    options: { abortSignal?: AbortSignal; timeoutMs?: number };
  }[] = [];
  const wait = (options: { abortSignal?: AbortSignal; timeoutMs?: number }): Promise<never> =>
    new Promise((resolve, reject) => {
      void resolve;
      const signal =
        options.abortSignal ??
        (options.timeoutMs === undefined
          ? undefined
          : AbortSignal.timeout(Math.ceil(options.timeoutMs)));
      if (!signal) return;
      const abort = (): void =>
        reject(
          options.timeoutMs === undefined
            ? signal.reason
            : Object.assign(new Error('deadline exceeded'), { code: 4 }),
        );
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    });
  const wrap = <V extends object>(target: V): V =>
    new Proxy(target, {
      get(object, property) {
        const value: unknown = Reflect.get(object, property, object);
        if (typeof value !== 'function')
          return typeof value === 'object' && value !== null ? wrap(value) : value;
        return (...args: unknown[]): unknown => {
          const method = String(property);
          const io = [
            'read',
            'replace',
            'patch',
            'delete',
            'create',
            'batch',
            'getItem',
            'putItem',
            'updateItem',
            'deleteItem',
            'scan',
            'query',
            'transactWriteItems',
            'readRows',
            'conditionalMutate',
          ].includes(method);
          const options = (args.at(-1) ?? {}) as { abortSignal?: AbortSignal; timeoutMs?: number };
          if (io) {
            calls.push({ method, options, args });
            if (failure !== undefined) return Promise.reject(failure);
            if (frozen)
              return method === 'query' && 'batch' in object
                ? { fetchAll: () => wait(options) }
                : wait(options);
          }
          const result: unknown = Reflect.apply(value, object, args);
          if (typeof result === 'object' && result !== null && !(result instanceof Promise)) {
            if (method === 'query' && 'fetchAll' in result) {
              return {
                fetchAll: () =>
                  frozen
                    ? wait(options)
                    : Reflect.apply((result as { fetchAll: () => unknown }).fetchAll, result, []),
              };
            }
            return wrap(result);
          }
          return result;
        };
      },
    });
  return {
    client: wrap(client),
    calls,
    freeze: () => {
      frozen = true;
    },
    fail: (error: unknown) => {
      failure = error;
    },
  };
}
