import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { MailService } from '../../src/services/mail-service.ts';
import { TemplateEngine } from '../../src/templates/template-engine.ts';
import type { MailProvider, OutgoingMail } from '../../src/interfaces/index.ts';

/** Records every message handed to the provider, in order. */
class RecordingProvider implements MailProvider {
  readonly sent: OutgoingMail[] = [];
  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }
  isReady(): boolean {
    return true;
  }
  send(message: OutgoingMail): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

describe('MailService.send', () => {
  it('uses the per-message from when present', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine(), { defaultFrom: 'default@x.com' });

    await svc.send({ to: 'a@x.com', subject: 'Hi', text: 'yo', from: 'me@x.com' });

    expect(provider.sent[0]?.from).toBe('me@x.com');
    expect(provider.sent[0]?.to).toBe('a@x.com');
  });

  it('falls back to the configured default from', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine(), { defaultFrom: 'default@x.com' });

    await svc.send({ to: 'a@x.com', subject: 'Hi', text: 'yo' });

    expect(provider.sent[0]?.from).toBe('default@x.com');
  });

  it('throws when neither a message from nor a default is available', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine());

    await expect(svc.send({ to: 'a@x.com', subject: 'Hi', text: 'yo' })).rejects.toThrow(
      'requires a "from" address',
    );
    expect(provider.sent).toHaveLength(0);
  });
});

describe('MailService.sendTemplate', () => {
  it('renders the body and reaches the provider with the resolved default from', async () => {
    const provider = new RecordingProvider();
    const engine = new TemplateEngine({
      welcome: { html: '<h1>Hi {{ name }}</h1>', text: 'Hi {{ name }}' },
    });
    // A NON-default from (empty per-message) exercises the shared resolution path.
    const svc = new MailService(provider, engine, { defaultFrom: 'noreply@myapp.com' });

    await svc.sendTemplate('welcome', { to: 'u@x.com', subject: 'Welcome' }, { name: 'John' });

    const sent = provider.sent[0];
    expect(sent?.from).toBe('noreply@myapp.com');
    expect(sent?.subject).toBe('Welcome');
    expect(sent?.html).toBe('<h1>Hi John</h1>');
    expect(sent?.text).toBe('Hi John');
  });

  it('does not call the provider when template rendering throws (short-circuit)', async () => {
    const provider = new RecordingProvider();
    const engine = new TemplateEngine({ welcome: { text: 'Hi {{ name }}' } });
    const svc = new MailService(provider, engine, { defaultFrom: 'x@x.com' });

    await expect(
      svc.sendTemplate('welcome', { to: 'u@x.com', subject: 'W' }, {}),
    ).rejects.toThrow('Unknown template variable');
    expect(provider.sent).toHaveLength(0);
  });
});
