# @setu-ts/notification-plugin — email, SMS, push and Slack notifications

`setu add notification` installs it and prints `NotificationPlugin({ channels: {} })` for
`setu.config.ts` — the `channels` map is required, so replace the empty one with real channels.
`CAPABILITIES.NOTIFICATION` resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { INotifier } from '@setu-ts/common';
import { NotificationPlugin } from '@setu-ts/notification-plugin';

app.register(
  NotificationPlugin({
    channels: {
      email: { provider: 'mail' },
      sms: { provider: 'twilio', options: { accountSid: '…', authToken: '…', from: '+15550100' } },
      slack: { provider: 'slack', options: { webhookUrl: 'https://hooks.slack.com/…' } },
    },
  }),
);

await app.start();
const notifier = app.services.get<INotifier>(CAPABILITIES.NOTIFICATION);
await notifier.send({
  channels: ['email', 'sms', 'slack'],
  to: { email: 'ada@example.com', phone: '+15550123', channel: '#alerts' },
  subject: 'Deploy finished',
  body: 'Build 412 is live.',
});
```

- Channel keys are your dispatch names; each reads one address field from `to`: `email` reads
  `to.email` and sends through `CAPABILITIES.MAIL`, `sms` reads `to.phone` through Twilio, `push`
  reads `to.token` through FCM, and `slack` optionally reads `to.channel`.
- `email: { provider: 'mail' }` needs a registered `mail` provider (`setu add mail`); without one,
  `register` throws. Push with the default signer needs the runtime plugin; supply `tokenSource`
  (`FcmTokenSource`) to avoid the service-account key and that requirement.
- `ChannelConfig` is a union on `provider`, so a missing credential is a compile error: Twilio takes
  `accountSid`, `authToken`, `from`; Slack takes `webhookUrl`; FCM takes `projectId`, `clientEmail`,
  `privateKey`.
- `send` fans out with `Promise.allSettled` and throws one AggregateError if any channel failed; one
  failure never aborts the others. `sendSettled` reports per-channel results without throwing.
- `push` uses `subject` as the notification title. `body` is required on every channel.
