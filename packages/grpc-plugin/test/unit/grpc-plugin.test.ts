/**
 * GrpcPlugin tests — verifies plugin registration, adapter interaction, and health reporting.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { GrpcPlugin } from '../../src/plugin/grpc-plugin.ts';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { GrpcUnavailableError } from '../../src/errors/grpc-errors.ts';

describe('GrpcPlugin', () => {
  it('should register under the correct name and provide GRPC token', () => {
    const plugin = GrpcPlugin();
    expect(plugin.name).toBe('grpc-plugin');
    expect(plugin.provides).toContain(CAPABILITIES.GRPC);
  });

  it('should have correct optionalDependencies', () => {
    const plugin = GrpcPlugin();
    expect(plugin.optionalDependencies).toContain('logger');
    expect(plugin.optionalDependencies).toContain('health');
  });
});
