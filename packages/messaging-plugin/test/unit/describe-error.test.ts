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

  // Every optional member of a serialized failure is rendered behind its own
  // "did the budget survive that append?" guard, and each one returns early.
  // A single case can only exercise whichever guard its own length happens to
  // reach, which is why eleven of them shipped unexercised: the existing
  // truncation test overflows inside the first aggregate member and never gets
  // as far as the closing bracket, the omitted-member note, or the cause.
  //
  // Walking the cut point across the whole tail is what reaches them all. The
  // renderer emits name, message, classifiers, aggregate members, the omitted
  // note, then the cause, so growing the leading message by one code point at a
  // time slides the overflow through those sites in order.
  it('stops cleanly wherever the budget runs out, not only inside a message', () => {
    // Nine members against a serializer that keeps eight, so the rendered form
    // carries the omitted-member note as well as the members themselves.
    const build = (messageLength: number): AggregateError => {
      const driver = new Error('m') as Error & { code?: string; errno?: number };
      driver.code = '1';
      driver.errno = 2;
      const error = new AggregateError(
        [driver, ...Array.from({ length: 8 }, () => new Error('m'))],
        'a'.repeat(messageLength),
        { cause: new Error('c') },
      );
      return error;
    };

    let truncated = 0;
    let complete = 0;
    for (let messageLength = 8000; messageLength <= 8180; messageLength++) {
      const output = describeError(build(messageLength));
      const points = Array.from(output);

      // The bound is the contract: whatever the renderer was in the middle of,
      // it never hands the sink more than it promised, and never a bare cut.
      expect(points.length).toBeLessThanOrEqual(MAX_DESCRIPTION_LENGTH);
      expect(output.includes('\n')).toBe(false);
      if (output.endsWith(TRUNCATION_MARKER)) {
        truncated++;
      } else {
        // A bound alone is satisfied by a renderer that drops members, so the
        // cases that DO fit must still carry the whole tail — classifiers, the
        // omitted-member note, and the cause that renders last.
        expect(output).toContain('(code=1, errno=2)');
        expect(output).toContain('[1 aggregate error(s) omitted]');
        expect(output.endsWith('<- Error: c')).toBe(true);
        complete++;
      }
    }

    // Guards the sweep against passing vacuously: a range that never overflows
    // would satisfy every assertion above while exercising no guard at all.
    expect(truncated).toBeGreaterThan(0);
    expect(complete).toBeGreaterThan(0);
  });

  it('removes control and format characters before passing a message to the logger', () => {
    const output = describeError(new Error('before\u001b[31m bell\u0007 format\u200C after'));

    expect(DISALLOWED_LOG_CHARACTER.test(output)).toBe(false);
    expect(output).toContain('before [31m bell format after');
  });
});

const DISALLOWED_LOG_CHARACTER = /[\p{Cc}\p{Cf}]/u;

/** Mirrors the renderer's own bound; asserted by the truncation cases above. */
const MAX_DESCRIPTION_LENGTH = 8192;

/** Mirrors the renderer's own marker. */
const TRUNCATION_MARKER = '… [truncated]';
