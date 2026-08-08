import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { IMailer } from '@setu-ts/common';

import { createProvider, MailPlugin } from '../../src/plugin/mail-plugin.ts';
import { LogProvider } from '../../src/providers/log-provider.ts';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';
import { SesProvider } from '../../src/providers/ses-provider.ts';
import { SendGridProvider } from '../../src/providers/sendgrid-provider.ts';
import type { MailProviderType, OutgoingMail } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import manifest from '../../deno.json' with { type: 'json' };

describe('MailPlugin metadata', () => {
  it('exposes the expected plugin contract fields', () => {
    const plugin = MailPlugin();
    expect(plugin.name).toBe('mail-plugin');
    expect(plugin.version).toBe(manifest.version);
    expect(plugin.provides).toContain(CAPABILITIES.MAIL);
    expect(plugin.optionalDependencies).toEqual(['logger']);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

describe('createProvider', () => {
  it('builds the matching provider for each id', () => {
    const { ctx } = createFakeContext();
    expect(createProvider('log', {}, ctx)).toBeInstanceOf(LogProvider);
    expect(createProvider('smtp', {}, ctx)).toBeInstanceOf(SmtpProvider);
    expect(createProvider('ses', {}, ctx)).toBeInstanceOf(SesProvider);
    expect(createProvider('sendgrid', {}, ctx)).toBeInstanceOf(SendGridProvider);
  });

  it('throws for an unsupported provider type', () => {
    const { ctx } = createFakeContext();
    expect(() => createProvider('smsx' as MailProviderType, {}, ctx)).toThrow(
      'Unsupported mail provider: smsx',
    );
  });
});

describe('MailPlugin.register', () => {
  it('registers IMailer, a healthy indicator, an onClose, and logs (with logger)', async () => {
    const sunk: OutgoingMail[] = [];
    const fake = createFakeContext(true);
    const plugin = MailPlugin({
      provider: 'log',
      defaults: { from: 'noreply@x.com' },
      options: { sink: (m) => sunk.push(m) },
    });

    await plugin.register(fake.ctx);

    // Capability resolves to a working mailer.
    const mailer = fake.registered.get(CAPABILITIES.MAIL) as IMailer;
    await mailer.send({ to: 'u@x.com', subject: 'Hi', text: 'yo' });
    expect(sunk[0]?.from).toBe('noreply@x.com');

    // Health indicator reports up (provider connected during register).
    const health = await fake.healthIndicators.get(CAPABILITIES.MAIL)?.();
    expect(health?.status).toBe('up');
    expect(health?.data).toEqual({ provider: 'log' });

    // The debug log was emitted.
    expect(fake.logs.some((l) => l.message === 'MailPlugin registered')).toBe(true);

    // onClose disconnects the provider (health then reports down).
    await Promise.all(fake.onCloseHandlers.map((h) => h()));
    const after = await fake.healthIndicators.get(CAPABILITIES.MAIL)?.();
    expect(after?.status).toBe('down');
  });

  it('registers without a logger present', async () => {
    const fake = createFakeContext(false);
    await MailPlugin({ provider: 'log' }).register(fake.ctx);
    expect(fake.registered.has(CAPABILITIES.MAIL)).toBe(true);
    expect(fake.logs).toHaveLength(0);
  });
});
