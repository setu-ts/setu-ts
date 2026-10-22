import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';

/**
 * The signing secret for this self-contained example.
 *
 * A deployed API reads its secret from configuration instead.
 */
export const DEMO_JWT_SECRET = 'rest-api-example-secret';

/** Issues a short-lived token for a started application. */
export async function issueDemoToken(app: IKernelApplication): Promise<string> {
  const jwt = app.services.get<IJwtService>(CAPABILITIES.JWT);
  return await jwt.sign({ sub: 'example-user' }, { expiresIn: '5m' });
}
