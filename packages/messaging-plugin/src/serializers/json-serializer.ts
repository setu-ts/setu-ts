import type { ISerializer } from './serializer.ts';

/**
 * JSON serializer implementation for message payloads.
 *
 * Uses standard JSON serialization/deserialization for converting
 * messages to/from string payloads.
 *
 * @since 0.1.0
 */
export class JsonSerializer implements ISerializer {
  /**
   * Serializes a value to a JSON string.
   *
   * @typeParam T - The payload type
   * @param value - The value to serialize
   * @returns The JSON string
   * @since 0.1.0
   */
  serialize<T>(value: T): string {
    return JSON.stringify(value);
  }

  /**
   * Deserializes a JSON string to a value.
   *
   * @typeParam T - The expected payload type
   * @param payload - The JSON string to deserialize
   * @returns The deserialized value
   * @since 0.1.0
   */
  deserialize<T = unknown>(payload: string): T {
    return JSON.parse(payload) as T;
  }
}
