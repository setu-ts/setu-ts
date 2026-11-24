/**
 * SMTP address failover through the REAL nodemailer: a name that resolves to a
 * refusing address and a listening one still delivers, on the second, and the
 * message is sent once.
 *
 * Two loopback addresses on one port: nothing listens on `127.0.0.1`, so its
 * connect is refused (nodemailer's `ESOCKET` from `connect`); `127.0.0.2`
 * answers as a minimal SMTP server.
 *
 * @module
 */
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';

let server: Server;
let port = 0;
let messages = 0;

function speakSmtp(socket: Socket): void {
  socket.write('220 failover.test ESMTP\r\n');
  let inData = false;
  // The DATA terminator can arrive split across chunks, so the body is kept
  // until the whole `CRLF.CRLF` has been seen.
  let body = '';
  socket.on('data', (chunk) => {
    const text = chunk.toString();
    if (inData) {
      body += text;
      if (body.endsWith('\r\n.\r\n')) {
        inData = false;
        body = '';
        messages += 1;
        socket.write('250 queued\r\n');
      }
      return;
    }
    const verb = text.slice(0, 4).toUpperCase();
    if (verb === 'DATA') {
      inData = true;
      socket.write('354 go ahead\r\n');
    } else if (verb === 'QUIT') {
      socket.end('221 bye\r\n');
    } else {
      socket.write('250 ok\r\n');
    }
  });
}

// A host with no 127.0.0.2 (macOS by default) cannot run this; it skips.
let available = true;

beforeAll(async () => {
  server = createServer(speakSmtp);
  await new Promise<void>((resolve) => {
    server.once('error', () => {
      available = false;
      resolve();
    });
    server.listen(0, '127.0.0.2', resolve);
  });
  if (available) port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  if (available) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('SMTP failover with the real nodemailer', () => {
  it('delivers once on the next address after a refused connect', async (context) => {
    if (!available) context.skip();
    const provider = new SmtpProvider(
      { host: 'smtp.failover.test', port, dnsTtlMs: 60_000, connectionTimeoutMs: 2_000 },
      {
        hrtime: () => performance.now(),
        dns: {
          resolveHost: () => Promise.resolve(['127.0.0.1', '127.0.0.2']),
          resolveSrv: () => Promise.resolve([]),
        },
        random: () => 0,
      },
    );
    await provider.connect();
    await provider.send({
      from: 'a@failover.test',
      to: 'b@failover.test',
      subject: 's',
      text: 't',
    });
    expect(messages).toBe(1);
    await provider.disconnect();
  });
});
