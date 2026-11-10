import { describe, expect, it } from 'vitest';

import type { Component, IViewEngine } from '@setu-ts/common';

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
  it('M139c validates one attachment refusal table through send and sendTemplate before dispatch', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine({ file: { text: 'body' } }), {
      defaultFrom: 'nondefault@x.com',
    });
    const invalid: [string, unknown][] = [
      ...[
        '',
        'x'.repeat(256),
        '\ud800',
        1,
        ...Array.from({ length: 32 }, (_, i) => `x${String.fromCharCode(i)}y`),
        'x\x7fy',
      ].map((value): [string, unknown] => ['filename', value]),
      ...[null, 1, {}, []].map((value): [string, unknown] => ['content', value]),
      ...[
        'text/plain; charset=utf-8',
        'bad',
        '',
        1,
        'text/\rplain',
        'text/\nplain',
        'text/\x00plain',
        'text/\x7fplain',
      ].map((value): [string, unknown] => ['contentType', value]),
      ...[
        '',
        'x'.repeat(256),
        '<x>',
        'a b',
        1,
        ...Array.from({ length: 32 }, (_, i) => `x${String.fromCharCode(i)}y`),
        'x\x7fy',
      ].map((value): [string, unknown] => ['contentId', value]),
    ];
    for (const [field, value] of invalid) {
      const attachments = [
        { filename: 'valid', content: 'secret-content' },
        { filename: 'f', content: 'secret-content', [field]: value },
      ] as import('@setu-ts/common').MailAttachment[];
      const message = { to: 'to@x.com', subject: 'file', attachments };
      for (const call of [() => svc.send(message), () => svc.sendTemplate('file', message, {})]) {
        await expect(call()).rejects.toThrow(`Mail attachment 1: invalid ${field}`);
      }
    }
    expect(provider.sent).toHaveLength(0);
  });
  it('M139c refuses a non-array attachment list and a non-object attachment through both entry points', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine({ file: { text: 'body' } }), {
      defaultFrom: 'nondefault@x.com',
    });
    const cases: [unknown, string][] = [
      [{ filename: 'f', content: 'x' }, 'Mail attachments must be an array'],
      ['not-a-list', 'Mail attachments must be an array'],
      [[null], 'Mail attachment 0: invalid attachment'],
      [['file'], 'Mail attachment 0: invalid attachment'],
      [[['f', 'x']], 'Mail attachment 0: invalid attachment'],
    ];
    for (const [attachments, refusal] of cases) {
      const message = {
        to: 'to@x.com',
        subject: 'file',
        attachments: attachments as import('@setu-ts/common').MailAttachment[],
      };
      for (const call of [() => svc.send(message), () => svc.sendTemplate('file', message, {})]) {
        await expect(call()).rejects.toThrow(new TypeError(refusal));
      }
    }
    expect(provider.sent).toHaveLength(0);
  });
  it('M139c resolves UTF-8 text to bytes through both entry points and preserves byte attachments', async () => {
    const provider = new RecordingProvider();
    const svc = new MailService(provider, new TemplateEngine({ file: { text: 'body' } }), {
      defaultFrom: 'nondefault@x.com',
    });
    const message = {
      to: 'to@x.com',
      subject: 'file',
      attachments: [
        {
          filename: 'é.txt',
          content: 'é🙂',
          contentType: 'text/plain',
          contentId: 'file@example.com',
        },
        { filename: 'empty', content: new Uint8Array() },
        {
          filename: 'x'.repeat(255),
          content: new Uint8Array([0, 255]),
          contentId: 'a'.repeat(255),
        },
      ],
    };
    for (const call of [() => svc.send(message), () => svc.sendTemplate('file', message, {})]) {
      await call();
      expect(provider.sent.at(-1)!.attachments).toEqual(
        message.attachments.map((a) => ({
          ...a,
          content: typeof a.content === 'string' ? new TextEncoder().encode(a.content) : a.content,
        })),
      );
      expect(provider.sent.at(-1)!.from).toBe('nondefault@x.com');
    }
    expect(message.attachments[0]!.content).toBe('é🙂');
  });
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

    await expect(svc.sendTemplate('welcome', { to: 'u@x.com', subject: 'W' }, {})).rejects.toThrow(
      'Unknown template variable',
    );
    expect(provider.sent).toHaveLength(0);
  });
});

describe('MailService.sendTemplate — component arm (M102)', () => {
  const Body: Component<{ name: string }> = (p) => `<p>${p.name}</p>`;
  const Text: Component<{ name: string }> = (p) => `Hi ${p.name}`;

  it('renders both bodies through the view engine and reaches the provider', async () => {
    const provider = new RecordingProvider();
    const view: IViewEngine = {
      render: <P>(component: Component<P>, props: P) => Promise.resolve(String(component(props))),
    };
    const engine = new TemplateEngine({ welcome: { view: Body, text: Text } }, view);
    const svc = new MailService(provider, engine, { defaultFrom: 'noreply@myapp.com' });

    await svc.sendTemplate('welcome', { to: 'u@x.com', subject: 'Welcome' }, { name: 'Ada' });

    const sent = provider.sent[0];
    expect(sent?.from).toBe('noreply@myapp.com');
    expect(sent?.subject).toBe('Welcome');
    expect(sent?.html).toBe('<p>Ada</p>');
    expect(sent?.text).toBe('Hi Ada');
  });

  it('never reaches the provider when the view engine rejects (short-circuit)', async () => {
    const provider = new RecordingProvider();
    const view: IViewEngine = {
      render: () => Promise.reject(new Error('render failed')),
    };
    const engine = new TemplateEngine({ welcome: { view: Body } }, view);
    const svc = new MailService(provider, engine, { defaultFrom: 'x@x.com' });

    await expect(
      svc.sendTemplate('welcome', { to: 'u@x.com', subject: 'W' }, { name: 'Ada' }),
    ).rejects.toThrow('render failed');
    expect(provider.sent).toHaveLength(0);
  });
});
