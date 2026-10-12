import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createRuntimeServices } from '@setu-ts/runtime';

import { createApp } from './setu.config.ts';
import { seedProducts } from '~/services/products.server.ts';

const app = await createApp();
const runtime = createRuntimeServices();
await app.start({ port: Number(runtime.env.PORT ?? '3000') });

// Seeding after start(), because the database plugin connects during the
// application's own startup hooks — before that there is no repository to
// write to.
await seedProducts(app.services.get<IDatabaseService>(CAPABILITIES.DATABASE));
