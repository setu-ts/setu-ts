/**
 * M106 §3.4 — every refusal, every bound, the copy-once rule, the reserved
 * tables and the no-value-echo rule. Assertions fail if the validator is wrong.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RESERVED_HEADER_NAMES, RESERVED_HEADER_PREFIXES } from '@setu-ts/common';
import {
  buildTransportHeaders,
  validatePublishOptions,
} from '../../src/brokers/publish-options.ts';

/** Asserts a refusal is a REJECTED promise (never a sync throw) of type RangeError. */
async function expectRejection(input: unknown): Promise<RangeError> {
  let promise: Promise<unknown> | undefined;
  expect(() => {
    promise = validatePublishOptions(input);
  }).not.toThrow();
  try {
    await promise!;
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    return error as RangeError;
  }
  throw new Error('expected validatePublishOptions to reject');
}

function manyHeaders(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`header-${i}`, 'v']));
}

describe('validatePublishOptions — acceptance', () => {
  it('returns a frozen empty copy for undefined', async () => {
    const validated = await validatePublishOptions(undefined);
    expect(validated).toEqual({ headers: {} });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.headers)).toBe(true);
  });

  it('returns a frozen copy carrying all three members', async () => {
    const validated = await validatePublishOptions({
      orderingKey: 'aggregate-1',
      deduplicationId: 'event-1',
      headers: { 'x-app': 'v' },
    });
    expect(validated.orderingKey).toBe('aggregate-1');
    expect(validated.deduplicationId).toBe('event-1');
    expect(validated.headers).toEqual({ 'x-app': 'v' });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.headers)).toBe(true);
  });

  it('accepts an id of exactly 128 UTF-8 bytes', async () => {
    const validated = await validatePublishOptions({ orderingKey: 'a'.repeat(128) });
    expect(validated.orderingKey).toHaveLength(128);
  });

  it('accepts exactly 32 headers', async () => {
    const validated = await validatePublishOptions({ headers: manyHeaders(32) });
    expect(Object.keys(validated.headers)).toHaveLength(32);
  });

  it('accepts a 255-byte header name and a 1024-byte value', async () => {
    const name = 'a'.repeat(255);
    const value = 'b'.repeat(1024);
    const validated = await validatePublishOptions({ headers: { [name]: value } });
    expect(validated.headers[name]).toBe(value);
  });
});

describe('validatePublishOptions — copy-once', () => {
  it('reads an option member exactly once, so a two-faced getter cannot differ', async () => {
    let reads = 0;
    const options = {
      get orderingKey(): string {
        reads++;
        return reads === 1 ? 'first' : 'second-would-be-invalid-\u0000';
      },
    };
    const validated = await validatePublishOptions(options);
    expect(validated.orderingKey).toBe('first');
    expect(reads).toBe(1);
  });

  it('reads each header value exactly once, so a two-faced getter cannot differ', async () => {
    let reads = 0;
    const headers = {
      get 'x-a'(): string {
        reads++;
        return reads === 1 ? 'first' : 'second';
      },
    };
    const validated = await validatePublishOptions({ headers });
    expect(validated.headers['x-a']).toBe('first');
    expect(reads).toBe(1);
  });

  it('reads a Proxy options object each member exactly once and validates the copy', async () => {
    const reads: string[] = [];
    const target = { orderingKey: 'k', deduplicationId: 'd', headers: { 'x-a': 'v' } };
    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        if (typeof property === 'string') reads.push(property);
        return Reflect.get(object, property, receiver);
      },
    });
    const validated = await validatePublishOptions(proxy);
    expect(validated.orderingKey).toBe('k');
    expect(validated.deduplicationId).toBe('d');
    expect(validated.headers['x-a']).toBe('v');
    for (const member of ['orderingKey', 'deduplicationId', 'headers']) {
      expect(reads.filter((name) => name === member)).toHaveLength(1);
    }
  });

  it('rejects when a getter throws', async () => {
    const options = {
      get orderingKey(): string {
        throw new Error('boom');
      },
    };
    const error = await expectRejection(options);
    expect(error.message).toContain('could not be read');
  });

  it('keeps a __proto__ header as an own key and changes no prototype', async () => {
    const headers = JSON.parse('{"__proto__":"owned"}') as Record<string, string>;
    const validated = await validatePublishOptions({ headers });
    expect(Object.prototype.hasOwnProperty.call(validated.headers, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(validated.headers, '__proto__')?.value).toBe('owned');
    expect(Object.getPrototypeOf(validated.headers)).toBe(Object.prototype);
  });
});

