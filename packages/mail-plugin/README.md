# @setu-ts/mail-plugin

Transactional email. Registers an `IMailer` under `CAPABILITIES.MAIL` (`'mail'`).

Four providers ship: `LogProvider` (zero-dependency default), `SmtpProvider` (over
`npm:nodemailer`), `SesProvider` (AWS SESv2), and `SendGridProvider` (SendGrid v3 HTTP API over
`fetch`, so it is Workers-portable).

## Installation

```typescript
import { MailPlugin } from '@setu-ts/mail-plugin';
```

## Usage

```typescript
import { MailPlugin } from '@setu-ts/mail-plugin';
import { CAPABILITIES, type IMailer } from '@setu-ts/common';

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

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `adaptNodemailerModule`   | function  |
| `adaptSesModule`          | function  |
| `createProvider`          | function  |
| `escapeHtml`              | function  |
| `loadNodemailerModule`    | function  |
| `loadSesModule`           | function  |
| `MailPlugin`              | function  |
| `toNodemailerMessage`     | function  |
| `toSendGridBody`          | function  |
| `toSesInput`              | function  |
| `validateSesClient`       | function  |
| `validateSmtpTransport`   | function  |
| `LogProvider`             | class     |
| `MailService`             | class     |
| `SendGridProvider`        | class     |
| `SesProvider`             | class     |
| `SmtpProvider`            | class     |
| `TemplateEngine`          | class     |
| `IMailer`                 | interface |
| `ISesClient`              | interface |
| `ISmtpTransport`          | interface |
| `LogProviderOptions`      | interface |
| `MailMessage`             | interface |
| `MailPluginOptions`       | interface |
| `MailProviderOptions`     | interface |
| `MailServiceOptions`      | interface |
| `MailTemplate`            | interface |
| `NodemailerModule`        | interface |
| `RenderedTemplate`        | interface |
| `SendGridProviderOptions` | interface |
| `SesProviderOptions`      | interface |
| `SesSdkModule`            | interface |
| `SmtpProviderOptions`     | interface |
| `IMailHttp`               | type      |
| `MailProviderType`        | type      |
| `OutgoingMail`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#mailplugin-setu-tsmail-plugin).
