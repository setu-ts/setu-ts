import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createCloudflareRuntimeServices } from '../../src/adapters/cloudflare/cf-runtime.ts';

describe('createCloudflareRuntimeServices', () => {
  it('throws a not-implemented error', () => {
    expect(() => createCloudflareRuntimeServices()).toThrow(
      'Cloudflare Workers runtime is not yet implemented.',
    );
  });
});
