/**
 * SMTP inline attachments (V13-4), SMTP timeouts and DNS re-resolution
 * (V13-119), the SES endpoint (V13-228), SES readiness (V13-215) and the SES
 * and SendGrid bound (V13-216).
 *
 * @module
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import type { ISmtpTransport } from '../../src/interfaces/index.ts';
import {
  buildTransportConfig,
  SmtpProvider,
  toNodemailerMessage,
} from '../../src/providers/smtp-provider.ts';
import { SesProvider } from '../../src/providers/ses-provider.ts';
import { SendGridProvider, sendGridReason } from '../../src/providers/sendgrid-provider.ts';
import { toMailError, MailDeadlineError } from '../../src/providers/bounded-send.ts';

const mail = { from: 'a@x.test', to: 'b@x.test', subject: 'Hi', text: 'Body' };

describe('SMTP inline attachments on the wire (V13-4)', () => {
  it('a contentId attachment is Content-Disposition: inline, others attachment', async () => {
    const nodemailer = (await import('nodemailer')) as unknown as {
      createTransport(o: unknown): { sendMail(m: unknown): Promise<{ message: Buffer }> };
    };
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const raw = (
      await transport.sendMail(
        toNodemailerMessage({
          ...mail,
          html: '<img src="cid:logo">',
          attachments: [
            {
              filename: 'logo.txt',
              content: new TextEncoder().encode('LOGO'),
              contentType: 'text/plain',
              contentId: 'logo',
            },
            { filename: 'terms.txt', content: new TextEncoder().encode('T') },
          ],
        }),
      )
    ).message.toString();
    const dispositions = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('Content-Disposition'));
    expect(dispositions).toEqual([
      'Content-Disposition: inline; filename=logo.txt',
      'Content-Disposition: attachment; filename=terms.txt',
    ]);
  });
});

describe('SMTP timeouts (V13-119)', () => {
  it('passes each timeout to nodemailer only when set', () => {
    expect(buildTransportConfig({ host: 'smtp.x.test' })).toEqual({
      port: 587,
      secure: false,
      host: 'smtp.x.test',
    });
    expect(
      buildTransportConfig({
        host: 'smtp.x.test',
        connectionTimeoutMs: 1000,
        greetingTimeoutMs: 2000,
        socketTimeoutMs: 3000,
      }),
    ).toMatchObject({ connectionTimeout: 1000, greetingTimeout: 2000, socketTimeout: 3000 });
  });

  it('with an address, connects there and keeps the host as the TLS server name', () => {
    expect(buildTransportConfig({ host: 'smtp.x.test', secure: true }, '10.0.0.9')).toEqual({
      port: 587,
      secure: true,
      host: '10.0.0.9',
      tls: { servername: 'smtp.x.test' },
    });
  });
});

/** A minimal SMTP server that records the messages it accepts. */
async function smtpServer(
  host: string,
  port: number,
): Promise<{ server: NetServer; port: number; received: string[] }> {
  const received: string[] = [];
  const server = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    let inData = false;
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(host);
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 test\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return { server, port: (server.address() as { port: number }).port, received };
}

