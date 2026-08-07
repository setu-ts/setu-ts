import { CAPABILITIES } from '@hono-enterprise/common';
import type { IDatabaseService } from '@hono-enterprise/database-plugin';

import { createApp } from './honoe.config.ts';
import { seedProducts } from '~/services/products.server.ts';

const app = await createApp();
await app.start({ port: 3000 });

// Seeding after start(), because the database plugin connects during the
// application's own startup hooks — before that there is no repository to
// write to.
await seedProducts(app.services.get<IDatabaseService>(CAPABILITIES.DATABASE));
