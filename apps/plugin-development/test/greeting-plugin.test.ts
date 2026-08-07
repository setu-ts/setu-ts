import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';
import { GreetingPlugin } from '../src/greeting-plugin.ts';

describe('GreetingPlugin', () => {
  it('resolves its capability from its own route', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), GreetingPlugin()],
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: 'http://example.test/greet/Grace',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<{ message: string }>().message).toBe(
        'Hello, Grace!',
      );
    } finally {
      await app.stop();
    }
  });
});
