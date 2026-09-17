/** M96 recurrence gate: framework egress consumers accept one redaction seam. */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedactionService } from '@setu-ts/common';
import type { AuditPluginOptions } from '@setu-ts/audit-plugin';
import type { LoggerPluginOptions } from '@setu-ts/logger-plugin';
import type { TelemetryPluginOptions } from '@setu-ts/telemetry-plugin';

describe('M96 egress consumers', () => {
  it('accepts the redaction service on every framework egress plugin option', () => {
    const service: IRedactionService = {
      redactValue: (_path, value) => value,
      redactRecord: (record) => record,
    };
    const logger: LoggerPluginOptions = { redaction: service };
    const telemetry: TelemetryPluginOptions = { redaction: service };
    const audit: AuditPluginOptions = { redaction: service };

    expect(logger.redaction).toBe(service);
    expect(telemetry.redaction).toBe(service);
    expect(audit.redaction).toBe(service);
  });
});
