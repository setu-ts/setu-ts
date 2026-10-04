import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { MailComponentTemplate, MailStringTemplate, MailTemplate } from '../../src/index.ts';
import * as api from '../../src/index.ts';

// Compile-time pin that the two M102 arm types are reachable from the BARREL
// (the M56 defect class — a type dropped from `index.ts` leaves every runtime
// assertion green). Declared against the barrel, never the concrete module.
const _stringArm: MailStringTemplate = { text: 'x' };
const _componentArm: MailComponentTemplate = { view: () => 'x' };
const _union: MailTemplate[] = [_stringArm, _componentArm];
void _union;

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
