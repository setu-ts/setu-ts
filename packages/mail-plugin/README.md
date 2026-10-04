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
    welcome: { html: '<p>Hello {{ name }}</p>' },
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

| Option      | Type                                     | Default | Description                                                                                                                                  |
| ----------- | ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`  | `'log' \| 'smtp' \| 'ses' \| 'sendgrid'` | `'log'` | Backend.                                                                                                                                     |
| `options`   | `MailProviderOptions`                    | —       | Provider-specific configuration.                                                                                                             |
| `defaults`  | `{ from?: string }`                      | —       | Applied when a message omits the field.                                                                                                      |
| `templates` | `Record<string, MailTemplate>`           | —       | Named bodies available to `sendTemplate`: `{{ variable }}` strings, or view components rendered through `CAPABILITIES.VIEW` (see Templates). |

## Runtime support

`SmtpProvider` needs raw sockets, so it runs on Node/Deno/Bun only. `LogProvider`, `SesProvider`,
and `SendGridProvider` work on every runtime including Cloudflare Workers.

## Templates

A template is one of two arms, and the two never mix in one template (a template carrying both
`view` and `html` is a compile error).

**String templates** render named `{{ variable }}` placeholders. The `html` body is
**HTML-escaped**; a missing variable or an unknown template **throws** rather than rendering an
empty string.

**Component templates** (`{ view, text? }`) render through the view engine registered under
`CAPABILITIES.VIEW` — a JSX component, an `html` tagged template, or a plain `(props) => string`
function — with `sendTemplate`'s `data` passed to each component verbatim as its props. `view`
renders the HTML body; the optional `text` renders the plain-text body and is used verbatim, so
write it as a plain `(props) => string` function — a text component written with the `html` tag or
JSX is HTML-escaped like any other, which puts entities (`&amp;`) into a plain-text mail.
Configuring one requires a `CAPABILITIES.VIEW` provider: `MailPlugin` refuses at `register()`
otherwise, naming both remedies, so the failure is a startup failure rather than a throw on the
first send.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ViewPlugin } from '@setu-ts/view-plugin';
import { MailPlugin } from '@setu-ts/mail-plugin';
import { CAPABILITIES, type IMailer } from '@setu-ts/common';
import { html } from '@hono/hono/html';

interface WelcomeProps {
  readonly name: string;
  readonly plan: string;
}

// The `html` tag escapes `name` and `plan`; a JSX component would too.
const WelcomeHtml = (p: WelcomeProps) =>
  html`
    <h1>Welcome ${p.name}</h1>
    <p>You are on the ${p.plan} plan.</p>
  `;
const WelcomeText = (p: WelcomeProps) => `Welcome ${p.name}. You are on the ${p.plan} plan.`;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ViewPlugin({ engine: 'hono-html' }),
    MailPlugin({
      defaults: { from: 'no-reply@example.com' },
      templates: {
        welcome: { view: WelcomeHtml, text: WelcomeText },
      },
    }),
  ],
});
await app.start();

const mailer = app.services.get<IMailer>(CAPABILITIES.MAIL);
await mailer.sendTemplate('welcome', { to: 'ada@example.com', subject: 'Welcome' }, {
  name: 'Ada',
  plan: 'team',
});
```

Two things differ from the string arm. Escaping is the rendering runtime's: an `html` template and a
JSX component escape their interpolations, while a hand-written template literal does not (the same
caveat `IViewEngine.render` carries for a page). And there is **no missing-key check**: a component
reads whatever it reads, so a key absent from `data` renders as `undefined` rather than throwing.
The committed `sendTemplate` signature types `data` as `Record<string, unknown>`; for compile-time
props, render by hand — `engine.render(WelcomeHtml, props)` on the engine resolved from
`CAPABILITIES.VIEW`, then `mailer.send({ ..., html })`.

`TemplateEngine.render` is asynchronous for both arms, because a view component's render may be.

## Health indicator

Registered under the `mail` capability. Since M70c it reports two signals: the provider's lifecycle
(`isReady()`) and its reachability (`isHealthy()`).

| Status | Meaning                                                                                    |
| ------ | ------------------------------------------------------------------------------------------ |
| `up`   | The provider is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The provider is not connected, or is connected but unreachable.                            |

`data` reports `{ provider, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the provider has no liveness check (e.g. the log provider always reports `true`).

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
| `MailComponentTemplate`   | interface |
| `MailMessage`             | interface |
| `MailPluginOptions`       | interface |
| `MailProviderOptions`     | interface |
| `MailServiceOptions`      | interface |
| `MailStringTemplate`      | interface |
| `NodemailerModule`        | interface |
| `RenderedTemplate`        | interface |
| `SendGridProviderOptions` | interface |
| `SesProviderOptions`      | interface |
| `SesSdkModule`            | interface |
| `SmtpProviderOptions`     | interface |
| `IMailHttp`               | type      |
| `MailProviderType`        | type      |
| `MailTemplate`            | type      |
| `OutgoingMail`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#mailplugin-setu-tsmail-plugin).
