# Optional local CI accelerator

This is an optional accelerator for Linux + Docker only. CI and the standard gates remain the source
of truth: `pnpm run fmt:check`, `pnpm run lint`, `pnpm run check`, `pnpm test:coverage` and
`pnpm run test:tooling:coverage`. No required gate, CI job or hook invokes this runner.

On Linux with Docker, Node 24 and pnpm 12.11.2, install the frozen host dependencies, then run:

```sh
pnpm install --frozen-lockfile
pnpm run ci:local
```

This runs CI's static, CLI, messaging, packages and tooling shards with bounded concurrency. The
runner image contains CI's Node 24, pnpm 12.11.2, Deno 2.9.6 and Bun 1.4.0 toolchain, plus Helm
3.16.3 for the tooling render smoke, and builds automatically when absent. Rebuild it with
`docker build -t setu-ci-runner:local docker/ci-runner` after changing the Dockerfile. Commands and
endpoint environments come directly from `.github/workflows/ci.yml`.

Each shard has its own network namespace. CLI, messaging and packages each get all 13 CI backends;
static gets Redis for the realtime and microservices app smokes; tooling gets none. Containers
publish no host ports. PostgreSQL listens on 5433 and Keycloak on 8180, with its management port
reserved at 9100. There is no CPU pinning by default. Containers have explicit memory caps,
including 6 GiB for each test runner and 3 GiB for each Keycloak backend (it reached the earlier 2
GiB cap in measured runs, so 3 GiB leaves headroom).

The automatic concurrency is `min(5, floor(available GiB / 7), floor(available threads / 2))`, with
a minimum of one. Linux `MemAvailable` supplies the memory reading (falling back to `os.freemem()`);
`os.availableParallelism()` supplies the CPU reading. The runner prints its decision. It refuses
with exit 1 before creating anything on non-Linux systems, when the Docker CLI/daemon is
unavailable, or when less than 7 GiB is available. Each refusal lists the standard gates. A
requested `--parallel` that exceeds available memory also refuses. There is no resource override for
bypassing preflight; the unit tests simulate low-memory decisions.

The 7 GiB reservation per shard comes from prior sampled runs on the development host:

| Shard     | Runner peak MiB | Sum of individual backend/namespace peaks MiB | Simultaneous shard peak MiB |
| --------- | --------------: | --------------------------------------------: | --------------------------: |
| static    |           2,448 |                                            12 |                       2,459 |
| cli       |           3,961 |                                         2,843 |                       6,121 |
| messaging |             939 |                                         3,063 |                       3,193 |
| packages  |           1,124 |                                         3,049 |                       3,251 |
| tooling   |           6,136 |                                             1 |                       6,136 |

These are measurements, not guarantees: individual peaks need not coincide. The largest summed
reservation (CLI: 6,804 MiB) is rounded up to 7,168 MiB. Two threads per active shard is a
scheduling budget, not a Docker CPU quota. For example, 16 GiB **available** and eight threads
chooses two shards; 8 GiB available and four threads chooses one. Installed memory alone does not
determine capacity: the OS and other workloads need memory too. Existing host containers remain
running.

Runners set V8's old-space limit to 4 GiB, matching Node's default on the host while staying inside
the 6 GiB container cap. Node otherwise lowers its default heap in the container, which can make
ESLint exhaust a roughly 2 GiB heap even when physical memory is available.

The Docker socket is mounted in the test runners because real outage suites stop and restart their
own backends. These suites discover containers by `setu.ci.shard` and `setu.ci.port.<port>` labels
when `SETU_CI_SHARD` is set. Without it, the existing published-port discovery is used. Run trusted
repository code only: access to the Docker socket grants control over the host daemon.

```sh
pnpm run ci:local --shard messaging
pnpm run ci:local --parallel 2
pnpm run ci:local --parallel 1 --shard tooling
pnpm run ci:local --parallel 1 --cpus 0-3
pnpm run ci:local --shard cli --shard packages
pnpm run ci:local --include deno-lane --include compat --include node-build
pnpm run ci:local --shard packages --keep
```

`--parallel 1..5` controls how many shards run at once; one runs them sequentially, still with a
separate namespace per shard. Lower concurrency trades more time for less memory. Completed shards
release their containers before another shard starts. `--cpus <list>` passes a Docker cpuset (for
example `0-3,6`) to every container; choose CPUs allowed on your host. Restricting CPUs can take
longer and does not reduce the memory reservation. `--shard` limits the work and memory needed;
`--shard` and `--include` are repeatable. Extras run without backends. `--keep` retains this run's
**stopped** containers for debugging, releasing their RAM between shards; SIGINT/SIGTERM always
cleans up. Default cleanup removes only containers with the invocation's unique `setu.ci.run` label,
including stopped or paused containers.

Logs, listener snapshots, Docker memory samples and the JSON summary are kept under
`.tmp/local-ci/<run-id>/`. Each shard reports exit code, wall seconds, passed/skipped/ignored/failed
test counts and sampled peak memory, including its backends. The summary parses Vitest's final test
totals per member, including app tests emitted by the static shard. Compare skipped totals against
the same source revision's green CI logs. Failed shards do not cancel the others.

The worktree and its installed dependencies are bind-mounted at the same absolute path; Git's common
directory is mounted read-only for local history checks. Coverage remains under the normal
`coverage-node/<member>/` directories. Do not run another suite against this worktree concurrently:
each member's report paths and generated app files are shared. Host dependencies must be compatible
with Linux containers.

Each runner also mounts its own scratch directory at `/tmp`. Its files still live under the
worktree's `.tmp/local-ci/<run-id>/`, while subprocesses see short Unix socket paths and temporary
directories outside the repository, as they do in CI.
