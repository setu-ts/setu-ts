// deno-lint-ignore-file no-console -- a skipped prerequisite must be visible in CI.
const redisUrl = Deno.env.get('REDIS_URL');
if (redisUrl === undefined) {
  console.warn('SKIP: set REDIS_URL to run the two-replica realtime backplane smoke check.');
  Deno.exit(77);
}

console.warn(
  `SKIP: Redis at ${redisUrl} was configured but the two-replica client harness is not wired yet.`,
);
Deno.exit(77);
