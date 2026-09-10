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
import type { HealthCheckResult, IMailer } from '@setu-ts/common';
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
    send: () => Promise.resolve(),
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

/**
 * Registers N email channels over ONE mailer, so several probes are in flight
 * at once — the shape that exposes serial awaiting.
 */
function registerWithAliases(mailer: IMailer, aliases: readonly string[]): {
  indicator: () => Promise<HealthCheckResult>;
} {
  const fake = createFakeContext({ [CAPABILITIES.MAIL]: mailer });
  const channels: Record<string, { provider: 'mail' }> = {};
  for (const alias of aliases) {
    channels[alias] = { provider: 'mail' };
  }
  NotificationPlugin({ channels }).register(fake.ctx);
  const indicator = fake.healthIndicators.get('notification');
  if (indicator === undefined) throw new Error('no notification indicator registered');
  return { indicator };
}

describe('notification health — probe concurrency', () => {
  it('bounds total latency by ONE probe timeout, not by their sum', async () => {
    // Each channel probe may consume its full 2s bound, and the health
    // service's own per-indicator deadline defaults to 5s (M90b). Awaited one
    // after another, three stalled channels — an ordinary configuration, since
    // channel names are arbitrary and several may address one transport —
    // exceed that deadline, and the whole payload is replaced by a generic
    // `{ reason: 'timeout' }`, discarding exactly the per-channel evidence it
    // exists to carry.
    //
    // Measured on the wall clock deliberately: the claim IS about elapsed
    // time, and a fake clock would assert the shape of the code rather than
    // the property. The probe is stalled for 150ms rather than the real 2s so
    // the test stays fast; serial execution of five would take 750ms+.
    const stallMs = 150;
    const mailer = mailerReporting(() =>
      new Promise((resolve) => setTimeout(() => resolve(true), stallMs))
    );
    const { indicator } = registerWithAliases(mailer, [
      'email',
      'ops',
      'billing',
      'alerts',
      'digest',
    ]);

    const started = performance.now();
    const result = await indicator();
    const elapsed = performance.now() - started;

    // Well under 5 × 150ms, and comfortably above a single stall.
    expect(elapsed).toBeLessThan(stallMs * 3);
    // Every channel's own outcome survives — the point of not timing out.
    expect(result.data).toEqual({
      channels: ['email', 'ops', 'billing', 'alerts', 'digest'],
      reachable: { email: true, ops: true, billing: true, alerts: true, digest: true },
    });
  });

  it('assembles the payload in channel-map order, not settle order', async () => {
    // Concurrency must not make the key order depend on which probe won.
    let call = 0;
    const mailer = mailerReporting(() => {
      call += 1;
      const delay = call === 1 ? 40 : 0;
      return new Promise((resolve) => setTimeout(() => resolve(true), delay));
    });
    const { indicator } = registerWithAliases(mailer, ['zulu', 'alpha', 'mike']);
    const result = await indicator();
    const reachable = (result.data as { reachable: Record<string, unknown> }).reachable;
    expect(Object.keys(reachable)).toEqual(['zulu', 'alpha', 'mike']);
  });
});

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
    // A `MailService` over a provider that dropped its probe — `SesProvider`
    // with a client exposing no `isHealthy`, `SmtpProvider` with a transport
    // exposing no `verify()` — resolves `undefined`. Reading that as healthy is
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
