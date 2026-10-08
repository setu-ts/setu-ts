/**
 * The three atomic Lua scripts the Redis store sends with `EVAL` (plan §3.5).
 *
 * Every value reaches a script through `KEYS`/`ARGV`, never concatenated into
 * the script text. The scripts read the server clock with `TIME`, so every
 * replica shares one clock.
 *
 * @module
 */

/** CLAIM: `KEYS[1]` = store key; `ARGV` = token, fingerprint, leaseMs, ttlMs. */
export const CLAIM_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local raw = redis.call('GET', KEYS[1])
if raw then
  local rec = cjson.decode(raw)
  if rec.f ~= ARGV[2] then return {'fingerprint-mismatch'} end
  if rec.s == 'c' then return {'completed', rec.r} end
  if tonumber(rec.l) > now then return {'in-progress'} end
  rec.t = ARGV[1]
  rec.l = tostring(now + tonumber(ARGV[3]))
  redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ARGV[4])
  return {'claimed', '1'}
end
redis.call('SET', KEYS[1], cjson.encode({s = 'p', t = ARGV[1], f = ARGV[2], l = tostring(now + tonumber(ARGV[3]))}), 'PX', ARGV[4])
return {'claimed', '0'}
`;

/** COMPLETE: `KEYS[1]` = store key; `ARGV` = token, record, ttlMs. */
export const COMPLETE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lost' end
local rec = cjson.decode(raw)
if rec.s ~= 'p' or rec.t ~= ARGV[1] then return 'lost' end
rec.s = 'c'
rec.r = ARGV[2]
rec.t = nil
redis.call('SET', KEYS[1], cjson.encode(rec), 'PX', ARGV[3])
return 'settled'
`;

/** RELEASE: `KEYS[1]` = store key; `ARGV` = token. */
export const RELEASE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lost' end
local rec = cjson.decode(raw)
if rec.s ~= 'p' or rec.t ~= ARGV[1] then return 'lost' end
redis.call('DEL', KEYS[1])
return 'settled'
`;
