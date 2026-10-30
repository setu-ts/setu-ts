import { describe, expect, it } from 'vitest';
import type { ILogger, LogLevel, LogMetadata } from '@setu-ts/common';
import { CAPABILITIES, createRedactionService } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '../../src/plugin/logger-plugin.ts';
import type { LoggerPluginOptions } from '../../src/plugin/logger-plugin.ts';

function recordingLogger() {
  const calls: { level: LogLevel; message: string; metadata?: LogMetadata }[] = [];
  const children: LogMetadata[] = [];
  const make = (bindings: LogMetadata): ILogger => {
    const log =
      (level: LogLevel) =>
      (message: string, metadata?: LogMetadata): void => {
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
        children.push(next);
        return make({ ...bindings, ...next });
      },
    };
  };
  return { logger: make({}), calls, children };
}

// Keeps these runtime behavior tests executable against the pre-change union.
function customOptions(options: Readonly<Record<string, unknown>>): LoggerPluginOptions {
  return options as unknown as LoggerPluginOptions;
}

describe('custom logger transport', () => {
  it('filters all levels and redacts default secrets before delegation without mutating input', async () => {
    const target = recordingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin(customOptions({ transport: 'custom', logger: target.logger, level: 'info' })),
      ],
    });
    await app.start();
    try {
      const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
      const metadata = { nested: { PASSWORD: 'hidden', token: 'hidden', safe: 'ok' } };
      for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)
        logger[level](level, metadata);
      expect(target.calls.map((call) => call.level)).toEqual(['fatal', 'error', 'warn', 'info']);
      for (const call of target.calls)
        expect(call.metadata).toEqual({
          nested: { PASSWORD: '[Redacted]', token: '[Redacted]', safe: 'ok' },
        });
      expect(metadata.nested.PASSWORD).toBe('hidden');
      expect(logger.level).toBe('info');
    } finally {
      await app.stop();
    }
  });

  it('delegates children and request logging while retaining redaction, policy and filtering', async () => {
    const target = recordingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin(
          customOptions({
            transport: 'custom',
            logger: target.logger,
            level: 'trace',
            requestLogging: true,
            redact: ['private'],
            redaction: { fields: { card: 'pci' }, defaultRedactor: () => 'masked' },
          }),
        ),
      ],
    });
    app.router.get('/custom', (ctx) => ctx.response.json({ ok: true }));
    await app.start();
    try {
      const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
      const child = logger.child({ private: 'hidden', parent: true }).child({ card: '1234' });
      for (const level of ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const)
        child[level](level, {
          private: 'hidden',
          card: '1234',
          password: 'explicit paths replace defaults',
        });
      expect(target.children).toEqual([
        { private: '[Redacted]', parent: true },
        { card: 'masked' },
      ]);
      expect(target.calls).toHaveLength(6);
      for (const call of target.calls)
        expect(call.metadata).toMatchObject({
          private: '[Redacted]',
          card: 'masked',
          parent: true,
          password: 'explicit paths replace defaults',
        });
      const response = await app.inject({ method: 'GET', url: '/custom' });
      expect(response.statusCode).toBe(200);
      expect(
        target.calls
          .filter((call) => call.message.startsWith('request '))
          .map((call) => [call.level, call.message]),
      ).toEqual([
        ['debug', 'request received'],
        ['info', 'request completed'],
      ]);
      expect(target.children.at(-1)?.['requestId']).toEqual(expect.any(String));
    } finally {
      await app.stop();
    }
  });

  it('honors a compiled redaction service and an empty explicit path list', async () => {
    const target = recordingLogger();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        LoggerPlugin(
          customOptions({
            transport: 'custom',
            logger: target.logger,
            redact: [],
            redaction: createRedactionService({ fields: { card: 'pci' } }),
          }),
        ),
      ],
    });
    await app.start();
    try {
      const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
      logger.info('message only');
      logger.info('metadata', { card: '1234', password: 'kept' });
      expect(target.calls).toEqual([
        { level: 'info', message: 'message only', metadata: {} },
        { level: 'info', message: 'metadata', metadata: { card: '[Redacted]', password: 'kept' } },
      ]);
    } finally {
      await app.stop();
    }
  });

  it('refuses custom without a logger with a named construction error', () => {
    expect(() => LoggerPlugin(customOptions({ transport: 'custom' }))).toThrowError(
      expect.objectContaining({ name: 'LoggerConfigurationError' }),
    );
  });

  it('refuses custom with a null logger at construction, as without one', () => {
    // A JavaScript caller can pass null; it must not slip past the check and
    // fail later, on the first log call.
    expect(() => LoggerPlugin(customOptions({ transport: 'custom', logger: null }))).toThrowError(
      expect.objectContaining({ name: 'LoggerConfigurationError' }),
    );
  });

  for (const transport of [undefined, 'console', 'pino', 'noop']) {
    it(`refuses a logger with ${transport ?? 'the default'} transport at construction`, () => {
      expect(() =>
        LoggerPlugin(
          customOptions({
            ...(transport === undefined ? {} : { transport }),
            logger: recordingLogger().logger,
          }),
        ),
      ).toThrowError(expect.objectContaining({ name: 'LoggerConfigurationError' }));
    });
  }
});
