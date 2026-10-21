# @setu-ts/service-discovery-plugin — resolve service names to instances

`setu add service-discovery` installs it and prints
`ServiceDiscoveryPlugin({ provider: 'static', services: {} })` for `setu.config.ts`; fill in
`services`. `CAPABILITIES.SERVICE_DISCOVERY` resolves after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceDiscovery } from '@setu-ts/common';
import { ServiceDiscoveryPlugin } from '@setu-ts/service-discovery-plugin';

app.register(
  ServiceDiscoveryPlugin({
    provider: 'static',
    services: { billing: [{ host: '10.0.0.1', port: 8080 }] },
  }),
);

await app.start();
const discovery = app.services.get<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY);
const url = await discovery.resolveUrl('billing', '/invoices');
const instance = await discovery.pick('billing', { strategy: 'weighted-random' });
if (instance !== null) discovery.report(instance, 'success');
```

- `provider` is `'static'` (a literal `services` map), `'consul'` (`address`, `token`, `datacenter`,
  `waitSeconds`), `'kubernetes'` (`namespace`, `apiServer`, `portName`), `'dns'` (`mode`,
  `domainTemplate`, `port`) or `'custom'` (`discovery`).
- `resolveUrl` returns an absolute URL or `null` when nothing is available. `resolve` lists every
  known instance, including ejected ones; `pick` skips ejected ones and falls back to the full pool
  if everything is ejected. `discovery.watch` gets the full list on every change.
- Call `discovery.report` with `'success'` or `'failure'` after each call. Five failures in 30 s
  eject for 30 s; one success clears it. `ejection: false` disables this, and `maxEjectionPercent`
  (default `50`) caps how much of a pool can be out at once. Ejection is per process.
- `strategy` is `'round-robin'` (default), `'random'` or `'weighted-random'`; a per-call option
  overrides the plugin value. `cacheTtlMs` defaults to `30000` (`0` disables caching).
- `'dns'` needs the runtime DNS surface and throws `DiscoveryUnavailableError` on Cloudflare
  Workers. `'kubernetes'` needs `get`/`list`/`watch` on `endpointslices`, and an explicit `token` on
  Workers.
- `selfRegistration` is Consul-only; any other provider throws `SelfRegistrationNotSupportedError`
  at registration.
