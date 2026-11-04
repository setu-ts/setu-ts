import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';
import {
  createQuota,
  MemoryQuotaStore,
  QuotaExceededError,
  respondQuotaExceeded,
} from '@setu-ts/auth-plugin';
import type { IQuota, QuotaReservation } from '@setu-ts/auth-plugin';

/** Creates one lazy, per-principal archive budget per application. */
export function archiveQuota(): MiddlewareFunction {
  let quota: IQuota | undefined;
  return async (ctx, next) => {
    if (quota === undefined) {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      quota = createQuota({
        name: 'archive',
        window: 'utc-day',
        limit: 3,
        store: new MemoryQuotaStore(runtime),
        runtime,
      });
    }
    let reservation: QuotaReservation;
    try {
      reservation = await quota.reserve(ctx.request.user!.id, 2);
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      respondQuotaExceeded(ctx, error);
      return;
    }
    try {
      await next();
    } catch (error) {
      // Thrown HTTP exceptions are formatted by the outer errorHandler.
      await quota.release(reservation);
      throw error;
    }
    if (ctx.response.snapshot().status >= 400) await quota.release(reservation);
    else await quota.settle(reservation, reservation.amount);
  };
}