describe('SMTP dnsTtlMs on real nodemailer (V13-119)', () => {
  it('re-resolves after the TTL and moves to the new address', async () => {
    const first = await smtpServer('127.0.0.1', 0);
    const second = await smtpServer('127.0.0.2', first.port);
    let clock = 0;
    let answer = ['127.0.0.1'];
    let lookups = 0;
    const provider = new SmtpProvider(
      { host: 'smtp.x.test', port: first.port, dnsTtlMs: 1000 },
      {
        dns: {
          resolveHost: () => {
            lookups++;
            return Promise.resolve(answer);
          },
          resolveSrv: () => Promise.resolve([]),
        },
        hrtime: () => clock,
      },
    );
    try {
      await provider.connect();
      await provider.send(mail);
      expect(first.received).toHaveLength(1);
      expect(lookups).toBe(1);
      clock = 500;
      answer = ['127.0.0.2'];
      await provider.send(mail);
      // Inside the TTL: still the first address, no new lookup.
      expect(first.received).toHaveLength(2);
      expect(lookups).toBe(1);
      clock = 1500;
      await provider.send(mail);
      expect(second.received).toHaveLength(1);
      expect(lookups).toBe(2);
      clock = 3000;
      await provider.send(mail);
      // Same answer after the TTL: looked up again, transport kept.
      expect(second.received).toHaveLength(2);
      expect(lookups).toBe(3);
      expect(await provider.isHealthy!()).toBe(true);
      answer = [];
      clock = 5000;
      await expect(provider.send(mail)).rejects.toThrow(/resolved to no address/);
      await provider.disconnect();
      await expect(provider.send(mail)).rejects.toThrow(/not connected/);
    } finally {
      first.server.close();
      second.server.close();
    }
  }, 20_000);

  it('is refused with an injected transport, without runtime DNS, and when out of range', () => {
    const transport: ISmtpTransport = { sendMail: () => Promise.resolve({}) };
    const runtime = {
      dns: { resolveHost: () => Promise.resolve([]), resolveSrv: () => Promise.resolve([]) },
      hrtime: () => 0,
    };
    expect(() => new SmtpProvider({ host: 'h', dnsTtlMs: 1, transport }, runtime)).toThrow(
      /cannot apply to an injected transport/,
    );
    expect(() => new SmtpProvider({ host: 'h', dnsTtlMs: 1 }, { hrtime: () => 0 })).toThrow(
      /needs a runtime with DNS/,
    );
    expect(() => new SmtpProvider({ host: 'h', dnsTtlMs: -1 }, runtime)).toThrow(RangeError);
  });

  it('an IP-literal host is left to nodemailer', async () => {
    const server = await smtpServer('127.0.0.1', 0);
    const provider = new SmtpProvider(
      { host: '127.0.0.1', port: server.port, dnsTtlMs: 1000 },
      {
        dns: {
          resolveHost: () => Promise.reject(new Error('must not resolve')),
          resolveSrv: () => Promise.resolve([]),
        },
        hrtime: () => 0,
      },
    );
    try {
      await provider.connect();
      await provider.send(mail);
      expect(server.received).toEqual(['127.0.0.1']);
    } finally {
      server.server.close();
    }
  }, 20_000);
});

describe('toMailError', () => {
  it('an expired bound is a 504, a refused connection a 503, anything else unchanged', () => {
    expect(toMailError(new MailDeadlineError('late'), 'ses')).toBeInstanceOf(
      BackendOutcomeUnknownError,
    );
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(toMailError(refused, 'sendgrid')).toBeInstanceOf(BackendUnavailableError);
    const other = new Error('MessageRejected');
    expect(toMailError(other, 'ses')).toBe(other);
    expect(toMailError('odd', 'ses').message).toBe('odd');
  });
});

let capture: HttpServer;
let capturePort = 0;
const requests: { method: string; url: string; body: string }[] = [];
let accountStatus = 200;
let blackHole: NetServer;
let blackHolePort = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  capture = createHttpServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.url?.startsWith('/v2/email/account') === true) {
        res.writeHead(accountStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ SendingEnabled: true }));
        return;
      }
      if (req.url === '/v3/mail/send') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ errors: [{ message: 'The provided authorization grant is invalid' }] }),
        );
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ MessageId: 'm-1' }));
    });
  });
  await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve));
  capturePort = (capture.address() as { port: number }).port;
  blackHole = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
  blackHolePort = (blackHole.address() as { port: number }).port;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => capture.close(() => resolve()));
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
});

const sesOptions = (endpoint: string, requestTimeoutMs?: number) => ({
  region: 'us-east-1',
  accessKeyId: 'k',
  secretAccessKey: 's',
  endpoint,
  ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
});

