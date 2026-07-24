import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { SendGridProvider, toSendGridBody } from '../../src/providers/sendgrid-provider.ts';
import type { IMailHttp, OutgoingMail } from '../../src/interfaces/index.ts';

/** Captures the last request and returns a configurable status. */
function fakeHttp(status = 202): {
  http: IMailHttp;
  calls: Array<{ url: string; init?: RequestInit | undefined }>;
} {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const http: IMailHttp = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status }));
  };
  return { http, calls };
}

describe('toSendGridBody', () => {
  it('maps recipients, sender, subject, and both content types', () => {
    const message: OutgoingMail = {
      from: 'me@x.com',
      to: ['a@x.com', 'b@x.com'],
      cc: ['c@x.com'],
      bcc: ['d@x.com'],
      subject: 'Hi',
      text: 'plain',
      html: '<b>rich</b>',
    };
    const body = toSendGridBody(message) as Record<string, unknown>;
    const p = (body.personalizations as Array<Record<string, unknown>>)[0];
    expect(p?.to).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
    expect(p?.cc).toEqual([{ email: 'c@x.com' }]);
    expect(p?.bcc).toEqual([{ email: 'd@x.com' }]);
    expect(body.from).toEqual({ email: 'me@x.com' });
    expect(body.subject).toBe('Hi');
    expect(body.content).toEqual([
      { type: 'text/plain', value: 'plain' },
      { type: 'text/html', value: '<b>rich</b>' },
    ]);
  });

  it('handles a single string recipient and omits absent bodies', () => {
    const body = toSendGridBody({ from: 'me@x.com', to: 'solo@x.com', subject: 'S' });
    const p = (body.personalizations as Array<Record<string, unknown>>)[0];
    expect(p?.to).toEqual([{ email: 'solo@x.com' }]);
    expect(body.content).toEqual([]);
  });
});

describe('SendGridProvider', () => {
  it('requires an api key on connect', async () => {
    await expect(new SendGridProvider().connect()).rejects.toThrow('requires options.apiKey');
  });

  it('POSTs to the endpoint with a Bearer header and reports readiness', async () => {
    const { http, calls } = fakeHttp(202);
    const provider = new SendGridProvider({ apiKey: 'SG.key', http });

    expect(provider.isReady()).toBe(false);
    await provider.connect();
    expect(provider.isReady()).toBe(true);

    await provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi', text: 'yo' });

    expect(calls[0]?.url).toBe('https://api.sendgrid.com/v3/mail/send');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer SG.key');

    await provider.disconnect();
    expect(provider.isReady()).toBe(false);
  });

  it('uses a custom endpoint and throws on a non-2xx response', async () => {
    const { http, calls } = fakeHttp(401);
    const provider = new SendGridProvider({
      apiKey: 'k',
      endpoint: 'https://eu.sendgrid.example/send',
      http,
    });
    await provider.connect();
    await expect(
      provider.send({ from: 'me@x.com', to: 'a@x.com', subject: 'Hi' }),
    ).rejects.toThrow('SendGrid send failed: HTTP 401');
    expect(calls[0]?.url).toBe('https://eu.sendgrid.example/send');
  });
});
