# @setu-ts/notification-plugin — fan out notifications across channels

**Add it:** `setu add notification` adds it and prints the registration for `setu.config.ts`;
configure `NotificationPlugin({ channels: { email: { provider: 'mail' } } })` with mail already
registered. It provides `CAPABILITIES.NOTIFICATION` (`INotifier`).

## Send a notification and inspect each outcome

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { INotifier, IRouterApi } from '@setu-ts/common';

export function registerNoticeRoutes(router: IRouterApi): void {
  router.post('/notices', {
    handler: async (ctx) => {
      const { email, body } = await ctx.request.json<{ email: string; body: string }>();
      const notifier = ctx.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
      const results = await notifier.sendSettled!({
        channels: ['email'], to: { email }, subject: 'Account update', body,
      });
      return ctx.response.json(results);
    },
  });
}
```

## Require every requested channel to succeed

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { INotifier } from '@setu-ts/common';

const notifier = ctx.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
await notifier.send({
  channels: ['email'], to: { email: 'ada@example.com' },
  subject: 'Deployment complete', body: 'The new version is live.',
});
```

## Behaviour the types do not show

- Channel keys are application-defined dispatch names; the `provider` selects delivery behavior.
  Unknown channels fail.
- Dispatch runs channels concurrently. `send` waits for all and throws one `AggregateError` if any
  failed; each member names its channel and preserves the original error as its cause.
- `sendSettled` returns results in requested channel order without rejecting for channel failures.
  Retry only failed channels.
- Email requires `CAPABILITIES.MAIL` at registration, reads `to.email` and sends `body` as plain
  text. An absent subject becomes `(no subject)`; the mailer supplies its configured sender.
- Slack omits an absent or empty `to.channel` and uses the webhook's default channel.

## Other options

- `'twilio'` reads `to.phone` and requires `accountSid`, `authToken` and `from` in `options`.
- `'slack'` requires `options.webhookUrl`; `'fcm'` reads `to.token` and uses `subject` as its title.
- FCM accepts `tokenSource` instead of service-account credentials; the default signer requires
  `CAPABILITIES.RUNTIME`.

<!-- card-allow: AggregateError -->
