/** The Deno runtime proofs use the same converted files as the Node lane. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe as stdDescribe,
  it as stdIt,
} from '@std/testing/bdd';
export { expect } from '@std/expect';
export { afterAll, afterEach, beforeAll, beforeEach };

interface Options {
  skip?: boolean;
  timeout?: number;
}
type Callback = () => void | Promise<void>;

/** Translate the supported Vitest call forms into the Deno BDD registration contract. */
export function translate<T extends Callback>(name: string, options: Options | T, callback?: T) {
  const config = typeof options === 'function' ? {} : options;
  const fn = typeof options === 'function' ? options : callback;
  if (!fn) throw new TypeError('A test callback is required');
  return { name, ...(config.skip !== undefined ? { ignore: config.skip } : {}), fn };
}

/** Enforce an explicit test deadline while clearing the timer on either settlement. */
export function translateTest(name: string, options: Options | Callback, callback?: Callback) {
  const registration = translate(name, options, callback);
  const timeout = typeof options === 'function' ? undefined : options.timeout;
  if (timeout === undefined) return registration;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError('Test timeout must be positive');
  }
  return {
    ...registration,
    fn: async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Test timed out after ${timeout}ms: ${name}`)),
          timeout,
        );
      });
      try {
        await Promise.race([Promise.resolve().then(registration.fn), deadline]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const describe = Object.assign(
  (name: string, options: Options | (() => void), callback?: () => void) =>
    stdDescribe(translate(name, options, callback)),
  {
    skip: (name: string, callback: () => void) =>
      stdDescribe(translate(name, { skip: true }, callback)),
    skipIf: (condition: boolean) => (name: string, callback: () => void) =>
      stdDescribe(translate(name, { skip: condition }, callback)),
  },
);
export const it = Object.assign(
  (name: string, options: Options | Callback, callback?: Callback) =>
    stdIt(translateTest(name, options, callback)),
  {
    skip: (name: string, callback: Callback) => stdIt(translate(name, { skip: true }, callback)),
    skipIf: (condition: boolean) => (name: string, callback: Callback) =>
      stdIt(translate(name, { skip: condition }, callback)),
  },
);
export const test = it;
