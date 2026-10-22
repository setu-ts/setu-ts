import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService, IRequestContext, ITenantRepository } from '@setu-ts/common';

/** A note, stored in the partition of the tenant that wrote it. */
export interface Note {
  readonly id: string;
  readonly text: string;
}

/** Resolves the notes repository for the tenant of the current request. */
export function tenantNotes(ctx: IRequestContext): ITenantRepository<Note> {
  return ctx.services
    .get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY)
    .getRepository<Note>(ctx, 'notes');
}
