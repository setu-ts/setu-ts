/**
 * M106 §3.1: `IMessageBroker.publish` gained an OPTIONAL trailing parameter, so
 * every existing caller and every two-parameter implementor stays assignable.
 * This file also pins the two header constants and the `PublishOptions` shape.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, PublishOptions } from '../../src/index.ts';
import { DEDUPLICATION_ID_HEADER, ORDERING_KEY_HEADER } from '../../src/index.ts';

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
});
