import { expect, it } from 'vitest';
import { createFullStackApp } from '../../src/app.ts';
import { fullStackHttpSecurityOptions } from '../../src/app.ts';
import { createFullStackAppFromConfig } from '../../src/from-config.ts';
import type { FullStackStarterOptions } from '../../src/options.ts';

const reactRouter: NonNullable<FullStackStarterOptions['reactRouter']> = {
  serverBuildPath: './build/server',
  loadRequestHandler: () =>
    Promise.resolve({
      handler: () => Promise.resolve(new Response('page')),
      createLoadContext: () => ({ get: <T>() => null as T, set: () => {} }),
    }),
};
const cases: readonly [FullStackStarterOptions['httpSecurity'], string | null][] = [
  [undefined, 'same-origin'],
  [{}, 'same-origin'],
  [{ headers: {} }, 'same-origin'],
  [{ headers: { referrerPolicy: 'strict-origin' } }, 'strict-origin'],
  [{ headers: { referrerPolicy: false } }, null],
  [{ headers: { enabled: false } }, null],
];
for (const fromConfig of [false, true]) {
  for (const [httpSecurity, expected] of cases) {
    it(`M131b 3.16 returns the full-stack referrer default fromConfig=${fromConfig} options=${JSON.stringify(httpSecurity)}`, async () => {
      const options: FullStackStarterOptions = {
        reactRouter,
        ...(httpSecurity === undefined ? {} : { httpSecurity }),
      };
      const app = fromConfig
        ? await createFullStackAppFromConfig(() => options, { env: {} })
        : createFullStackApp(options);
      app.router.get('/api/probe', (ctx) => ctx.response.text('ok'));
      await app.start();
      try {
        const response = await app.inject({ method: 'GET', url: '/api/probe' });
        expect(response.headers.get('referrer-policy')).toBe(expected);
      } finally {
        await app.stop();
      }
    });
  }
}
it('M131b 3.16 leaves a non-React-Router application and explicit policies unchanged', () => {
  expect(fullStackHttpSecurityOptions({})).toBeUndefined();
  const security = { headers: { referrerPolicy: 'origin' } };
  expect(fullStackHttpSecurityOptions({ httpSecurity: security })).toBe(security);
  expect(fullStackHttpSecurityOptions({ httpSecurity: security, reactRouter })).toBe(security);
});
