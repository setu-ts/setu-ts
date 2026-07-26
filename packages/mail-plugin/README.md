# @hono-enterprise/mail-plugin

Transactional email. Registers an `IMailer` under `CAPABILITIES.MAIL` (`'mail'`).

Four providers ship: `LogProvider` (zero-dependency default), `SmtpProvider` (over
`npm:nodemailer`), `SesProvider` (AWS SESv2), and `SendGridProvider` (SendGrid v3 HTTP API over
`fetch`, so it is Workers-portable).

## Installation

```typescript
import { MailPlugin } from '@hono-enterprise/mail-plugin';
```

## Usage

```typescript
import { MailPlugin } from '@hono-enterprise/mail-plugin';
import { CAPABILITIES, type IMailer } from '@hono-enterprise/common';

app.register(MailPlugin({
  provider: 'sendgrid',
  options: { apiKey: process.env.SENDGRID_API_KEY! },
  defaults: { from: 'no-reply@example.com' },
  templates: {
    welcome: { subject: 'Welcome', html: '<p>Hello {{ name }}</p>' },
  },
}));

const mailer = app.services.get<IMailer>(CAPABILITIES.MAIL);

await mailer.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' });

// `subject` is required on sendTemplate; the template supplies the body.
await mailer.sendTemplate('welcome', { to: 'ada@example.com', subject: 'Welcome' }, {
  name: 'Ada',
});
```

## Options

| Option      | Type                                     | Default | Description                               |
| ----------- | ---------------------------------------- | ------- | ----------------------------------------- |
| `provider`  | `'log' \| 'smtp' \| 'ses' \| 'sendgrid'` | `'log'` | Backend.                                  |
| `options`   | `MailProviderOptions`                    | —       | Provider-specific configuration.          |
| `defaults`  | `{ from?: string }`                      | —       | Applied when a message omits the field.   |
| `templates` | `Record<string, MailTemplate>`           | —       | Named bodies available to `sendTemplate`. |

## Runtime support

`SmtpProvider` needs raw sockets, so it runs on Node/Deno/Bun only. `LogProvider`, `SesProvider`,
and `SendGridProvider` work on every runtime including Cloudflare Workers.

## Templates

The template engine renders named `{{ variable }}` placeholders. The `html` body is
**HTML-escaped**; a missing variable or an unknown template **throws** rather than rendering an
empty string.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
