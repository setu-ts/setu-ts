/** Tests for the broker string-sink diagnostic renderer. @module */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { describeError } from '../../src/brokers/describe-error.ts';

describe('describeError', () => {
  it('renders aggregate members, classifiers, and a cause chain in one line', () => {
    const driver = new Error('serialization failure') as Error & { code?: string };
    driver.code = '40001';
    const error = new AggregateError([
      driver,
      new Error('connection reset', { cause: new Error('socket closed') }),
    ]);

    const output = describeError(error);

    expect(output).toContain('AggregateError:');
    expect(output).toContain('Error: serialization failure (code=40001)');
    expect(output).toContain('Error: connection reset <- Error: socket closed');
    expect(output.includes('\n')).toBe(false);
  });

  it('renders a hostile value instead of throwing from the logger path', () => {
    const hostile = new Proxy(new Error('unavailable'), {
      get() {
        throw new Error('property access failed');
      },
    });

    expect(describeError(hostile)).toContain('Error:');
  });

  it('bounds an aggregate diagnostic before it reaches the logger sink', () => {
    const error = new AggregateError(
      Array.from({ length: 8 }, () => new Error('x'.repeat(10_000))),
    );

    const output = describeError(error);

    expect(Array.from(output)).toHaveLength(8192);
    expect(output.endsWith('… [truncated]')).toBe(true);
  });
});
