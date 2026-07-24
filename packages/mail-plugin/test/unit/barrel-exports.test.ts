import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import * as api from '../../src/index.ts';

describe('mail-plugin barrel exports', () => {
  it('exports every documented runtime symbol', () => {
    const expected = [
      'MailPlugin',
      'createProvider',
      'MailService',
      'TemplateEngine',
      'escapeHtml',
      'LogProvider',
      'SmtpProvider',
      'adaptNodemailerModule',
      'loadNodemailerModule',
      'toNodemailerMessage',
      'validateSmtpTransport',
      'SesProvider',
      'adaptSesModule',
      'loadSesModule',
      'toSesInput',
      'validateSesClient',
      'SendGridProvider',
      'toSendGridBody',
    ] as const;
    for (const name of expected) {
      expect(typeof (api as Record<string, unknown>)[name]).not.toBe('undefined');
    }
  });
});
