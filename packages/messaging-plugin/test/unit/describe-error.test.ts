/** Tests for the broker string-sink diagnostic renderer. @module */
import { describe, expect, it } from 'vitest';

import { describeError as commonDescribeError } from '@setu-ts/common';
import { describeError, describeLogText } from '../../src/brokers/describe-error.ts';

describe('describeError', () => {
  // The renderer is shared with `common` (M119g); this module re-exports it for
  // the broker call sites that already imported it here. Identity, not just
  // equal output, is what proves there is one implementation.
  it('is the common renderer, re-exported for this package', () => {
    expect(describeError).toBe(commonDescribeError);
  });
});

describe('describeLogText', () => {
  // Driven directly: the RabbitMQ dead-letter log line that used to reach the
  // budget is now bounded by AMQP's 255-byte names (M106 audit O5), so no
  // in-package caller exceeds it any more.
  it('truncates a line over the budget at 8192 characters with the marker', () => {
    const line = describeLogText('x'.repeat(10_000));
    expect([...line].length).toBeLessThanOrEqual(8192);
    expect(line).toMatch(/… \[truncated\]$/u);
  });

  it('leaves a line within the budget unmarked', () => {
    expect(describeLogText('short line')).toBe('short line');
  });

  it('drops leading whitespace rather than starting the line with a space', () => {
    expect(describeLogText('  leading')).toBe('leading');
  });

  it('marks a line truncated exactly where a normalized space would be appended', () => {
    // The content budget is 8192 minus the marker; the next character is a space,
    // so the marker's own space is the one that cannot be appended.
    const line = describeLogText(`${'x'.repeat(8179)} y`);
    expect([...line]).toHaveLength(8192);
    expect(line.endsWith('… [truncated]')).toBe(true);
  });
});
