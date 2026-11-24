import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ISmtpTransport } from '../../src/interfaces/index.ts';
import type { SmtpRuntime } from '../../src/providers/smtp-provider.ts';
import {
  isPreCommandFailure,
  SMTP_MAX_ADDRESS_TRIES,
  SmtpProvider,
} from '../../src/providers/smtp-provider.ts';
import { SesProvider } from '../../src/providers/ses-provider.ts';

const fake = vi.hoisted(() => ({
  created: [] as { host: unknown; transport: ISmtpTransport; closed: boolean }[],
  onCreate: undefined as (() => void) | undefined,
  send: undefined as (() => Promise<unknown>) | undefined,
  sendTo: undefined as ((host: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('nodemailer', () => ({
  createTransport(config: Record<string, unknown>) {
    const entry = { host: config.host, closed: false, transport: {} as ISmtpTransport };
    entry.transport = {
      sendMail: () => fake.sendTo?.(config.host) ?? fake.send?.() ?? Promise.resolve({}),
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
const runtime = (
  resolveHost: () => Promise<string[]>,
  clock: () => number,
  random?: () => number,
): SmtpRuntime => ({
  hrtime: clock,
  ...(random === undefined ? {} : { random }),
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
  fake.sendTo = undefined;
});

describe('injected SES health is bounded', () => {
  it('a hung probe returns false before 200 ms', async () => {
    const isHealthy = vi.fn(() => new Promise<boolean>(() => {}));
    const client = { sendEmail: () => Promise.resolve(), isHealthy };
    const provider = new SesProvider({ client, requestTimeoutMs: 25 });
    await provider.connect();
    const started = performance.now();
    const result = await Promise.race([
      provider.isHealthy!(),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 180)),
    ]);
    expect(result).toBe(false);
    expect(performance.now() - started).toBeLessThan(200);
    // Asserted here, not inside the probe: a throw there would read as `false`.
    expect(isHealthy.mock.contexts[0]).toBe(client);
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
  it('a lookup past its deadline is not repeated while it still runs', async () => {
    let attempts = 0;
    const lookup = vi.fn(() =>
      ++attempts === 1 ? Promise.resolve(['10.0.0.1']) : new Promise<string[]>(() => {}),
    );
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 0, connectionTimeoutMs: 25 },
      runtime(lookup, () => 0),
    );
    await provider.connect();
    await provider.send(mail);
    await provider.send(mail);
    await provider.send(mail);
    // The connect lookup, then one that hangs: the later sends reuse the
    // transport instead of starting a lookup beside the one still running.
    expect(lookup).toHaveBeenCalledTimes(2);
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
  it('a disconnect while a send picks its transport stops that send', async () => {
    let sends = 0;
    fake.send = () => {
      sends += 1;
      return Promise.resolve({});
    };
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1']),
        () => 0,
      ),
    );
    await provider.connect();
    const sending = provider.send(mail);
    void provider.disconnect();
    await expect(sending).rejects.toThrow(/not connected/);
    await tick();
    expect(sends).toBe(0);
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

describe('SMTP transport ownership', () => {
  it('disconnect leaves a transport the application passed in open', async () => {
    const close = vi.fn();
    const provider = new SmtpProvider({
      transport: { sendMail: () => Promise.resolve({}), close },
    });
    await provider.connect();
    await provider.disconnect();
    await tick();
    expect(close).not.toHaveBeenCalled();
  });
  it('disconnect closes a transport the provider built', async () => {
    const provider = new SmtpProvider({ host: '127.0.0.1' });
    await provider.connect();
    await provider.disconnect();
    await tick();
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]!.closed).toBe(true);
  });
});

// The shapes nodemailer 10.6.0 rejects with, measured against local servers:
// only the first three prove no SMTP command reached the server.
const FAILURE_PHASES: readonly { name: string; error: object; retried: boolean }[] = [
  {
    name: 'connect refused',
    error: { code: 'ESOCKET', command: 'CONN', syscall: 'connect' },
    retried: true,
  },
  {
    name: 'connection timeout',
    error: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'CONNECT_TIMEOUT' },
    retried: true,
  },
  {
    name: 'no greeting',
    error: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'GREETING_TIMEOUT' },
    retried: true,
  },
  { name: 'dropped in any phase', error: { code: 'ECONNECTION', command: 'CONN' }, retried: false },
  {
    name: 'stalled in any phase',
    error: { code: 'ETIMEDOUT', command: 'CONN', timeoutType: 'SOCKET_TIMEOUT' },
    retried: false,
  },
  {
    name: 'reset after connecting',
    error: { code: 'ESOCKET', command: 'CONN', syscall: 'read' },
    retried: false,
  },
  { name: 'refused envelope', error: { code: 'EENVELOPE', command: 'MAIL FROM' }, retried: false },
];

const addressFailure = (host: unknown, shape: object): Error =>
  Object.assign(new Error(`failed on ${String(host)}`), shape);

describe('SMTP failover across resolved addresses', () => {
  for (const phase of FAILURE_PHASES) {
    it(`${phase.name}: ${phase.retried ? 'retried' : 'not retried'} on the next address`, async () => {
      fake.sendTo = (host) =>
        host === '10.0.0.1'
          ? Promise.reject(addressFailure(host, phase.error))
          : Promise.resolve({});
      const provider = new SmtpProvider(
        { host: 'smtp.test', dnsTtlMs: 60_000 },
        runtime(
          () => Promise.resolve(['10.0.0.1', '10.0.0.2']),
          () => 0,
          () => 0,
        ),
      );
      await provider.connect();
      expect(isPreCommandFailure(Object.assign(new Error('x'), phase.error))).toBe(phase.retried);
      if (phase.retried) {
        await provider.send(mail);
        expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.1', '10.0.0.2']);
        expect(fake.created[0]!.closed).toBe(true);
      } else {
        await expect(provider.send(mail)).rejects.toThrow('failed on 10.0.0.1');
        expect(fake.created).toHaveLength(1);
      }
      await provider.disconnect();
    });
  }
  it('rejects with the last error when every address refuses', async () => {
    fake.sendTo = (host) => Promise.reject(addressFailure(host, FAILURE_PHASES[0]!.error));
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1', '10.0.0.2', '10.0.0.3']),
        () => 0,
        () => 0,
      ),
    );
    await provider.connect();
    await expect(provider.send(mail)).rejects.toThrow('failed on 10.0.0.3');
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3']);
    await provider.disconnect();
  });
  it(`tries at most ${SMTP_MAX_ADDRESS_TRIES} addresses for one send`, async () => {
    fake.sendTo = (host) => Promise.reject(addressFailure(host, FAILURE_PHASES[0]!.error));
    const addresses = ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4', '10.0.0.5', '10.0.0.6'];
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(addresses),
        () => 0,
        () => 0,
      ),
    );
    await provider.connect();
    await expect(provider.send(mail)).rejects.toThrow(
      `failed on ${addresses[SMTP_MAX_ADDRESS_TRIES - 1]}`,
    );
    expect(fake.created).toHaveLength(SMTP_MAX_ADDRESS_TRIES);
    await provider.disconnect();
  });
  it('starts on a random address and keeps it while the answer lists it', async () => {
    let clock = 0;
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 1000 },
      runtime(
        () => Promise.resolve(['10.0.0.1', '10.0.0.2', '10.0.0.3']),
        () => clock,
        () => 0.5,
      ),
    );
    await provider.connect();
    clock = 5000;
    await provider.send(mail);
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.2']);
    await provider.disconnect();
  });
  it('a single address is not retried', async () => {
    fake.sendTo = (host) => Promise.reject(addressFailure(host, FAILURE_PHASES[0]!.error));
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1']),
        () => 0,
      ),
    );
    await provider.connect();
    await expect(provider.send(mail)).rejects.toThrow('failed on 10.0.0.1');
    expect(fake.created).toHaveLength(1);
    await provider.disconnect();
  });
  it('a send that fails on an address another send already left retries on the current one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstOnA = true;
    fake.sendTo = async (host) => {
      if (host === '10.0.0.1') {
        if (firstOnA) {
          firstOnA = false;
          await held;
        }
        throw addressFailure(host, FAILURE_PHASES[0]!.error);
      }
      return {};
    };
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1', '10.0.0.2']),
        () => 0,
        () => 0,
      ),
    );
    await provider.connect();
    const slow = provider.send(mail);
    await tick();
    await provider.send(mail);
    release();
    await slow;
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.1', '10.0.0.2']);
    await provider.disconnect();
  });
  it('two sends failing over together never try an address twice each', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    let heldOnce = false;
    fake.sendTo = async (host) => {
      calls.push(String(host));
      if (host === '10.0.0.1' && !heldOnce) {
        heldOnce = true;
        await held;
      }
      if (host === '10.0.0.3') return {};
      throw addressFailure(host, FAILURE_PHASES[0]!.error);
    };
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1', '10.0.0.2', '10.0.0.3']),
        () => 0,
        () => 0,
      ),
    );
    await provider.connect();
    const first = provider.send(mail);
    await tick();
    await provider.send(mail);
    release();
    await first;
    // The second send went A, B, C; the first, released on A, went to C, the
    // address in use that it had not tried, instead of back to A or B.
    expect(calls).toEqual(['10.0.0.1', '10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.3']);
    await provider.disconnect();
  });
  it('a random value outside [0, 1) starts on the first address', async () => {
    const provider = new SmtpProvider(
      { host: 'smtp.test', dnsTtlMs: 60_000 },
      runtime(
        () => Promise.resolve(['10.0.0.1', '10.0.0.2']),
        () => 0,
        () => Number.NaN,
      ),
    );
    await provider.connect();
    await provider.send(mail);
    expect(fake.created.map((entry) => entry.host)).toEqual(['10.0.0.1']);
    await provider.disconnect();
  });
});
