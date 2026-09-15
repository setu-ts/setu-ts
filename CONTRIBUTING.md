# Contributing to Setu-TS

Thank you for helping improve Setu-TS. The project is pre-1.0 and welcomes reports from applications
using it in production-like conditions, documentation improvements, focused bug fixes, and plugins
that use the published capability model.

## Choose the right channel

| You have                             | Start here                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| A question or setup concern          | The [Q&A discussion category](https://github.com/setu-ts/setu-ts/discussions/categories/q-a)              |
| Adoption experience or beta feedback | The [Beta feedback category](https://github.com/setu-ts/setu-ts/discussions/categories/beta-feedback)     |
| A feature or API idea                | The [Ideas discussion category](https://github.com/setu-ts/setu-ts/discussions/categories/ideas)          |
| A reproducible defect                | A [Bug Report](https://github.com/setu-ts/setu-ts/issues/new?template=bug-report.yml)                     |
| A runtime compatibility problem      | A [Compatibility Report](https://github.com/setu-ts/setu-ts/issues/new?template=compatibility-report.yml) |
| A security vulnerability             | [SECURITY.md](SECURITY.md) — do not create a public issue or discussion                                   |
| Conduct concern                      | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)                                                                  |

Search existing discussions and issues before opening a new one. Keep conversations constructive and
focused on the behaviour, documentation, or proposal at hand.

## From report to contribution

1. Discuss new APIs, plugins, behaviour changes, and non-trivial work before writing code. A
   maintainer will confirm whether the proposal fits the roadmap and identify the issue that owns
   it.
2. Open a focused issue with a reproducible problem or agreed acceptance criteria.
3. Wait for a maintainer to mark the issue as accepted for contribution before opening a code PR.
   Small documentation corrections may skip the discussion when their expected wording is clear.
4. Fork the repository, create one branch for the agreed change, and open a PR against `main`. Do
   not push to `main`, and do not request write access solely to contribute.
5. Keep the PR scoped to its linked issue. Include tests and documentation when the change requires
   them, and explain any intentional trade-off in the PR description.

Opening a discussion or issue does not promise acceptance, implementation, review, or merge.
Maintainers decide the public API, architecture, and release scope.

## Pull-request validation

Setu-TS runs a substantial validation suite. Pull requests from forks deliberately do **not** start
the repository's validation jobs, service containers, website build, or automatic CodeRabbit review.
GitHub requires maintainer approval before any outside contributor's fork workflow can begin. If a
maintainer explicitly approves one, it receives only a small policy check that does not check out
contributor code and prevents skipped checks from satisfying merge protection. This prevents
untriaged, untrusted changes from consuming project resources or being merged as if they had been
validated.

After accepting a contribution, a maintainer reproduces the change in a trusted repository branch,
where the full validation suite and an optional CodeRabbit review can run. Fork PRs are proposals;
the validated repository-branch PR is the one that can merge. Please do not ask maintainers to run
those services before the change has been accepted for review.

For work performed in a repository branch, the relevant checks are:

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

Changes to a published package also require its documented coverage and publish checks. See
[AI_GUIDELINES.md](AI_GUIDELINES.md) for the complete engineering requirements that apply once a
maintainer has accepted implementation work.

## Contribution expectations

- Use a clear, minimal reproduction for defects; include the Setu-TS version, runtime, packages,
  expected behaviour, actual behaviour, and safe logs.
- Do not include credentials, access tokens, private endpoints, customer data, or vulnerability
  details in public reports.
- Preserve the framework's runtime independence and public-contract boundaries. Do not add an API,
  dependency, or plugin coupling without prior agreement.
- Write accessible, factual documentation and examples. Documentation corrections are valuable
  contributions.
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in every project space.

## Maintainer triage

Maintainers use this order: acknowledge the report, reproduce or clarify it, decide its scope, and
then accept it for contribution, schedule it, or close it with a reason. Discussions that become
actionable work are converted into or linked to an issue, so that the decision and acceptance
criteria remain visible.
