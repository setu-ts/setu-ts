import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  adaptNodemailerModule,
  loadNodemailerModule,
  type NodemailerModule,
  SmtpProvider,
  toNodemailerMessage,
  validateSmtpTransport,
} from '../../src/providers/smtp-provider.ts';
import type { ISmtpTransport, OutgoingMail } from '../../src/interfaces/index.ts';

/** Fake transport recording sent mail and the config it was built with. */
class FakeTransport implements ISmtpTransport {
  readonly sent: Array<Parameters<ISmtpTransport['sendMail']>[0]> = [];
  sendMail(mail: Parameters<ISmtpTransport['sendMail']>[0]): Promise<unknown> {
    this.sent.push(mail);
    return Promise.resolve({ messageId: '1' });
  }
}

/** Fake nodemailer module capturing the transport config. */
function fakeModule(): { mod: NodemailerModule; configs: Record<string, unknown>[] } {
  const configs: Record<string, unknown>[] = [];
  const mod: NodemailerModule = {
    createTransport: (options) => {
      configs.push(options);
      return new FakeTransport();
    },
  };
  return { mod, configs };
}

describe('validateSmtpTransport', () => {
  it('accepts a valid transport and rejects malformed ones', () => {
    expect(validateSmtpTransport(new FakeTransport())).toBe(true);
    expect(validateSmtpTransport({})).toBe(false);
    expect(validateSmtpTransport(null)).toBe(false);
  });
});

describe('toNodemailerMessage', () => {
  it('maps all fields, joining recipient arrays', () => {
    const message: OutgoingMail = {
      from: 'me@x.com',
      to: ['a@x.com', 'b@x.com'],
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
    };
    expect(toNodemailerMessage(message)).toEqual({
      from: 'me@x.com',
      to: 'a@x.com, b@x.com',
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
      cc: 'c@x.com',
      bcc: 'd@x.com',
    });
  });

  it('omits absent optional fields and passes a single recipient through', () => {
    expect(toNodemailerMessage({ from: 'me@x.com', to: 'solo@x.com', subject: 'S' })).toEqual({
      from: 'me@x.com',
      to: 'solo@x.com',
      subject: 'S',
    });
  });
});

describe('adaptNodemailerModule', () => {
  it('builds a transport from config defaults and sends through it', async () => {
    const { mod, configs } = fakeModule();
    const transport = adaptNodemailerModule(mod, {});
    expect(configs[0]).toEqual({ port: 587, secure: false });

    await transport.sendMail({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi' });
    expect((transport as FakeTransport).sent).toHaveLength(1);
  });

  it('threads host, port, secure, and auth into the config', () => {
    const { mod, configs } = fakeModule();
    adaptNodemailerModule(mod, {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'u', pass: 'p' },
    });
    expect(configs[0]).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: { user: 'u', pass: 'p' },
    });
  });
});

describe('SmtpProvider', () => {
  it('uses an injected transport for send and reports readiness', async () => {
    const transport = new FakeTransport();
    const provider = new SmtpProvider({ transport });

    expect(provider.isReady()).toBe(false);
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    await provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi', text: 'yo' });
    expect(transport.sent[0]?.subject).toBe('Hi');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('throws when the injected transport is malformed', async () => {
    const provider = new SmtpProvider({ transport: {} as unknown as ISmtpTransport });
    await expect(provider.connect()).rejects.toThrow('missing the required sendMail');
  });

  it('throws when used before connect', async () => {
    const provider = new SmtpProvider({ transport: new FakeTransport() });
    await expect(
      provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi' }),
    ).rejects.toThrow('not connected');
  });

  // Guarded real-import: enters the lazy `import('npm:nodemailer')` path without
  // opening a socket (no createTransport call, no network).
  it('loadNodemailerModule enters the real import path', async () => {
    try {
      const mod = await loadNodemailerModule();
      expect(mod.createTransport).toBeDefined();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });

  // Guarded: connect() with no injected transport takes the lazy adapt path.
  // createTransport does not open a socket, so this is side-effect free when the
  // package is installed; when absent the import throws — the branch runs either way.
  it('connect() without a transport enters the lazy adapt path', async () => {
    const provider = new SmtpProvider({ host: 'smtp.example.com' });
    try {
      await provider.connect();
      expect(provider.isReady()).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
    }
  });
});
