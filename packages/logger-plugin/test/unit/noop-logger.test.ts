import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { ILogger } from '@hono-enterprise/common';

import { NoopLogger } from '../../src/loggers/noop-logger.ts';

describe('NoopLogger', () => {
  it('defaults to trace level', () => {
    const logger = new NoopLogger();
    expect(logger.level).toBe('trace');
  });

  it('accepts a level option and stores it for introspection', () => {
    const logger = new NoopLogger({ level: 'error', bindings: { foo: 'bar' } });
    expect(logger.level).toBe('error');
  });

  it('does not throw on any log method', () => {
    const logger = new NoopLogger();
    expect(() => logger.fatal('msg')).not.toThrow();
    expect(() => logger.error('msg', { k: 'v' })).not.toThrow();
    expect(() => logger.warn('msg')).not.toThrow();
    expect(() => logger.info('msg')).not.toThrow();
    expect(() => logger.debug('msg')).not.toThrow();
    expect(() => logger.trace('msg')).not.toThrow();
  });

  it('returns itself from child()', () => {
    const logger = new NoopLogger();
    const child = logger.child({ requestId: 'abc' });
    expect(child).toBe(logger);
  });

  it('child() returns a logger that is also a no-op', () => {
    const logger = new NoopLogger();
    const child = logger.child({ requestId: 'abc' });
    expect(() => child.info('ignored')).not.toThrow();
  });

  it('satisfies the ILogger interface', () => {
    const logger: ILogger = new NoopLogger();
    expect(logger).toBeDefined();
  });
});
