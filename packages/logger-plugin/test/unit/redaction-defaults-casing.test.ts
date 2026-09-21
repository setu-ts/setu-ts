import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DEFAULT_SECRET_FIELD_PATTERNS } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { PinoLogger } from '../../src/loggers/pino-logger.ts';
import type { PinoFactory } from '../../src/loggers/pino-logger.ts';
import { composeLoggerRedaction, LoggerPlugin } from '../../src/plugin/logger-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

function normalizedHeaders(): Record<string, string> {
  return Object.fromEntries(
    new Headers({ Authorization: 'Bearer real-session-token', Cookie: 'session=secret' }).entries(),
  );
}

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

describe('default logger redaction casing', () => {
  it('redacts normalized headers through stock LoggerPlugin console and pino transports', async () => {
    const headers = normalizedHeaders();
    const consoleApp = createApplication({ plugins: [RuntimePlugin(), LoggerPlugin()] });
    let consoleRecord: Record<string, unknown> | undefined;
    try {
      await consoleApp.start();
      const logger = consoleApp.services.get<ILogger>(CAPABILITIES.LOGGER);
      const output = captureConsole(() => logger.info('inbound', headers));
      consoleRecord = JSON.parse(output[0] ?? '{}') as Record<string, unknown>;
    } finally {
      await consoleApp.stop();
    }
    expect(consoleRecord).toMatchObject({ authorization: '[Redacted]', cookie: '[Redacted]' });

    let pinoRecord: Record<string, unknown> | undefined;
    let pinoRedact: readonly string[] | undefined;
    const pino: ReturnType<PinoFactory> = {
      level: 'info',
      fatal(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      error(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      warn(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      info(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      debug(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      trace(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      child(_bindings) {
        return pino;
      },
    };
    const pinoFactory: PinoFactory = (options) => {
      pinoRedact = options.redact;
      return pino;
    };
    const pinoApp = createApplication({
      plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'pino', pinoFactory })],
    });
    try {
      await pinoApp.start();
      const logger = pinoApp.services.get<ILogger>(CAPABILITIES.LOGGER);
      logger.info('inbound', headers);
    } finally {
      await pinoApp.stop();
    }
    expect(pinoRedact).toBeUndefined();
    expect(pinoRecord).toMatchObject({ authorization: '[Redacted]', cookie: '[Redacted]' });
  });

  it('redacts normalized authorization and cookie headers through both transports', async () => {
    const redaction = composeLoggerRedaction(undefined, DEFAULT_SECRET_FIELD_PATTERNS, false);
    const headers = normalizedHeaders();
    const { runtime } = createFakeRuntime();
    const consoleLogger = new ConsoleLogger(runtime, {
      redact: DEFAULT_SECRET_FIELD_PATTERNS,
      redaction,
    });

    const consoleOutput = captureConsole(() => consoleLogger.info('inbound', headers));
    const consoleRecord = JSON.parse(consoleOutput[0]!) as Record<string, unknown>;
    expect(consoleRecord.authorization).toBe('[Redacted]');
    expect(consoleRecord.cookie).toBe('[Redacted]');

    let pinoRecord: Record<string, unknown> | undefined;
    let receivedRedact: readonly string[] | undefined;
    const pino: ReturnType<PinoFactory> = {
      level: 'info',
      fatal(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      error(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      warn(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      info(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      debug(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      trace(record: unknown, _message: string): void {
        pinoRecord = record as Record<string, unknown>;
      },
      child(_bindings) {
        return pino;
      },
    };
    const pinoFactory: PinoFactory = (options) => {
      receivedRedact = options.redact;
      return pino;
    };
    const pinoLogger = await PinoLogger.create({
      redact: DEFAULT_SECRET_FIELD_PATTERNS,
      redaction,
      pinoFactory,
    });

    pinoLogger.info('inbound', headers);
    expect(receivedRedact).toContain('**.authorization');
    expect(pinoRecord).toMatchObject({ authorization: '[Redacted]', cookie: '[Redacted]' });
  });

  it('preserves case-sensitive matching for a caller-supplied redact list', () => {
    const redaction = composeLoggerRedaction(undefined, ['X-Tok']);

    expect(redaction.redactRecord({ 'x-tok': 'secret' })).toEqual({ 'x-tok': 'secret' });
  });
});
