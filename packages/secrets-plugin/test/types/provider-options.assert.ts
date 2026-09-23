/**
 * Compile-time assertion that the secrets provider option interfaces carry the
 * `endpoint` option (M99d §4.1).
 *
 * `deno task check` type-checks every module under `packages/`, and this file
 * is deliberately NOT named `*.test.ts`, so `deno test` never executes it: the
 * assertion is the type-check itself. A narrowing of either interface — dropping
 * `endpoint` or making it required — is a `deno check` failure here rather than
 * a silent runtime change, and the real-emulator test's guard is the behavioural
 * half of the same control.
 *
 * @module
 */
import type { AwsKmsProviderOptions } from '../../src/providers/aws-kms.ts';
import type { GcpSecretManagerProviderOptions } from '../../src/providers/gcp-secret-manager.ts';
import type { SecretsProviderOptions } from '../../src/interfaces/index.ts';

// The option WITH `endpoint`: a narrowing that drops the member fails here.
const awsWithEndpoint: AwsKmsProviderOptions = {
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',
};

// The option WITHOUT `endpoint`: a change that makes it required fails here.
const awsWithoutEndpoint: AwsKmsProviderOptions = { region: 'us-east-1' };

const gcpWithEndpoint: GcpSecretManagerProviderOptions = {
  projectId: 'my-project',
  endpoint: 'http://localhost:4443',
};

const gcpWithoutEndpoint: GcpSecretManagerProviderOptions = {
  projectId: 'my-project',
};

// The PLUGIN options type carries `endpoint` too (M99d review fix): the
// PUBLIC_API.md `SecretsPlugin` options table documents `options.endpoint`,
// and `createProvider` forwards it to the provider. Dropping the member from
// `SecretsProviderOptions` fails here.
const pluginWithEndpoint: SecretsProviderOptions = {
  endpoint: 'http://localhost:4566',
};
const pluginWithoutEndpoint: SecretsProviderOptions = { region: 'us-east-1' };

// Consumed by exports so `noUnusedLocals` cannot strip the assignments — and
// so a reader who follows a symbol finds this file rather than a dead value.
export const AWS_OPTIONS_ASSERTIONS: readonly AwsKmsProviderOptions[] = [
  awsWithEndpoint,
  awsWithoutEndpoint,
];
export const GCP_OPTIONS_ASSERTIONS: readonly GcpSecretManagerProviderOptions[] = [
  gcpWithEndpoint,
  gcpWithoutEndpoint,
];
export const PLUGIN_OPTIONS_ASSERTIONS: readonly SecretsProviderOptions[] = [
  pluginWithEndpoint,
  pluginWithoutEndpoint,
];
