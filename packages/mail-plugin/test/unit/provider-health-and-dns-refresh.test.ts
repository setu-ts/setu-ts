import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISmtpTransport } from '../../src/interfaces/index.ts';
import type { SmtpRuntime } from '../../src/providers/smtp-provider.ts';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';
import { SesProvider } from '../../src/providers/ses-provider.ts';

const fake = vi.hoisted(() => ({
  created: [] as { host: unknown; transport: ISmtpTransport; closed: boolean }[],
  onCreate: undefined as (() => void) | undefined,
  send: undefined as (() => Promise<unknown>) | undefined,
}));
vi.mock('nodemailer', () => ({
  createTransport(config: Record<string, unknown>) {
    const entry = { host: config.host, closed: false, transport: {} as ISmtpTransport };
    entry.transport = {
      sendMail: () => fake.send?.() ?? Promise.resolve({}),
      verify: () => Promise.resolve(true),
      close: () => {
        entry.closed = true;
      },
    };
    fake.created.push(entry);
    fake.onCreate?.();
    return entry.transport;
  },
}));

const mail = { from: 'a@test', to: 'b@test', subject: 's', text: 'body' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const runtime = (resolveHost: () => Promise<string[]>, clock: () => number): SmtpRuntime => ({
  hrtime: clock,
  dns: { resolveHost, resolveSrv: () => Promise.resolve([]) },
  timing: {
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
});

beforeEach(() => {
  fake.created.length = 0;
  fake.onCreate = undefined;
  fake.send = undefined;
});

describe('injected SES health is bounded', () => {
  it('a hung probe returns false before 200 ms', async () => {
    const client = {
      sendEmail: () => Promise.resolve(),
      isHealthy() {
        expect(this).toBe(client);
        return new Promise<boolean>(() => {});
      },
    };
    const provider = new SesProvider({ client, requestTimeoutMs: 25 });
    await provider.connect();
    const started = performance.now();
    const result = await Promise.race([
      provider.isHealthy!(),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 180)),
    ]);
    expect(result).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    await provider.disconnect();
  });
  it('keeps false probe results', async () => {
    const provider = new SesProvider({
      client: { sendEmail: () => Promise.resolve(), isHealthy: () => Promise.resolve(false) },
    });
    await provider.connect();
    expect(await provider.isHealthy!()).toBe(false);
    await provider.disconnect();
  });
});

