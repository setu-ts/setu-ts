# @setu-ts/mail-plugin — send transactional email

**Add it:** `setu add mail` adds it and wires `MailPlugin()` in a recognized functional config. It
provides `CAPABILITIES.MAIL` (`IMailer`); the default provider only logs.

## Configure a provider and a welcome template

Use this registration in `setu.config.ts`:

```ts
import { MailPlugin } from '@setu-ts/mail-plugin';

export const mail = MailPlugin({
  provider: 'sendgrid',
  options: { apiKey: process.env.SENDGRID_API_KEY! },
  defaults: { from: 'no-reply@example.com' },
  templates: { welcome: { html: '<p>Hello {{ name }}</p>' } },
});
```

## Send a welcome email from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMailer, IRouterApi } from '@setu-ts/common';

export function registerWelcomeRoutes(router: IRouterApi): void {
  router.post('/welcome', {
    handler: async (ctx) => {
      const { email, name } = await ctx.request.json<{ email: string; name: string }>();
      const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
      await mailer.sendTemplate('welcome', { to: email, subject: 'Welcome' }, { name });
      return ctx.response.json({ accepted: true });
    },
  });
}
```

## Behaviour the types do not show

- The sender comes from the message's `from` or `defaults.from`; neither present means sending
  rejects. Templates supply bodies only: the message still needs `subject`.
- String templates HTML-escape substituted values in `html`; `text` substitutions stay raw. Unknown
  template names or missing placeholder variables reject.
- Component templates require `CAPABILITIES.VIEW` at registration; an absent provider fails startup.
  Their data is passed as props without the string arm's missing-variable check.
- Sending resolves when the provider accepts the message; it does not prove recipient delivery.
- SMTP needs raw sockets on Node, Deno or Bun; the other providers also work on Workers.

## Other options

- `provider` also selects `'log'`, `'smtp'` or `'ses'`; `send` sends an untemplated message.
- SMTP uses `host`, `port`, `secure`, `auth` or injected `transport`; SES uses `region`,
  `accessKeyId`, `secretAccessKey` or injected `client` inside `options`.
- SendGrid's `options.http` replaces its HTTP transport; component templates use `{ view, text? }`
  and cannot mix `view` with `html`.
