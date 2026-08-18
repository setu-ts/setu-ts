import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMailHttp } from '../../../src/interfaces/index.ts';
import { SendGridProvider } from '../../../src/providers/sendgrid-provider.ts';

/** Captures the last request and returns a configurable status. */
function fakeHttp(
  status: number,
  opts: { fail?: boolean } = {},
): { http: IMailHttp; lastUrl: { value: string } } {
  const lastUrl = { value: '' };
  const http: IMailHttp = (url, init) => {
    lastUrl.value = url;
    if (opts.fail) {
      return Promise.reject(new Error('network down'));
    }
    void init;
    return Promise.resolve(new Response(null, { status }));
  };
  return { http, lastUrl };
}

const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

describe('SendGridProvider health (M70c)', () => {
  it('is reachable on 2xx and probes /v3/scopes', async () => {
    const { http, lastUrl } = fakeHttp(200);
    const provider = new SendGridProvider({ apiKey: 'key', endpoint: ENDPOINT, http });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
    expect(lastUrl.value).toBe('https://api.sendgrid.com/v3/scopes');
  });

  it('treats 401 as reachable (the API answered; the key is just wrong)', async () => {
    const { http } = fakeHttp(401);
    const provider = new SendGridProvider({ apiKey: 'bad-key', endpoint: ENDPOINT, http });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(true);
  });

  it('is unreachable on other statuses', async () => {
    const { http } = fakeHttp(503);
    const provider = new SendGridProvider({ apiKey: 'key', endpoint: ENDPOINT, http });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(false);
  });

  it('is unreachable on a network failure', async () => {
    const { http } = fakeHttp(200, { fail: true });
    const provider = new SendGridProvider({ apiKey: 'key', endpoint: ENDPOINT, http });
    await provider.connect();
    expect(await provider.isHealthy()).toBe(false);
  });
});
