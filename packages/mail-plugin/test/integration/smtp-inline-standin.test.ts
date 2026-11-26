/**
 * An SMTP attachment with a `contentId` arrives inline at a real SMTP server
 * (V13-4). Guarded on `SMTP_URL` (Mailpit's SMTP port) and `MAILPIT_API_URL`
 * (its HTTP API, which serves the raw message back); skips without either.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { SmtpProvider } from '../../src/providers/smtp-provider.ts';

const SMTP = process.env['SMTP_URL'];
const API = process.env['MAILPIT_API_URL'];

describe.skipIf(SMTP === undefined || API === undefined)(
  'SMTP inline attachments on Mailpit',
  () => {
    it('the contentId part is Content-Disposition: inline', async () => {
      const url = new URL(SMTP!);
      const subject = `inline-${Math.floor(performance.now() * 1000)}`;
      const provider = new SmtpProvider({ host: url.hostname, port: Number(url.port) });
      await provider.connect();
      await provider.send({
        from: 'a@x.test',
        to: 'b@x.test',
        subject,
        html: '<img src="cid:logo">',
        attachments: [
          {
            filename: 'logo.txt',
            content: new TextEncoder().encode('LOGO'),
            contentType: 'text/plain',
            contentId: 'logo',
          },
        ],
      });
      const search = (await (
        await fetch(`${API}/api/v1/search?query=${encodeURIComponent(`subject:${subject}`)}`)
      ).json()) as { messages: { ID: string }[] };
      const id = search.messages[0]!.ID;
      const raw = await (await fetch(`${API}/api/v1/message/${id}/raw`)).text();
      expect(raw).toMatch(/Content-Disposition: inline; filename=logo\.txt/);
      expect(raw).toMatch(/Content-ID: <logo>/);
    });
  },
);
