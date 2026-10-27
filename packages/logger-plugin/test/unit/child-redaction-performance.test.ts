import { describe, expect, it, vi } from 'vitest';
import * as common from '@setu-ts/common';
import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('ConsoleLogger', () => {
  it('should redact nested child logs while compiling redaction once across 10,000 children', () => {
    const create = vi.spyOn(common, 'createRedactionService');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const root = new ConsoleLogger(createFakeRuntime().runtime, { redact: ['**.password'] });
      expect(create).toHaveBeenCalledTimes(1);
      create.mockClear();
      for (let index = 0; index < 10_000; index++) root.child({ requestId: index });
      expect(create).not.toHaveBeenCalled();
      root
        .child({ password: 'hidden', parent: true })
        .child({ child: true })
        .info('child', { nested: { password: 'hidden' } });
      expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
        password: '[Redacted]',
        nested: { password: '[Redacted]' },
        parent: true,
        child: true,
      });
    } finally {
      create.mockRestore();
      output.mockRestore();
    }
  });

  it('should keep redact paths when an untyped caller passes a third constructor argument', () => {
    // Security audit F3: the constructor once took the children's compiled
    // redaction as a public third parameter, which silently replaced `redact`.
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const Untyped = ConsoleLogger as unknown as new (...args: unknown[]) => ConsoleLogger;
      const replacement = common.createRedactionService({ fields: {} });
      const logger = new Untyped(
        createFakeRuntime().runtime,
        { redact: ['**.apiKey'] },
        replacement,
      );
      logger.child({ requestId: 'r1' }).child({}).info('call', { apiKey: 'hidden', safe: 'ok' });
      logger.info('root', { apiKey: 'hidden' });
      const lines = output.mock.calls.map((call) => JSON.parse(String(call[0])) as object);
      expect(lines[0]).toMatchObject({ apiKey: '[Redacted]', safe: 'ok', requestId: 'r1' });
      expect(lines[1]).toMatchObject({ apiKey: '[Redacted]' });
    } finally {
      output.mockRestore();
    }
  });
});
