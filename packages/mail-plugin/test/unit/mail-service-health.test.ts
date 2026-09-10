/**
 * `IMailer.isHealthy` — the mail transport's reachability, published on the
 * capability rather than reachable only from inside this package.
 *
 * A holder of the capability could not previously ask the question at all:
 * the probe lived on the internal `MailProvider` port and was read by
 * `MailPlugin`'s indicator directly, so `notification-plugin`'s email channel
 * had nothing to delegate to and AI_GUIDELINES §2.2 forbids it importing this
 * package to find one (H-70c-4).
 *
 * The second suite pins the one-capability-one-implementation rule: the
 * indicator and the service answer through the SAME code, so they cannot
 * drift about what `reachable` means.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMailer } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';

import { MailService } from '../../src/services/mail-service.ts';
import { TemplateEngine } from '../../src/templates/template-engine.ts';
import { MailPlugin } from '../../src/plugin/mail-plugin.ts';
import type { ISmtpTransport, MailProvider, OutgoingMail } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

/** A provider whose optional probe answers however the test needs. */
class ProbingProvider implements MailProvider {
  probeCalls = 0;
  constructor(outcome?: boolean | Error) {
    if (outcome !== undefined) {
      this.isHealthy = () => {
        this.probeCalls += 1;
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      };
    }
  }
  isHealthy?: () => Promise<boolean>;
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  isReady(): boolean {
    return true;
  }
  send(_message: OutgoingMail): Promise<void> {
    return Promise.resolve();
  }
}

function serviceOver(provider: MailProvider): MailService {
  return new MailService(provider, new TemplateEngine(), { defaultFrom: 'x@y.com' });
}

describe('MailService.isHealthy', () => {
  it('reports the provider as reachable', async () => {
    expect(await serviceOver(new ProbingProvider(true)).isHealthy()).toBe(true);
  });

  it('reports the provider as unreachable', async () => {
    expect(await serviceOver(new ProbingProvider(false)).isHealthy()).toBe(false);
  });

  it('reports undefined — not false — when the provider offers no probe', async () => {
    // `LogProvider` and `SendGridProvider` legitimately have none. Reporting
    // `false` would mark a working mailer down; reporting `true` would be the
    // falsely-affirmative answer. Neither is honest, so neither is given.
    expect(await serviceOver(new ProbingProvider()).isHealthy()).toBeUndefined();
  });

  it('lets a rejecting probe propagate to its caller', async () => {
    // The service adds no policy: the caller decides what a thrown probe
    // means, and `MailPlugin`'s own indicator bounds it through the health
    // plugin's per-indicator deadline.
    await expect(serviceOver(new ProbingProvider(new Error('EHOSTUNREACH'))).isHealthy())
      .rejects.toThrow('EHOSTUNREACH');
  });
});

describe('the mail indicator and IMailer.isHealthy are one implementation', () => {
  /**
   * Drives BOTH entry points on ONE registered app under a NON-DEFAULT
   * configuration (an injected SMTP transport, not the `log` default) and
   * asserts they agree.
   *
   * MEASURED: this suite is a DRIFT GUARD, not the guard for the fix. Pointing
   * the indicator back past the service at `provider.isHealthy` — the shape it
   * had before this change — leaves all three cases green, because both paths
   * end at the same provider and today agree by construction. What it catches
   * is the NEXT edit: a cache, a fallback or a policy added to
   * `MailService.isHealthy` while the indicator still reads the provider raw,
   * which is precisely how one capability comes to give two answers.
   *
   * The discriminating tests for the fix are the `MailService.isHealthy`
   * suite above (deleting the method fails all seven steps in this file) and
   * `notification-plugin`'s email delegation.
   */
  async function bothAnswers(
    verify?: () => Promise<boolean>,
  ): Promise<{ indicator: unknown; capability: boolean | undefined }> {
    const transport = {
      sendMail: () => Promise.resolve({}),
      ...(verify === undefined ? {} : { verify }),
    } as unknown as ISmtpTransport;

    const fake = createFakeContext();
    await MailPlugin({ provider: 'smtp', options: { transport } }).register!(fake.ctx);

    const indicator = await fake.healthIndicators.get(CAPABILITIES.MAIL)!();
    const mailer = fake.registered.get(CAPABILITIES.MAIL) as IMailer;
    const capability = await mailer.isHealthy!();
    return { indicator, capability };
  }

  it('agree that a verifying transport is reachable', async () => {
    const { indicator, capability } = await bothAnswers(() => Promise.resolve(true));
    expect(indicator).toEqual({ status: 'up', data: { provider: 'smtp', reachable: true } });
    expect(capability).toBe(true);
  });

  it('agree that a refusing transport is unreachable', async () => {
    // A real nodemailer `verify()` REJECTS on an unreachable host; it does not
    // resolve `false`. A double that resolved `false` would be testing a
    // transport that does not exist — and `SmtpProvider` reads a resolved
    // call as success, so such a double reports `up` for a dead server.
    const { indicator, capability } = await bothAnswers(() =>
      Promise.reject(new Error('ECONNREFUSED 127.0.0.1:587'))
    );
    expect(indicator).toEqual({ status: 'down', data: { provider: 'smtp', reachable: false } });
    expect(capability).toBe(false);
  });

  it("agree that a transport with no verify is 'unknown', never healthy", async () => {
    const { indicator, capability } = await bothAnswers();
    expect(indicator).toEqual({ status: 'up', data: { provider: 'smtp', reachable: 'unknown' } });
    expect(capability).toBeUndefined();
  });
});
