import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BillingService } from '../src/index.ts';

describe('contracts', () => {
  it('exports the BillingService descriptor', () => {
    assert.equal(BillingService.typeName, 'billing.v1.BillingService');
  });
});