describe('validatePublishOptions — shape refusals', () => {
  for (
    const [label, bad] of [
      ['an array', []],
      ['a string', 'options'],
      ['a number', 1],
      ['null', null],
      ['a boolean', true],
      ['a Date', new Date(0)],
      ['a function', () => {}],
    ] as const
  ) {
    it(`refuses options that are ${label}`, async () => {
      const error = await expectRejection(bad);
      expect(error.message).toContain('plain object');
    });
  }

  for (
    const [label, bad] of [
      ['an array', []],
      ['a string', 'headers'],
      ['null', null],
    ] as const
  ) {
    it(`refuses headers that are ${label}`, async () => {
      const error = await expectRejection({ headers: bad });
      expect(error.message).toContain('headers must be a plain object');
    });
  }

  it('refuses a headers record carrying a symbol key', async () => {
    const headers: Record<string, string> = { 'x-a': 'v' };
    Object.defineProperty(headers, Symbol('s'), { value: 'v', enumerable: true });
    const error = await expectRejection({ headers });
    expect(error.message).toContain('symbol');
  });
});

describe('validatePublishOptions — id rules', () => {
  it('refuses an empty orderingKey', async () => {
    expect((await expectRejection({ orderingKey: '' })).message).toContain('non-empty string');
  });

  it('refuses a non-string deduplicationId', async () => {
    expect((await expectRejection({ deduplicationId: 7 })).message).toContain('non-empty string');
  });

  it('refuses a lone surrogate in an id', async () => {
    expect((await expectRejection({ orderingKey: '\uD800' })).message).toContain('well-formed');
  });

  it('refuses leading or trailing whitespace in an id', async () => {
    expect((await expectRejection({ orderingKey: ' k ' })).message).toContain(
      'leading or trailing whitespace',
    );
    expect((await expectRejection({ deduplicationId: 'k\n' })).message).toContain(
      'leading or trailing whitespace',
    );
  });

  it('refuses a control character in an id', async () => {
    expect((await expectRejection({ orderingKey: 'a\u0001b' })).message).toContain(
      'control or format characters',
    );
  });

  it('refuses an id of 129 UTF-8 bytes', async () => {
    expect((await expectRejection({ orderingKey: 'a'.repeat(129) })).message).toContain(
      'at most 128 UTF-8 bytes',
    );
  });

  it('measures UTF-8 bytes, not code units, for a multibyte id', async () => {
    // 65 × 'é' is 130 UTF-8 bytes but only 65 code units: a code-unit check lies.
    expect((await expectRejection({ orderingKey: 'é'.repeat(65) })).message).toContain(
      'at most 128 UTF-8 bytes',
    );
    const validated = await validatePublishOptions({ orderingKey: 'é'.repeat(64) });
    expect(validated.orderingKey).toBe('é'.repeat(64));
  });
});

describe('validatePublishOptions — header name rules', () => {
  it('refuses an empty header name and identifies it by position, not by name', async () => {
    const error = await expectRejection({ headers: { '': 'v' } });
    expect(error.message).toContain('index 0');
  });

  it('refuses a 256-byte header name, which AMQP cannot encode (M106 audit F1)', async () => {
    expect((await expectRejection({ headers: { ['a'.repeat(256)]: 'v' } })).message).toContain(
      'index 0',
    );
  });

  it('refuses a header name containing a colon', async () => {
    const error = await expectRejection({ headers: { 'bad:name': 'v' } });
    expect(error.message).toContain('index 0');
    expect(error.message).not.toContain('bad:name');
  });

  it('refuses a header name with a space or a non-ASCII character', async () => {
    expect((await expectRejection({ headers: { 'bad name': 'v' } })).message).toContain('index 0');
    expect((await expectRejection({ headers: { 'é': 'v' } })).message).toContain('index 0');
  });

  it('reports the failing index for a bad name after good ones', async () => {
    const error = await expectRejection({ headers: { 'x-a': 'v', 'x-b': 'v', 'x:c': 'v' } });
    expect(error.message).toContain('index 2');
  });
});

