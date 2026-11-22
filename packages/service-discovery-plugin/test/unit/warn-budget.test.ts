import { expect, it } from 'vitest';
import {
  createWarnBudget,
  RESOLVE_WARN_BUDGET,
  RESOLVE_WARN_WINDOW_MS,
} from '../../src/plugin/warn-budget.ts';

/** A logger recording each call's level and message. */
function recorder(): {
  lines: [string, string][];
  logger: {
    warn(m: string): void;
    info(m: string): void;
    debug(m: string): void;
  };
} {
  const lines: [string, string][] = [];
  return {
    lines,
    logger: {
      warn: (m) => lines.push(['warn', m]),
      info: (m) => lines.push(['info', m]),
      debug: (m) => lines.push(['debug', m]),
    },
  };
}

it('caps warn lines per window, notices once, and resets in the next window', () => {
  const { lines, logger } = recorder();
  let clock = 0;
  const get = createWarnBudget(
    () => logger,
    () => clock,
    'src',
  );
  for (let n = 0; n < RESOLVE_WARN_BUDGET + 3; n++) get()!.warn(`w${n}`);
  const warns = lines.filter(([level]) => level === 'warn');
  expect(warns).toHaveLength(RESOLVE_WARN_BUDGET + 1);
  expect(warns.at(-1)![1]).toContain(
    `further ones log at debug, starting with: w${RESOLVE_WARN_BUDGET}`,
  );
  expect(lines.filter(([level]) => level === 'debug').map(([, m]) => m)).toEqual([
    `w${RESOLVE_WARN_BUDGET}`,
    `w${RESOLVE_WARN_BUDGET + 1}`,
    `w${RESOLVE_WARN_BUDGET + 2}`,
  ]);
  get()!.info('i');
  get()!.debug('d');
  expect(lines.slice(-2)).toEqual([
    ['info', 'i'],
    ['debug', 'd'],
  ]);
  lines.length = 0;
  clock = RESOLVE_WARN_WINDOW_MS;
  get()!.warn('next');
  expect(lines).toEqual([['warn', 'next']]);
});

it('writes nothing and returns no logger while none is registered', () => {
  let current: ReturnType<typeof recorder>['logger'] | undefined;
  const get = createWarnBudget(
    () => current,
    () => 0,
    'src',
  );
  expect(get()).toBeUndefined();
  const { lines, logger } = recorder();
  current = logger;
  const budgeted = get()!;
  current = undefined;
  budgeted.warn('dropped');
  budgeted.info('dropped');
  budgeted.debug('dropped');
  expect(lines).toEqual([]);
});
