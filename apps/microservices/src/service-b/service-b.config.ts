import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { greetingFor } from '../greeting.contract.ts';
import { optionalMessaging } from '../messaging.ts';

/** Builds service B: an HTTP greeting, plus the shared broker when Redis is configured. */
export function createServiceB(redisUrl?: string): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin(), ...optionalMessaging(redisUrl)] });
  app.router.get('/hello', (ctx) => ctx.response.json(greetingFor('service-a')));
  return app;
}
