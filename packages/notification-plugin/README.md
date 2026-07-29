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

## Push (FCM HTTP v1)

`FcmProvider` speaks **FCM HTTP v1**, authenticating with a short-lived OAuth2 token minted from a
service account — it signs an RS256 JWT assertion with `runtime.subtle` (no npm dependency, works on
Workers) and caches the token until shortly before it expires.

```typescript
push: {
  provider: 'fcm',
  options: {
    projectId: config.get('FCM_PROJECT_ID'),
    clientEmail: config.get('FCM_CLIENT_EMAIL'),
    privateKey: config.get('FCM_PRIVATE_KEY'), // PEM PKCS#8 from the service-account JSON
  },
},
```

The three fields come from the service-account JSON you download from the Firebase console
(`project_id`, `client_email`, `private_key`). Because the default signer needs Web Crypto and the
wall clock, a `push` channel configured this way requires `RuntimePlugin` and throws during
`register` without it.

To source tokens elsewhere — a GCP metadata server, or a broker that holds the key outside the
application — supply a `tokenSource` implementing `FcmTokenSource`; the credential fields are then
unused and the runtime requirement does not apply.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