describe('SES on the real SDK against a capture server', () => {
  it('sends to the configured endpoint (V13-228)', async () => {
    const provider = new SesProvider(sesOptions(`http://127.0.0.1:${capturePort}`));
    await provider.connect();
    await provider.send(mail);
    const sent = requests.find((r) => r.url === '/v2/email/outbound-emails');
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(sent!.body)).toMatchObject({ FromEmailAddress: 'a@x.test' });
  });

  it('probes with GetAccount: an answer is reachable, a 5xx or a hang is not (V13-215)', async () => {
    const provider = new SesProvider(sesOptions(`http://127.0.0.1:${capturePort}`, 1000));
    await provider.connect();
    accountStatus = 200;
    expect(await provider.isHealthy!()).toBe(true);
    expect(requests.some((r) => r.method === 'GET' && r.url.startsWith('/v2/email/account'))).toBe(
      true,
    );
    accountStatus = 403;
    expect(await provider.isHealthy!()).toBe(true);
    accountStatus = 503;
    expect(await provider.isHealthy!()).toBe(false);
    const hung = new SesProvider(sesOptions(`http://127.0.0.1:${blackHolePort}`, 300));
    await hung.connect();
    expect(await hung.isHealthy!()).toBe(false);
  });

  it('a hung endpoint is a 504 within the bound (V13-216)', async () => {
    const provider = new SesProvider(sesOptions(`http://127.0.0.1:${blackHolePort}`, 300));
    await provider.connect();
    const started = performance.now();
    await expect(provider.send(mail)).rejects.toBeInstanceOf(BackendOutcomeUnknownError);
    expect(performance.now() - started).toBeLessThan(6000);
  });

  it('an injected client is bounded too, and refuses an out-of-range bound', async () => {
    const provider = new SesProvider({
      requestTimeoutMs: 50,
      client: { sendEmail: () => new Promise<void>(() => undefined) },
    });
    await provider.connect();
    await expect(provider.send(mail)).rejects.toBeInstanceOf(BackendOutcomeUnknownError);
    expect(provider.isHealthy).toBeUndefined();
    expect(() => new SesProvider({ requestTimeoutMs: -1 })).toThrow(RangeError);
  });
});

describe('SendGrid bound and reason (V13-216, V13-217)', () => {
  it('a hung API is a 504 within the bound; the probe reads it down', async () => {
    const provider = new SendGridProvider({
      apiKey: 'k',
      endpoint: `http://127.0.0.1:${blackHolePort}/v3/mail/send`,
      requestTimeoutMs: 300,
    });
    await provider.connect();
    await expect(provider.send(mail)).rejects.toBeInstanceOf(BackendOutcomeUnknownError);
    expect(await provider.isHealthy()).toBe(false);
  });

  it("a refusal names the status and SendGrid's own reason", async () => {
    const provider = new SendGridProvider({
      apiKey: 'k',
      endpoint: `http://127.0.0.1:${capturePort}/v3/mail/send`,
    });
    await provider.connect();
    await expect(provider.send(mail)).rejects.toThrow(
      'SendGrid send failed: HTTP 401: The provided authorization grant is invalid',
    );
  });

  it('sendGridReason reads the first error, cuts it, and tolerates any body', async () => {
    expect(
      await sendGridReason(
        new Response(JSON.stringify({ errors: [{ message: 'x'.repeat(500) }] })),
      ),
    ).toHaveLength(200);
    expect(await sendGridReason(new Response('not json'))).toBe('');
    expect(await sendGridReason(new Response(JSON.stringify({ errors: [{}] })))).toBe('');
    expect(await sendGridReason(new Response(JSON.stringify({})))).toBe('');
  });

  it('refuses an out-of-range bound', () => {
    expect(() => new SendGridProvider({ apiKey: 'k', requestTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
  });
});
