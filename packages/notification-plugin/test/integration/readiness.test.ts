/**
 * M131a V11-11: the `notification` indicator is out of readiness by default.
 *
 * Every notification channel addresses a dependency every replica shares (the
 * mail server, the SMS provider, the push gateway), so a channel outage cannot
 * be fixed by draining replicas — the M119b rule that puts `mail` out of
 * readiness applies to the whole indicator. A failing channel therefore makes
 * `/health` report `notification: down` while `/ready` still answers 200; an
 * application that wants a channel to gate traffic opts in through the health
 * plugin's per-indicator override (`readiness: { include: ['notification'] }`),
 * and then `/ready` answers 503.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { HealthReport, IMailer, IPlugin, IPluginContext, MailMessage } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { NotificationPlugin } from '../../src/index.ts';

/** A mailer whose transport is down: `isHealthy()` answers `false`. */
function FailingMailerPlugin(sent: MailMessage[]): IPlugin {
  return {
    name: 'failing-mail-stub',
    version: '0.1.0',
    provides: [CAPABILITIES.MAIL],
    register(ctx: IPluginContext): void {
      const mailer: IMailer = {
        send(message: MailMessage): Promise<void> {
          sent.push(message);
          return Promise.reject(new Error('smtp connection refused'));
        },
        sendTemplate(): Promise<void> {
          return Promise.reject(new Error('sendTemplate is not used by the email channel'));
        },
        isHealthy(): Promise<boolean> {
          return Promise.resolve(false);
        },
      };
      ctx.services.register<IMailer>(CAPABILITIES.MAIL, mailer);
    },
  };
}

function notificationApp(
  healthOptions?: Parameters<typeof HealthPlugin>[0],
): ReturnType<typeof createApplication> {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      FailingMailerPlugin([]),
      NotificationPlugin({ channels: { email: { provider: 'mail' } } }),
      HealthPlugin(healthOptions),
    ],
  });
}

describe('M131a V11-11 notification readiness membership', () => {
  it('a failing channel makes /health down but /ready 200 (out of readiness by default)', async () => {
    const app = await notificationApp({ details: true });
    await app.start();
    try {
      const health = await app.inject({ method: 'GET', url: '/health' });
      expect(health.statusCode).toBe(503);
      const checks = health.json<HealthReport>().checks;
      expect(checks.notification?.status).toBe('down');
      expect(checks.notification?.data?.reachable).toEqual({ email: false });

      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it('the per-indicator override pulls notification into readiness, so /ready is 503', async () => {
    const app = await notificationApp({ readiness: { include: ['notification'] } });
    await app.start();
    try {
      const ready = await app.inject({ method: 'GET', url: '/ready' });
      expect(ready.statusCode).toBe(503);
      const checks = ready.json<HealthReport>().checks;
      expect(checks.notification?.status).toBe('down');
    } finally {
      await app.stop();
    }
  });
});
