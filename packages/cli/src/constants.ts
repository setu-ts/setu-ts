/**
 * Constants for the honoe CLI tool.
 *
 * @module
 */

/** The name of the CLI executable. */
export const PROGRAM_NAME = 'honoe';

/** Exit codes. */
export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_ERROR = 1;

/** Schematic registry keys. These map to the available built-in schematics. */
export const SCHEMATICS = {
  PLUGIN: 'plugin',
  CONTROLLER: 'controller',
  SERVICE: 'service',
  ROUTE: 'route',
  MIDDLEWARE: 'middleware',
  GUARD: 'guard',
  HEALTH_INDICATOR: 'health-indicator',
  METRIC: 'metric',
  COMMAND_HANDLER: 'command-handler',
  QUERY_HANDLER: 'query-handler',
  EVENT_HANDLER: 'event-handler',
  JOB: 'job',
  MIGRATION: 'migration',
  CUSTOM: 'custom',
} as const;