describe('SMTP DNS refresh coordination', () => {
  for (const failure of ['reject', 'empty'] as const) {
    it(`a ${failure} lookup is attempted once within TTL`, async () => {
      let clock = 0;
      let fail = false;
      const lookup = vi.fn(() =>
        !fail
          ? Promise.resolve(['10.0.0.1'])
          : failure === 'empty'
            ? Promise.resolve([])
            : Promise.reject(new Error('DNS down')),
      );
      const provider = new SmtpProvider(
        { host: 'smtp.test', dnsTtlMs: 1000 },
        runtime(lookup, () => clock),
      );
      await provider.connect();
      fail = true;
      clock = 2000;
      for (let i = 0; i < 5; i++) {
        clock++;
        await provider.send(mail);
      }
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(fake.created).toHaveLength(1);
      expect(fake.created[0]!.closed).toBe(false);
      clock = 4000;
      await provider.send(mail);
      expect(lookup).toHaveBeenCalledTimes(3);
      await provider.disconnect();
    });
  }
  it('TTL zero retries failed lookups on each send', async () => {
    let attempts = 0;
    const lookup = vi.fn(() =>
      ++attempts === 1 ? Promise.resolve(['10.0.0.1']) : Promise.reject(new Error('DNS down')),
    );
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 0 },
      runtime(lookup, () => 0),
    );
    await provider.connect();
    await provider.send(mail);
    await provider.send(mail);
    expect(lookup).toHaveBeenCalledTimes(3);
    await provider.disconnect();
  });
  it('a hung refresh is bounded by connectionTimeoutMs and keeps the last transport', async () => {
    let clock = 0;
    const lookup = vi.fn(() =>
      clock === 0 ? Promise.resolve(['10.0.0.1']) : new Promise<string[]>(() => {}),
    );
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000, connectionTimeoutMs: 25 },
      runtime(lookup, () => clock),
    );
    await provider.connect();
    clock = 2000;
    const started = performance.now();
    const result = await Promise.race([
      provider.send(mail).then(() => 'sent'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 180)),
    ]);
    expect(result).toBe('sent');
    expect(performance.now() - started).toBeLessThan(200);
    expect(fake.created).toHaveLength(1);
    await provider.disconnect();
  });
  it('a hung first lookup ends within connectionTimeoutMs and lets nodemailer resolve the host', async () => {
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000, connectionTimeoutMs: 25 },
      runtime(
        () => new Promise(() => {}),
        () => 0,
      ),
    );
    const result = await Promise.race([
      provider.connect().then(() => 'connected'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 180)),
    ]);
    expect(result).toBe('connected');
    expect(provider.isReady()).toBe(true);
    expect(fake.created.map((entry) => entry.host)).toEqual(['smtp.test']);
    await provider.disconnect();
  });
  it('a disconnect immediately after lookup resolution rejects connect and closes the new transport', async () => {
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(
        () => Promise.resolve(['10.0.0.1']),
        () => 0,
      ),
    );
    fake.onCreate = () => {
      queueMicrotask(() => {
        void provider.disconnect();
      });
    };
    await expect(provider.connect()).rejects.toThrow(/not connected/);
    expect(provider.isReady()).toBe(false);
    expect(fake.created[0]!.closed).toBe(true);
  });
  it('two concurrent sends past TTL share one lookup and keep its newest address', async () => {
    let clock = 0;
    let release: (value: string[]) => void = () => {};
    const lookup = vi.fn(() =>
      clock === 0
        ? Promise.resolve(['10.0.0.1'])
        : new Promise<string[]>((resolve) => {
            release = resolve;
          }),
    );
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(lookup, () => clock),
    );
    await provider.connect();
    clock = 2000;
    const a = provider.send(mail);
    await tick();
    const b = provider.send(mail);
    await tick();
    expect(lookup).toHaveBeenCalledTimes(2);
    release(['10.0.0.2']);
    await Promise.all([a, b]);
    await provider.send(mail);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(fake.created[1]!.closed).toBe(false);
    await provider.disconnect();
  });
  it('a first empty lookup rejects without creating a transport', async () => {
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(
        () => Promise.resolve([]),
        () => 0,
      ),
    );
    await expect(provider.connect()).rejects.toThrow('resolved to no address');
    expect(provider.isReady()).toBe(false);
    expect(fake.created).toHaveLength(0);
  });
  it('a stale generation cannot replace or close a newer transport', async () => {
    let calls = 0;
    let release: (value: string[]) => void = () => {};
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(
        () =>
          ++calls === 1
            ? new Promise((resolve) => {
                release = resolve;
              })
            : Promise.resolve(['10.0.0.2']),
        () => 0,
      ),
    );
    const first = provider.connect();
    const rejected = expect(first).rejects.toThrow(/not connected/);
    await tick();
    await provider.disconnect();
    await provider.connect();
    release(['10.0.0.1']);
    await rejected;
    await provider.send(mail);
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.2']);
    expect(fake.created[0]!.closed).toBe(false);
    await provider.disconnect();
  });
  it('a refresh retires the old transport after all of its active sends settle', async () => {
    let clock = 0;
    let finish: () => void = () => {};
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(
        () => Promise.resolve([clock === 0 ? '10.0.0.1' : '10.0.0.2']),
        () => clock,
      ),
    );
    await provider.connect();
    const sending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    fake.send = () => sending;
    const a = provider.send(mail);
    const b = provider.send(mail);
    await tick();
    clock = 2000;
    fake.send = undefined;
    await provider.send(mail);
    expect(fake.created[0]!.closed).toBe(false);
    finish();
    await Promise.all([a, b]);
    expect(fake.created[0]!.closed).toBe(true);
    await provider.disconnect();
  });
});
