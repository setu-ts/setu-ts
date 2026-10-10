/**
 * A per-field redaction policy supplied through `LoggerPlugin` reaches the
 * console transport with no logger-side change (M101h §3.2).
 *
 * The seam is `createRedactionService` inside `@setu-ts/common`; the logger
 * only passes its policy through, so this proves the widening is inherited by
 * every consumer rather than re-implemented per plugin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, createMaskRedactor } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';

function captureConsole(fn: () => void): readonly string[] {
  const output: string[] = [];
  const consoleRef = console as { log: (...args: unknown[]) => void };
  const original = consoleRef.log;
  consoleRef.log = (...args: unknown[]): void => {
    output.push(args.map(String).join(' '));
  };
  try {
    fn();
  } finally {
    consoleRef.log = original;
  }
  return output;
}

describe('per-field redaction through LoggerPlugin', () => {
  it('applies a field-level redactor and leaves adjacent fields intact', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin({
          redaction: {
            fields: {
              'user.email': { classification: 'pii', redactor: createMaskRedactor({ keep: 4 }) },
              'user.name': { classification: 'pii' },
            },
            redactors: { pii: () => 'class-level' },
          },
        }),
      ],
    });

    let record: Record<string, unknown> | undefined;
    try {
      await app.start();
      const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
      const output = captureConsole(() =>
        logger.info('signup', { user: { email: 'jane@example.com', name: 'Jane' } })
      );
      record = JSON.parse(output[0] ?? '{}') as Record<string, unknown>;
    } finally {
      await app.stop();
    }

    expect(record).toMatchObject({ user: { email: '************.com', name: 'class-level' } });
  });
});
