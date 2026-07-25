/**
 * Verifies every value symbol the barrel documents is reachable at runtime with
 * the right kind. `toBeDefined()` alone would pass for a symbol accidentally
 * re-exported as `export type`, which erases the runtime value — so each entry
 * asserts `typeof` instead.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';
import type { ProviderType } from '../../src/index.ts';

/** Every value export of `src/index.ts`, in barrel order. */
const VALUE_EXPORTS = [
  'NotificationPlugin',
  'createChannel',
  'createProvider',
  'NotificationService',
  'EmailChannel',
  'SmsChannel',
  'PushChannel',
  'SlackChannel',
  'TwilioProvider',
  'FcmProvider',
  'SlackProvider',
  'createDefaultNotificationHttp',
] as const;

describe('barrel exports', () => {
  for (const name of VALUE_EXPORTS) {
    it(`exports ${name} as a runtime value`, () => {
      expect(typeof (barrel as Record<string, unknown>)[name]).toBe('function');
    });
  }

  it('exports no unexpected runtime values', () => {
    expect(Object.keys(barrel).sort()).toEqual([...VALUE_EXPORTS].sort());
  });

  it('exposes ProviderType as the ChannelConfig discriminant', () => {
    // Type-level: each literal must remain assignable to the derived union.
    const providers: ProviderType[] = ['mail', 'twilio', 'fcm', 'slack'];
    expect(providers).toHaveLength(4);
  });

  // Type-only exports are verified at compile time by the `import type` uses in
  // the sibling tests (ChannelConfig, TwilioProviderOptions, INotificationHttp, …).
});
