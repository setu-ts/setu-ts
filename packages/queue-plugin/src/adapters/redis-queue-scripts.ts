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
 * `reserve`: reclaim expired claims, then lease due jobs. TIME requires Redis 5+
 * script-effects replication. Payload bytes are returned unchanged, beside the
 * stall count and new token; Lua never re-encodes job data.
 *
 * KEYS: ready, processing, jobs, claims, stalls, claimseq.
 * ARGV: limit, visibilityTimeoutMs. Both ready and lease scores use server time.
 */
export const RESERVE_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, ARGV[1])
for _, id in ipairs(expired) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('HDEL', KEYS[4], id)
  if redis.call('HEXISTS', KEYS[3], id) == 1 then
    redis.call('HINCRBY', KEYS[5], id, 1)
    redis.call('ZADD', KEYS[1], now, id)
  else
    redis.call('ZREM', KEYS[1], id)
    redis.call('HDEL', KEYS[5], id)
  end
end
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, ARGV[1])
local out = {}
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[1], id)
  local raw = redis.call('HGET', KEYS[3], id)
  if raw then
    redis.call('INCR', KEYS[6])
    local token = redis.call('GET', KEYS[6])
    redis.call('ZADD', KEYS[2], now + tonumber(ARGV[2]), id)
    redis.call('HSET', KEYS[4], id, token)
    table.insert(out, {raw, tonumber(redis.call('HGET', KEYS[5], id) or '0'), token})
  else
    redis.call('ZREM', KEYS[2], id)
    redis.call('HDEL', KEYS[4], id)
    redis.call('HDEL', KEYS[5], id)
  end
end
return out
`;

/**
 * `ack`: drop a finished job from processing and delete its payload.
 *
 * KEYS: processing, jobs, claims, stalls. ARGV: id, token.
 */
export const ACK_SCRIPT = `
if redis.call('HGET', KEYS[3], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
redis.call('HDEL', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
return 1
`;

/**
 * `requeue`: write the updated payload and move the job from processing back
 * to ready. The payload is computed by the caller from a prior read, so the
 * script never re-encodes job data.
 *
 * KEYS: jobs, processing, ready, claims, stalls. ARGV: id, payload, availableAtMs, token.
 */
export const REQUEUE_SCRIPT = `
if redis.call('HGET', KEYS[4], ARGV[1]) ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[3], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
redis.call('HDEL', KEYS[5], ARGV[1])
return 1
`;

/**
 * `deadLetter`: move a job from processing into the dead set, first moving
 * its payload into the dead-jobs hash when retention is active (`move` = `1`).
 *
 * KEYS: processing, dead, jobs, dead-jobs, claims, stalls.
 * ARGV: id, nowMs, move, token.
 */
export const DEAD_LETTER_SCRIPT = `
if redis.call('HGET', KEYS[5], ARGV[1]) ~= ARGV[4] then return 0 end
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[5], ARGV[1])
redis.call('HDEL', KEYS[6], ARGV[1])
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

/**
 * Renew only the current delivery using the Redis server's clock.
 * KEYS: processing, claims. ARGV: id, token, visibilityTimeoutMs.
 */
export const EXTEND_SCRIPT = `
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then return 0 end
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
return 1
`;
