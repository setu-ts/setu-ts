/**
 * Serializer interface for message payload serialization/deserialization.
 *
 * @module
 */

/**
 * Serializer contract for converting messages to/from string payloads.
 *
 * @typeParam T - The payload type being serialized
 * @since 0.1.0
 */
export interface ISerializer {
  /**
   * Serializes a value to a string payload.
   *
   * @typeParam T - The payload type
   * @param value - The value to serialize
   * @returns The serialized string
   * @since 0.1.0
   */
  serialize<T>(value: T): string;

  /**
   * Deserializes a string payload to a value.
   *
   * @typeParam T - The expected payload type
   * @param payload - The string payload to deserialize
   * @returns The deserialized value
   * @since 0.1.0
   */
  deserialize<T = unknown>(payload: string): T;
}
