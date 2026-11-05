import { expect, it } from 'vitest';
import { RouteRegistrationError } from '../../src/index.ts';

it.each(['regex-parameter', 'unsupported-pattern', 'duplicate'] as const)(
  'M131b 3.11 carries %s and preserves the original refusal',
  (reason) => {
    const original = new RouteRegistrationError(reason, 'GET', '/x', 'refused');
    const enriched = new RouteRegistrationError(reason, 'GET', '/x', 'Ctrl.method: refused', {
      cause: original,
    });
    expect(enriched).toBeInstanceOf(Error);
    expect(enriched).toBeInstanceOf(RouteRegistrationError);
    expect(enriched).toMatchObject({
      name: 'RouteRegistrationError',
      reason,
      method: 'GET',
      path: '/x',
      cause: original,
    });
  },
);
