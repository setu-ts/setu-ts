import { describe, expect, it, vi } from 'vitest';
import type { ILogger, LogLevel, LogMetadata } from '@setu-ts/common';
import { CAPABILITIES, createRedactionService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { PinoLogger } from '../../src/loggers/pino-logger.ts';
import type { PinoFactory } from '../../src/loggers/pino-logger.ts';
import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

// Security audit F2 (PR #512): a log call sits on request paths, so metadata the
// caller cannot read, or a sink that throws, must never become the request's
// fault. Console already contained both; custom and pino did not.

const MARKER = '[unserializable metadata]';

interface Call {
  readonly level: LogLevel;
  readonly message: string;
  readonly metadata: unknown;
}

/** Metadata whose reading throws, in each shape the audit drove. */
function hostile(): Record<string, () => LogMetadata> {
  const revoked = (): object => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return proxy;
  };
  return {
    'a throwing getter': () =>
      Object.defineProperty({}, 'x', {
        enumerable: true,
        get() {
          throw new Error('canary-getter');
        },
      }) as LogMetadata,
    'a revoked Proxy': () => revoked() as LogMetadata,
    'a nested revoked Proxy': () => ({ inner: revoked() }),
  };
}

function recordingSink(throwing: { log?: boolean; child?: boolean } = {}) {
  const calls: Call[] = [];
  const make = (bindings: LogMetadata): ILogger => {
    const log =
      (level: LogLevel) =>
      (message: string, metadata?: LogMetadata): void => {
        if (throwing.log === true) throw new Error('sink down');
        calls.push({ level, message, metadata: { ...bindings, ...metadata } });
      };
    return {
      level: 'trace',
      fatal: log('fatal'),
      error: log('error'),
      warn: log('warn'),
      info: log('info'),
      debug: log('debug'),
      trace: log('trace'),
      child(next) {
        if (throwing.child === true) throw new Error('sink child down');
        return make({ ...bindings, ...next });
      },
    };
  };
  return { logger: make({}), calls };
}

async function customLogger(
  sink: ILogger,
): Promise<{ logger: ILogger; stop: () => Promise<void> }> {
  const app = createApplication({
    plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'custom', logger: sink })],
  });
  await app.start();
  return { logger: app.services.get<ILogger>(CAPABILITIES.LOGGER), stop: () => app.stop() };
}

function pinoRecorder(): { factory: PinoFactory; calls: Call[] } {
  const calls: Call[] = [];
  const make = (base: Record<string, unknown>): unknown => {
    const log = (level: LogLevel) => (obj: unknown, msg: string) => {
      calls.push({ level, message: msg, metadata: { ...base, ...(obj as object) } });
    };
    return {
      level: 'info',
      fatal: log('fatal'),
      error: log('error'),
      warn: log('warn'),
      info: log('info'),
      debug: log('debug'),
      trace: log('trace'),
      child: (bindings: Record<string, unknown>) => make({ ...base, ...bindings }),
    };
  };
  return { factory: (() => make({})) as unknown as PinoFactory, calls };
}

describe('log calls never throw to their caller', () => {
  for (const [shape, metadata] of Object.entries(hostile())) {
    it(`should log the custom record without its metadata when it holds ${shape}`, async () => {
      const sink = recordingSink();
      const { logger, stop } = await customLogger(sink.logger);
      try {
        expect(() => logger.info('hostile', metadata())).not.toThrow();
        logger.info('ordinary', { password: 'hidden', safe: 'ok' });
        expect(sink.calls).toEqual([
          { level: 'info', message: 'hostile', metadata: { metadata: MARKER } },
          {
            level: 'info',
            message: 'ordinary',
            metadata: { password: '[Redacted]', safe: 'ok' },
          },
        ]);
      } finally {
        await stop();
      }
    });

    it(`should drop custom child bindings holding ${shape} and keep logging`, async () => {
      const sink = recordingSink();
      const { logger, stop } = await customLogger(sink.logger);
      try {
        let child: ILogger | undefined;
        expect(() => (child = logger.child(metadata()))).not.toThrow();
        child!.info('after', { token: 'hidden' });
        expect(sink.calls).toEqual([
          { level: 'info', message: 'after', metadata: { token: '[Redacted]' } },
        ]);
      } finally {
        await stop();
      }
    });

    it(`should log the pino record without its metadata when it holds ${shape}`, async () => {
      const { factory, calls } = pinoRecorder();
      const logger = await PinoLogger.create({
        pinoFactory: factory,
        redaction: createRedactionService({ fields: { '**.password': 'secret' } }),
      });
      expect(() => logger.info('hostile', metadata())).not.toThrow();
      let child: ILogger | undefined;
      expect(() => (child = logger.child(metadata()))).not.toThrow();
      expect(() => child!.child(metadata())).not.toThrow();
      child!.info('ordinary', { password: 'hidden', safe: 'ok' });
      expect(calls).toEqual([
        { level: 'info', message: 'hostile', metadata: { metadata: MARKER } },
        { level: 'info', message: 'ordinary', metadata: { password: '[Redacted]', safe: 'ok' } },
      ]);
    });
  }

  for (const [shape, metadata] of Object.entries(hostile())) {
    it(`should drop console child bindings holding ${shape} and keep logging`, () => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const logger = new ConsoleLogger(createFakeRuntime().runtime, { redact: ['**.password'] });
        const parent = logger.child({ requestId: 'r1' });
        let child: ILogger | undefined;
        expect(() => (child = parent.child(metadata()))).not.toThrow();
        child!.info('after', { password: 'hidden', safe: 'ok' });
        expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
          msg: 'after',
          requestId: 'r1',
          password: '[Redacted]',
          safe: 'ok',
        });
      } finally {
        output.mockRestore();
      }
    });
  }

  it('should swallow a custom sink that throws, on log calls and on child()', async () => {
    const throwingLog = recordingSink({ log: true });
    const throwingChild = recordingSink({ child: true });
    const first = await customLogger(throwingLog.logger);
    const second = await customLogger(throwingChild.logger);
    try {
      expect(() => first.logger.error('lost', { safe: 'ok' })).not.toThrow();
      const child = second.logger.child({ requestId: 'r1', password: 'hidden' });
      child.info('kept', { safe: 'ok' });
      // The sink's child() failed, so the record carries no new bindings, and
      // it is still filtered and redacted by the wrapper.
      expect(throwingChild.calls).toEqual([
        { level: 'info', message: 'kept', metadata: { safe: 'ok' } },
      ]);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  for (const throwing of [{ log: true }, { child: true }]) {
    it(`should still answer 200 with request logging when the sink's ${Object.keys(throwing)[0]} throws`, async () => {
      const sink = recordingSink(throwing);
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          LoggerPlugin({ transport: 'custom', logger: sink.logger, requestLogging: true }),
        ],
      });
      app.router.get('/ok', (ctx) => ctx.response.status(200).text('ok'));
      await app.start();
      try {
        const response = await app.inject({ method: 'GET', url: '/ok' });
        expect(response.statusCode).toBe(200);
      } finally {
        await app.stop();
      }
    });
  }
});
