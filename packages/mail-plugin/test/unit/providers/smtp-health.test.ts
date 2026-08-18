import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISmtpTransport } from '../../../src/interfaces/index.ts';
import { SmtpProvider } from '../../../src/providers/smtp-provider.ts';

function makeTransport(verify?: () => Promise<unknown>): ISmtpTransport {
  const transport: Record<string, unknown> = {
    sendMail: () => Promise.resolve({ messageId: '1' }),
  };
  if (verify !== undefined) {
    transport.verify = verify;
  }
  return transport as unknown as ISmtpTransport;
}

describe('SmtpProvider health (M70c)', () => {
  it('is reachable when transport.verify() resolves', async () => {
    const provider = new SmtpProvider({ transport: makeTransport(() => Promise.resolve('ok')) });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
  });

  it('is unreachable when transport.verify() rejects', async () => {
    const provider = new SmtpProvider({
      transport: makeTransport(() => Promise.reject(new Error('connection refused'))),
    });
    await provider.connect();
    const probe = provider.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the transport has no verify()', async () => {
    const provider = new SmtpProvider({ transport: makeTransport() });
    await provider.connect();
    // A minimal injected transport has not told us the server is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(provider.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const provider = new SmtpProvider({ transport: makeTransport(() => Promise.resolve('ok')) });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await provider.disconnect();
    expect(provider.isHealthy).toBeUndefined();
  });
});
