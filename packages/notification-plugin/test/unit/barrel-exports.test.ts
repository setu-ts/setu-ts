/**
 * Verifies every symbol listed in §4 of the milestone plan is defined/exported.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as barrel from '../../src/index.ts';

describe('barrel exports', () => {
  it('exports NotificationPlugin factory', () => {
    expect(barrel.NotificationPlugin).toBeDefined();
  });

  it('exports createChannel', () => {
    expect(barrel.createChannel).toBeDefined();
  });

  it('exports createProvider', () => {
    expect(barrel.createProvider).toBeDefined();
  });

  it('exports NotificationService', () => {
    expect(barrel.NotificationService).toBeDefined();
  });

  it('exports EmailChannel', () => {
    expect(barrel.EmailChannel).toBeDefined();
  });

  it('exports SmsChannel', () => {
    expect(barrel.SmsChannel).toBeDefined();
  });

  it('exports PushChannel', () => {
    expect(barrel.PushChannel).toBeDefined();
  });

  it('exports SlackChannel', () => {
    expect(barrel.SlackChannel).toBeDefined();
  });

  it('exports TwilioProvider', () => {
    expect(barrel.TwilioProvider).toBeDefined();
  });

  it('exports FcmProvider', () => {
    expect(barrel.FcmProvider).toBeDefined();
  });

  it('exports SlackProvider', () => {
    expect(barrel.SlackProvider).toBeDefined();
  });

  it('exports createDefaultNotificationHttp', () => {
    expect(barrel.createDefaultNotificationHttp).toBeDefined();
  });

  // Type exports are verified at compile time by the presence of the import statement.
});
