import { expect, it, vi } from 'vitest';
import * as common from '@setu-ts/common';
import { ConsoleLogger } from '../../src/loggers/console-logger.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

it('10,000 console children reuse the root compiled redaction service', () => {
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
