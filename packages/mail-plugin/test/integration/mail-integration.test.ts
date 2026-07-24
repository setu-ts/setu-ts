import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IMailer } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

import { MailPlugin } from '../../src/index.ts';
import type { OutgoingMail } from '../../src/interfaces/index.ts';

describe('Mail integration (through a real kernel app)', () => {
  it('resolves IMailer and sends direct + templated mail, read back via the sink', async () => {
    const sent: OutgoingMail[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MailPlugin({
          provider: 'log',
          defaults: { from: 'noreply@myapp.com' },
          templates: {
            welcome: { html: '<h1>Hi {{ name }}</h1>', text: 'Hi {{ name }}' },
          },
          options: { sink: (m) => sent.push(m) },
        }),
      ],
    });
    await app.start();

    expect(app.services.has('mail')).toBe(true);
    const mailer = app.services.get<IMailer>('mail');

    // Direct send — default `from` is applied, message reaches the provider.
    await mailer.send({
      to: 'user@example.com',
      subject: 'Welcome',
      html: '<h1>Welcome!</h1>',
      text: 'Welcome!',
    });

    // Templated send — body rendered with escaping, subject taken from envelope.
    await mailer.sendTemplate('welcome', { to: 'user@example.com', subject: 'Welcome' }, {
      name: 'A & B',
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]?.from).toBe('noreply@myapp.com');
    expect(sent[0]?.subject).toBe('Welcome');
    expect(sent[1]?.html).toBe('<h1>Hi A &amp; B</h1>');
    expect(sent[1]?.text).toBe('Hi A & B');

    await app.stop();
  });

  it('surfaces a rendering error and never reaches the provider (short-circuit)', async () => {
    const sent: OutgoingMail[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MailPlugin({
          provider: 'log',
          defaults: { from: 'x@x.com' },
          templates: { welcome: { text: 'Hi {{ name }}' } },
          options: { sink: (m) => sent.push(m) },
        }),
      ],
    });
    await app.start();

    const mailer = app.services.get<IMailer>('mail');
    await expect(
      mailer.sendTemplate('welcome', { to: 'u@x.com', subject: 'W' }, {}),
    ).rejects.toThrow('Unknown template variable');
    expect(sent).toHaveLength(0);

    await app.stop();
  });
});
