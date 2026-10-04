/**
 * Lua scripts that make each multi-command {@link RedisQueue} transition one
 * atomic server-side unit (M101a). Internal — never barrel-exported.
 *
 * The default `commandTimeoutMs` rejects a command LOCALLY while the server
 * still applies it once it answers again, so a transition issued as several
 * commands can be cut part-way: a timed-out `ZREM` in `reserve` applied on
 * resume, with the following `ZADD` never sent, left the job in neither the
 * ready nor the processing set — lost with its payload still present. A script
 * runs entirely or not at all, so a timeout can leave only the whole
 * transition applied or none of it.
 *
 * @module
 */

/**
 * `enqueue`: store the payload and make the job due.
 *
 * KEYS: jobs hash, ready set. ARGV: id, payload, availableAtMs.
 */
export const ENQUEUE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
`;

/**
 * `reserve`: move up to `limit` due ids from ready to processing and return
 * their payloads, in score order.
 *
 * KEYS: ready set, processing set, jobs hash. ARGV: nowMs, limit.
 */
export const RESERVE_SCRIPT = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], ARGV[1], id)
  local raw = redis.call('HGET', KEYS[3], id)
  if raw then
    table.insert(out, raw)
  end
end
return out
`;

/**
 * `ack`: drop a finished job from processing and delete its payload.
 *
 * KEYS: processing set, jobs hash. ARGV: id.
 */
export const ACK_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return 1
`;

/**
 * `requeue`: write the updated payload and move the job from processing back
 * to ready. The payload is computed by the caller from a prior read, so the
 * script never re-encodes job data.
 *
 * KEYS: jobs hash, processing set, ready set. ARGV: id, payload, availableAtMs.
 */
export const REQUEUE_SCRIPT = `
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
return 1
`;

/**
 * `deadLetter`: move a job from processing into the dead set, first moving
 * its payload into the dead-jobs hash when retention is active (`move` = `1`).
 *
 * KEYS: processing set, dead set, jobs hash, dead-jobs hash.
 * ARGV: id, nowMs, move.
 */
export const DEAD_LETTER_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
if ARGV[3] == '1' then
  local raw = redis.call('HGET', KEYS[3], ARGV[1])
  if raw then
    redis.call('HSET', KEYS[4], ARGV[1], raw)
    redis.call('HDEL', KEYS[3], ARGV[1])
  end
end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[1])
return 1
`;
