import { expect, it } from 'vitest';

import * as common from '../../src/index.ts';

it('exports the form-CSRF token accessor key and contract from the barrel', () => {
  expect(common.CSRF_TOKEN_ACCESS_STATE_KEY).toBe('session-plugin:csrf-token-access');
  const access: common.ICsrfTokenAccess = {
    headerName: 'x-csrf-token',
    tokenForExistingSession: () => undefined,
  };
  expect(access.tokenForExistingSession()).toBeUndefined();
});

it('exports the cookie-dependent response key from the barrel', () => {
  expect(common.COOKIE_DEPENDENT_RESPONSE_STATE_KEY).toBe(
    'session-plugin:cookie-dependent-response',
  );
});

it('exports the per-visitor response key from the barrel', () => {
  expect(common.PER_VISITOR_RESPONSE_STATE_KEY).toBe('session-plugin:per-visitor-response');
});
