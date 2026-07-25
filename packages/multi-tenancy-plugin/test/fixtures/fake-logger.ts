/**
 * Recording ILogger for testing.
 */
export function createRecordingFakeLogger(): {
  warnCalls: string[];
  infoCalls: string[];
  errorCalls: string[];
} {
  return {
    warnCalls: [],
    infoCalls: [],
    errorCalls: [],
  };
}

export function attachRecordingLogger(
  logger: ReturnType<typeof createRecordingFakeLogger>,
): import('@hono-enterprise/common').ILogger {
  return {
    level: 2 as const, // WARN
    fatal(_message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      logger.errorCalls.push(_message);
    },
    error(_message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      logger.errorCalls.push(_message);
    },
    warn(message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      logger.warnCalls.push(message);
    },
    info(_message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      logger.infoCalls.push(_message);
    },
    debug(_message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      // suppressed below WARN
    },
    trace(_message: string, _metadata?: import('@hono-enterprise/common').LogMetadata) {
      // suppressed below WARN
    },
    child() {
      return attachRecordingLogger(logger);
    },
  } as unknown as import('@hono-enterprise/common').ILogger;
}
