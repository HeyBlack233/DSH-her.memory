# Release Automation

This document describes how a completed release on `main` becomes a Git tag and
a GitHub Release. Branch creation, version choice, and changelog content remain
manual steps in the release flow.

## Trigger chain

1. The release flow merges `release/<version>` into `main` and pushes.
2. The push runs the CI workflow in [ci.md](ci.md).
3. Only when that push-triggered CI run succeeds does the Release workflow run.
   It listens for `workflow_run` completion of `CI` on `main`; a failed CI run
   creates no tag and no release.
4. The Release job checks out the exact commit that CI verified
   (`workflow_run.head_sha`), not whatever `main` points at when the job starts.

A manual `workflow_dispatch` is also available, but only on `main`. Because it
bypasses the CI trigger, it runs `npm run check` and `npm test` itself before
creating anything.

## Version source

The script reads the newest released entry in `CHANGELOG.md`: the first
`## [x.y.z] - YYYY-MM-DD` heading, skipping `[Unreleased]`. The entry must:

- Use a semantic version without a `v` prefix.
- Include a release date.
- Have a non-empty body.

`package.json` must carry the same version. A mismatch fails the job with a
message pointing at the release branch.

If the top entry is still `[Unreleased]`, the job fails. On `main` that means the
release flow was not completed; the workflow does not guess a version.

## Tag, title, and body

- Tag: `v<version>` (for example `v0.1.0`). It is created by
  `gh release create` as a lightweight tag unless it already exists.
- Title: `DSH-her.memory v<version>`.
- Body: the full released section, from `### Highlights` through
  `### Contributors`, without the `## [version] - date` heading.
- A version with a prerelease suffix (for example `v0.2.0-rc.1`) is published
  with `--prerelease`.

## Idempotency and safety

- If a release for the tag already exists, the job exits successfully without
  changing anything.
- If the tag exists at the checked-out commit but the release is missing, the
  release is created from that tag.
- If the tag exists at a different commit, the job fails; it never moves an
  existing tag.
- The tag target is the checked-out `HEAD`. `GITHUB_SHA` is not used: on a
  `workflow_run` event it points at the current default-branch tip, which may
  have moved past the commit CI verified.

## Manual recovery

- If CI fails, fix the problem and push again, or rerun the failed CI run.
- If the Release job fails after CI passed, rerun the Release workflow manually
  on `main`. It verifies the checkout again and then retries the same
  idempotent tag/release step.
- Local inspection is available with `node scripts/release.js --dry-run`, which
  prints the parsed version, tag, title, target commit, and body without calling
  GitHub. It requires a released entry, so run it on a release branch or a
  fixture, not on a `dev` checkout whose top entry is `[Unreleased]`.

## Requirements

- GitHub Actions must be allowed to write repository contents; the workflow
  requests `contents: write`.
- Tag protection rules must not block `GITHUB_TOKEN` from creating `v*` tags.
- Releases created with `GITHUB_TOKEN` do not trigger further workflows.