describe('validatePublishOptions — header value rules', () => {
  it('refuses a non-string header value', async () => {
    const error = await expectRejection({ headers: { 'x-a': 1 as unknown as string } });
    expect(error.message).toContain('must be a string');
  });

  it('refuses a lone surrogate in a header value', async () => {
    expect((await expectRejection({ headers: { 'x-a': '\uDC00' } })).message).toContain(
      'well-formed',
    );
  });

  it('refuses leading or trailing whitespace in a header value', async () => {
    expect((await expectRejection({ headers: { 'x-a': ' v' } })).message).toContain(
      'leading or trailing whitespace',
    );
  });

  it('refuses a control character in a header value', async () => {
    expect((await expectRejection({ headers: { 'x-a': 'v\u0001' } })).message).toContain(
      'control or format characters',
    );
  });

  it('refuses a header value longer than 1024 bytes', async () => {
    expect((await expectRejection({ headers: { 'x-a': 'v'.repeat(1025) } })).message).toContain(
      'at most 1024 UTF-8 bytes',
    );
  });

  it('refuses more than 32 headers', async () => {
    expect((await expectRejection({ headers: manyHeaders(33) })).message).toContain(
      'at most 32 entries',
    );
  });
});

describe('validatePublishOptions — reserved names, three casings each', () => {
  const reservedCases = [
    ...RESERVED_HEADER_NAMES,
    ...RESERVED_HEADER_PREFIXES.map((prefix) => `${prefix}probe`),
  ];

  for (const name of reservedCases) {
    for (
      const variant of [
        name.toLowerCase(),
        name.toUpperCase(),
        `${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}`,
      ]
    ) {
      it(`refuses reserved header ${JSON.stringify(variant)}`, async () => {
        const error = await expectRejection({ headers: { [variant]: 'v' } });
        expect(error.message).toContain('reserved');
      });
    }
  }
});

describe('validatePublishOptions — refusals never echo a value', () => {
  it('does not echo an over-long id', async () => {
    const secret = 'SUPERSECRET'.repeat(20);
    const error = await expectRejection({ orderingKey: secret });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('SUPERSECRET');
  });

  it('does not echo a refused header value', async () => {
    const secret = 'SECRETVALUE'.repeat(100);
    const error = await expectRejection({ headers: { 'x-a': secret } });
    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain('SECRETVALUE');
  });
});

describe('buildTransportHeaders', () => {
  it('merges caller, ordering, de-duplication and framework headers', async () => {
    const validated = await validatePublishOptions({
      orderingKey: 'k',
      deduplicationId: 'd',
      headers: { 'x-a': 'v' },
    });
    const wire = buildTransportHeaders(validated, { traceparent: 'tp' });
    expect(wire).toEqual({
      'x-a': 'v',
      'x-setu-ordering-key': 'k',
      'x-setu-deduplication-id': 'd',
      traceparent: 'tp',
    });
  });

  it('omits the ordering and de-duplication headers when the options carry none', async () => {
    const validated = await validatePublishOptions({ headers: { 'x-a': 'v' } });
    const wire = buildTransportHeaders(validated, {});
    expect(wire).toEqual({ 'x-a': 'v' });
  });

  it('lets a framework header win over a caller header of the same name', async () => {
    const validated = await validatePublishOptions({ headers: { 'x-a': 'caller' } });
    const wire = buildTransportHeaders(validated, { 'x-a': 'framework' });
    expect(wire['x-a']).toBe('framework');
  });

  it('does not mutate the frozen validated copy', async () => {
    const validated = await validatePublishOptions({ orderingKey: 'k' });
    buildTransportHeaders(validated, { traceparent: 'tp' });
    expect(Object.keys(validated.headers)).toHaveLength(0);
  });
});
