/**
 * H-70c-4 — the `notification` health indicator must report each channel's
 * reachability rather than a hardcoded `up`.
 *
 * The pre-fix indicator resolved `{ status: 'up', data: { channels } }`
 * unconditionally, so an email channel whose SMTP host had gone was reported
 * healthy beside a list naming it.
 *
 * The email channel is the only one that can honestly answer: it delegates to
 * an `IMailer`, which carries its own probe. The send-only transports report
 * `'unknown'`, which never reads as healthy — see `NotificationChannel.isHealthy`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { HealthCheckResult, IMailer, MailMessage } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { NotificationPlugin } from '../../src/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeNotificationHttp } from '../fixtures/fake-notification-http.ts';

/** An `IMailer` whose optional probe answers however the test needs. */
function mailerReporting(
  isHealthy?: () => Promise<boolean | undefined>,
): IMailer & { probeCalls: number } {
  let probeCalls = 0;
  const mailer: IMailer & { probeCalls: number } = {
    send: (_m: MailMessage) => Promise.resolve(),
    sendTemplate: () => Promise.resolve(),
    get probeCalls() {
      return probeCalls;
    },
  };
  if (isHealthy !== undefined) {
    mailer.isHealthy = () => {
      probeCalls += 1;
      return isHealthy();
    };
  }
  return mailer;
}

/** Registers an email + slack app and returns its indicator. */
function registerWith(mailer: IMailer): {
  indicator: () => Promise<HealthCheckResult>;
} {
  const fake = createFakeContext({ [CAPABILITIES.MAIL]: mailer });
  NotificationPlugin({
    channels: {
      email: { provider: 'mail' },
      slack: {
        provider: 'slack',
        options: {
          webhookUrl: 'https://hooks.slack.com/services/T/B/X',
          http: createFakeNotificationHttp({ responseBody: 'ok' }),
        },
      },
    },
  }).register(fake.ctx);
  const indicator = fake.healthIndicators.get('notification');
  if (indicator === undefined) throw new Error('no notification indicator registered');
  return { indicator };
}

describe('notification health — reachability (H-70c-4)', () => {
  it('reports DOWN when the email transport is unreachable', async () => {
    // The whole point of the row: this answered `up` before.
    const { indicator } = registerWith(mailerReporting(() => Promise.resolve(false)));
    expect(await indicator()).toEqual({
      status: 'down',
      data: {
        channels: ['email', 'slack'],
        reachable: { email: false, slack: 'unknown' },
      },
    });
  });

  it('reports the email transport reachable when the mailer answers', async () => {
    const { indicator } = registerWith(mailerReporting(() => Promise.resolve(true)));
    expect(await indicator()).toEqual({
      status: 'up',
      data: {
        channels: ['email', 'slack'],
        reachable: { email: true, slack: 'unknown' },
      },
    });
  });

  it("reports 'unknown', never true, when the mailer cannot answer", async () => {
    // A `MailService` over a provider with no probe — `LogProvider`,
    // `SendGridProvider` — resolves `undefined`. Reading that as healthy is
    // exactly the falsely-affirmative answer the tri-state exists to prevent.
    const { indicator } = registerWith(mailerReporting(() => Promise.resolve(undefined)));
    const result = await indicator();
    expect(result.status).toBe('up');
    expect((result.data as { reachable: Record<string, unknown> }).reachable.email)
      .toBe('unknown');
  });

  it("reports 'unknown' when the injected mailer implements no probe at all", async () => {
    const { indicator } = registerWith(mailerReporting());
    const result = await indicator();
    expect(result.status).toBe('up');
    expect((result.data as { reachable: Record<string, unknown> }).reachable.email)
      .toBe('unknown');
  });

  it('counts a rejecting probe as unreachable, not as unknown', async () => {
    // Reached for and did not answer is `false`. `undefined` is reserved for
    // "the question could not be asked", which a throwing transport did ask.
    const { indicator } = registerWith(
      mailerReporting(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const result = await indicator();
    expect(result.status).toBe('down');
    expect((result.data as { reachable: Record<string, unknown> }).reachable.email)
      .toBe(false);
  });

  it('caches the probe, so scraping health never turns into transport load', async () => {
    const mailer = mailerReporting(() => Promise.resolve(true));
    const { indicator } = registerWith(mailer);
    await indicator();
    await indicator();
    await indicator();
    expect(mailer.probeCalls).toBe(1);
  });

  it('never probes a send-only channel, because a probe would deliver', async () => {
    const http = createFakeNotificationHttp({ responseBody: 'ok' });
    const fake = createFakeContext();
    NotificationPlugin({
      channels: {
        slack: { provider: 'slack', options: { webhookUrl: 'https://hooks/x', http } },
        sms: {
          provider: 'twilio',
          options: { accountSid: 'AC1', authToken: 't', from: '+15550000000', http },
        },
      },
    }).register(fake.ctx);

    const result = await fake.healthIndicators.get('notification')!();
    expect(result).toEqual({
      status: 'up',
      data: {
        channels: ['slack', 'sms'],
        reachable: { slack: 'unknown', sms: 'unknown' },
      },
    });
    // No notification was delivered on the way to that answer.
    expect(http.getLastCall()).toBeUndefined();
  });
});
