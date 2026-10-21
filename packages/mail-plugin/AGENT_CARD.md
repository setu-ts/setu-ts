# @setu-ts/mail-plugin — transactional email

`setu add mail` installs it and registers `MailPlugin()` in a recognized functional config;
otherwise add that line in `setu.config.ts`. The default provider only logs. `CAPABILITIES.MAIL`
resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMailer } from '@setu-ts/common';
import { MailPlugin } from '@setu-ts/mail-plugin';

app.register(
  MailPlugin({
    provider: 'sendgrid',
    options: { apiKey: '<sendgrid-api-key>' },
    defaults: { from: 'no-reply@example.com' },
    templates: { welcome: { html: '<p>Hello {{ name }}</p>' } },
  }),
);

await app.start();
const mailer = app.services.get<IMailer>(CAPABILITIES.MAIL);
await mailer.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' });
await mailer.sendTemplate('welcome', { to: 'ada@example.com', subject: 'Welcome' }, { name: 'Ada' });
```

- `provider` is `'log'` (default), `'smtp'` (`options.host`, `port`, `secure`, `auth`), `'ses'`
  (`options.region`, `accessKeyId`, `secretAccessKey`) or `'sendgrid'` (`options.apiKey`,
  `endpoint`). `'smtp'` needs raw sockets, so Node/Deno/Bun only; the others also run on Workers.
- Give `options.client` (SES) or `options.transport` (SMTP) an injected facade to skip the lazy SDK
  import; `options.http` replaces `fetch` for SendGrid.
- `from` comes from the message or `defaults.from`; with neither, `send` throws. `sendTemplate`'s
  `subject` is required — the template supplies only `html`/`text`.
- A string template uses `{{ variable }}` and HTML-escapes `html`; a missing variable or unknown
  template name throws. A component template `{ view, text? }` renders through `CAPABILITIES.VIEW`,
  so register a view provider or `MailPlugin` refuses at registration. Never mix `view` with `html`
  in one template.
- `mailer.send` resolves when the provider accepts the message, not when it is delivered.
