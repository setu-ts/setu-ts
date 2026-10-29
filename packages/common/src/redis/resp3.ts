/** Internal RESP3 map conversion for the ioredis-shaped Redis boundary. @module */

/** Converts map replies recursively, preserving the stream read's pair encoding. */
export function normalizeResp3(reply: unknown, command: string): unknown {
  const pairs = command.toUpperCase() === 'XREADGROUP' || command.toUpperCase() === 'XREAD';
  return normalize(reply, pairs);
}

function normalize(reply: unknown, pairs = false): unknown {
  if (Array.isArray(reply)) return reply.map((value: unknown) => normalize(value));
  let entries: [unknown, unknown][];
  if (reply instanceof Map) {
    entries = [...reply.entries()];
  } else if (
    reply !== null &&
    typeof reply === 'object' &&
    (Object.getPrototypeOf(reply) === Object.prototype || Object.getPrototypeOf(reply) === null)
  ) {
    entries = Object.entries(reply);
  } else {
    return reply;
  }
  return pairs
    ? entries.map(([key, value]) => [key, normalize(value)])
    : entries.flatMap(([key, value]) => [key, normalize(value)]);
}
