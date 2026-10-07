/**
 * M106 §3.1: `IMessageBroker.publish` gained an OPTIONAL trailing parameter, so
 * every existing caller and every two-parameter implementor stays assignable.
 * This file also pins the two header constants and the `PublishOptions` shape.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, PublishOptions } from '../../src/index.ts';
import {
  DEDUPLICATION_ID_HEADER,
  isValidPublishId,
  MAX_PUBLISH_HEADER_NAME_BYTES,
  MAX_PUBLISH_HEADER_VALUE_BYTES,
  MAX_PUBLISH_HEADERS,
  MAX_PUBLISH_ID_BYTES,
  ORDERING_KEY_HEADER,
  publishHeaderNameProblem,
  publishHeaderValueProblem,
  publishIdProblem,
  RESERVED_HEADER_NAMES,
  RESERVED_HEADER_PREFIXES,
} from '../../src/index.ts';

describe('PublishOptions contract', () => {
  it('accepts a two-parameter publish implementation (fewer params are assignable)', () => {
    // `deno check` covers test/: if `publish` gained a REQUIRED parameter this
    // assignment would no longer type-check, which is the whole point of the
    // optional-trailing-parameter design.
    const twoParamPublish = <T>(_topic: string, _message: T): Promise<void> => Promise.resolve();
    const asContractMember: IMessageBroker['publish'] = twoParamPublish;
    expect(typeof asContractMember).toBe('function');
  });

  it('accepts a three-parameter publish implementation that reads the options', () => {
    const threeParamPublish = <T>(
      _topic: string,
      _message: T,
      _options?: PublishOptions,
    ): Promise<void> => Promise.resolve();
    const asContractMember: IMessageBroker['publish'] = threeParamPublish;
    expect(typeof asContractMember).toBe('function');
  });

  it('exports the two header constants with their documented values', () => {
    expect(ORDERING_KEY_HEADER).toBe('x-setu-ordering-key');
    expect(DEDUPLICATION_ID_HEADER).toBe('x-setu-deduplication-id');
  });

  it('PublishOptions carries exactly the three documented members', () => {
    const options: PublishOptions = {
      orderingKey: 'aggregate-1',
      deduplicationId: 'event-1',
      headers: { 'x-app': 'v' },
    };
    expect(Object.keys(options).sort()).toEqual(['deduplicationId', 'headers', 'orderingKey']);
  });

  it('exports the shared publish-id bound', () => {
    expect(MAX_PUBLISH_ID_BYTES).toBe(128);
  });

  it('publishIdProblem accepts a valid id and reports each failing rule', () => {
    expect(publishIdProblem('agg-1')).toBeNull();
    expect(publishIdProblem('a'.repeat(MAX_PUBLISH_ID_BYTES))).toBeNull();
    expect(publishIdProblem(1)).toBe('not-a-string');
    expect(publishIdProblem('')).toBe('empty');
    expect(publishIdProblem('\uD800')).toBe('not-well-formed');
    expect(publishIdProblem(' a')).toBe('whitespace');
    expect(publishIdProblem('a\u0001b')).toBe('forbidden-characters');
    expect(publishIdProblem('a'.repeat(MAX_PUBLISH_ID_BYTES + 1))).toBe('too-long');
    // UTF-8 bytes, not code units: 65 × 'é' is 130 bytes.
    expect(publishIdProblem('é'.repeat(65))).toBe('too-long');
  });

  it('isValidPublishId narrows to a string', () => {
    expect(isValidPublishId('agg-1')).toBe(true);
    expect(isValidPublishId('')).toBe(false);
    expect(isValidPublishId(undefined)).toBe(false);
  });

  it('exports the shared header bounds', () => {
    expect(MAX_PUBLISH_HEADERS).toBe(32);
    expect(MAX_PUBLISH_HEADER_NAME_BYTES).toBe(256);
    expect(MAX_PUBLISH_HEADER_VALUE_BYTES).toBe(1024);
  });

  it('exports the reserved-name tables the tests iterate', () => {
    expect(RESERVED_HEADER_NAMES).toContain('cc');
    expect(RESERVED_HEADER_NAMES).toContain('x-acquired-count');
    expect(RESERVED_HEADER_PREFIXES).toContain('goog');
  });

  it('publishHeaderNameProblem accepts a valid name and reports each failing rule', () => {
    expect(publishHeaderNameProblem('x-tenant')).toBeNull();
    expect(publishHeaderNameProblem(undefined)).toBe('not-a-string');
    expect(publishHeaderNameProblem('')).toBe('empty');
    expect(publishHeaderNameProblem('bad:name')).toBe('not-visible-ascii');
    expect(publishHeaderNameProblem('bad name')).toBe('not-visible-ascii');
    expect(publishHeaderNameProblem('é')).toBe('not-visible-ascii');
    expect(publishHeaderNameProblem('a'.repeat(MAX_PUBLISH_HEADER_NAME_BYTES + 1))).toBe(
      'too-long',
    );
    expect(publishHeaderNameProblem('Cc')).toBe('reserved');
    expect(publishHeaderNameProblem('NATS-ROLLUP')).toBe('reserved');
    expect(publishHeaderNameProblem('googFoo')).toBe('reserved');
    expect(publishHeaderNameProblem('x-setu-attempt')).toBe('reserved');
    expect(publishHeaderNameProblem('x-first-death-queue')).toBe('reserved');
  });

  it('publishHeaderValueProblem accepts a valid value and reports each failing rule', () => {
    expect(publishHeaderValueProblem('acme')).toBeNull();
    expect(publishHeaderValueProblem(1)).toBe('not-a-string');
    expect(publishHeaderValueProblem('\uD800')).toBe('not-well-formed');
    expect(publishHeaderValueProblem(' v')).toBe('whitespace');
    expect(publishHeaderValueProblem('v\u0001')).toBe('forbidden-characters');
    expect(publishHeaderValueProblem('v'.repeat(MAX_PUBLISH_HEADER_VALUE_BYTES + 1))).toBe(
      'too-long',
    );
  });
});
