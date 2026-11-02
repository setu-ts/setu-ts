/** Configuration failures for MCP construction and bootstrap. @module */

/** A malformed option or a route that cannot be exposed as a tool.
 * @since 0.13.0
 */
export class McpPluginConfigurationError extends Error {
  /** @param message - The configuration refusal */
  constructor(message: string) {
    super(message);
    this.name = 'McpPluginConfigurationError';
  }
}

/** Internal argument refusal sentinel; never carries caller values. */
export class UnusableArgumentError extends Error {}
