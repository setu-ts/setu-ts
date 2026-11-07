# @grpc-workspace/contracts

Shared code for this workspace. Import it from any member:

```ts
import { BillingService } from '@grpc-workspace/contracts';
```

No wiring is needed: the workspace resolves a member by its declared `name`. Under pnpm, as in this
repository, each member also declares `"@grpc-workspace/contracts": "workspace:*"`.

The contract is `proto/billing/v1/billing.proto`; `npm run proto:gen` regenerates `src/gen/`.

## Test

```bash
npm test
```
