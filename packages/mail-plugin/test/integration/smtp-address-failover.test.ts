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
import { connect, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';

let server: Server;
let port = 0;
let messages = 0;
/** The split-terminator test's client, destroyed in `afterAll` if it hangs. */
let client: Socket | undefined;
/** Called with each DATA chunk the server reads; the split test waits on it. */
let onBodyChunk: ((text: string) => void) | undefined;

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
      onBodyChunk?.(text);
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
  client?.destroy();
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

  it('the stand-in server completes a message whose terminator arrives split', async (context) => {
    if (!available) context.skip();
    const before = messages;
    const socket = connect(port, '127.0.0.2');
    client = socket;
    let received = '';
    const waitFor = (text: string): Promise<void> =>
      new Promise((resolve) => {
        const check = (): void => {
          if (received.includes(text)) {
            socket.off('data', onData);
            resolve();
          }
        };
        const onData = (chunk: Buffer): void => {
          received += chunk.toString();
          check();
        };
        socket.on('data', onData);
        check();
      });
    await waitFor('220 ');
    socket.write('DATA\r\n');
    await waitFor('354 ');
    // The final `CRLF` is written only after the server has read the body up
    // to `CRLF.`, so the terminator reaches it in two reads, not one.
    const firstPart = new Promise<void>((resolve) => {
      onBodyChunk = (text) => {
        if (text.endsWith('\r\n.')) resolve();
      };
    });
    socket.write('Subject: s\r\n\r\nbody\r\n.');
    await firstPart;
    onBodyChunk = undefined;
    socket.write('\r\n');
    await waitFor('250 queued');
    expect(messages).toBe(before + 1);
    socket.end('QUIT\r\n');
  });
});
