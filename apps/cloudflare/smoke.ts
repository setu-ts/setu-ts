// deno-lint-ignore-file no-console -- an unavailable external prerequisite must be visible in CI.
let check: Deno.CommandStatus | null = null;
try {
  check = await new Deno.Command('wrangler', { args: ['--version'] }).output();
} catch (error) {
  if (!(error instanceof Deno.errors.NotFound)) {
    throw error;
  }
}
if (check === null || !check.success) {
  console.warn('SKIP: Wrangler is not installed; Cloudflare smoke check was not run.');
  Deno.exit(77);
}

console.warn(
  'SKIP: run `deno task start` and exercise KV + the configured cron trigger in a Wrangler dev session.',
);
Deno.exit(77);
