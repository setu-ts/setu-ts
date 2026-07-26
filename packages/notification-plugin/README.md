# @hono-enterprise/notification-plugin

Multi-channel notifications — email, SMS, push, Slack. Registers an `INotifier` under
`CAPABILITIES.NOTIFICATION` (`'notification'`).

Two layers: **channels** own address extraction and payload shaping, **providers** own transport.
Every provider speaks web-standard `fetch` through one injectable `INotificationHttp` seam, so there
is no `npm:` import anywhere and all channels are Workers-portable.

## Installation

```typescript
import { NotificationPlugin } from '@hono-enterprise/notification-plugin';
```

## Usage

```typescript
import { NotificationPlugin } from '@hono-enterprise/notification-plugin';
import { CAPABILITIES, type INotifier } from '@hono-enterprise/common';

app.register(NotificationPlugin({
  channels: {
    email: { provider: 'mail' },
    sms: {
      provider: 'twilio',
      options: { accountSid: '…', authToken: '…', from: '+15550100' },
    },
    slack: { provider: 'slack', options: { webhookUrl: 'https://hooks.slack.com/…' } },
  },
}));

const notifier = app.services.get<INotifier>(CAPABILITIES.NOTIFICATION);

await notifier.send({
  channels: ['email', 'sms', 'slack'],
  to: { email: 'ada@example.com', phone: '+15550123' },
  subject: 'Deploy finished',
  body: 'Build 412 is live.',
});
```

## Channels

| Channel | Reads from `to` | Transport                                       |
| ------- | --------------- | ----------------------------------------------- |
| `email` | `to.email`      | the `IMailer` resolved from `CAPABILITIES.MAIL` |
| `sms`   | `to.phone`      | `TwilioProvider`                                |
| `push`  | `to.token`      | `FcmProvider` (`subject` becomes the title)     |
| `slack` | `to.channel` *  | `SlackProvider` (incoming webhook)              |

\* optional.

## Semantics

- **`send` fans out with `Promise.allSettled`** — one failing channel never aborts the others.
  Failures surface together as an `AggregateError` whose `errors` are coerced to `Error`.
- **`ChannelConfig` is a union discriminated on `provider`**, so a missing credential is a **compile
  error**, not a startup throw.
- Configuring `email` without a `mail` capability registered **throws during `register`** — fail
  fast, ordered via `optionalDependencies: ['mail']`.

## Known limitation

`FcmProvider` implements the **legacy FCM `serverKey` API, which Google decommissioned in 2024**.
FCM HTTP v1 with service-account JWT signing is a follow-up; until then, push delivery via this
provider will not work against current FCM.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
