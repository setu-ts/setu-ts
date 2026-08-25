import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ERROR_RESPONDER_STATE_KEY } from '../../src/errors/error-responder.ts';
import { CLIENT_IP_STATE_KEY } from '../../src/state-keys.ts';
import { validatedStateKey } from '../../src/services/validation.ts';

const KEY_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9-]+$/;

describe('state keys', () => {
  it('uses owner-prefixed kebab-case values', () => {
    expect(CLIENT_IP_STATE_KEY).toBe('http-security-plugin:client-ip');
    expect(ERROR_RESPONDER_STATE_KEY).toBe('exceptions:error-responder');
    for (const target of ['body', 'query', 'params', 'headers', 'cookies'] as const) {
      expect(validatedStateKey(target)).toBe(`validation-plugin:validated-${target}`);
      expect(KEY_PATTERN.test(validatedStateKey(target))).toBe(true);
    }
    expect(KEY_PATTERN.test(CLIENT_IP_STATE_KEY)).toBe(true);
    expect(KEY_PATTERN.test(ERROR_RESPONDER_STATE_KEY)).toBe(true);
  });
});
