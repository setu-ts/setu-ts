import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

/** Issues a five-minute local demo credential without logging it. */
export function issueDemoToken(
  app: IKernelApplication,
  scope = 'items:read items:write',
  sub = 'demo-user',
): Promise<string> {
  return app.services.get<IJwtService>(CAPABILITIES.JWT).sign({ sub, scope }, { expiresIn: '5m' });
}

// Explicit credential output for the operator; never put it in application logs.
if (import.meta.main) {
  const app = createApp();
  await app.start();
  try {
    process.stdout.write(
      `${await issueDemoToken(app, process.argv[2] ?? 'items:read items:write')}\n`,
    );
  } finally {
    await app.stop();
  }
}
