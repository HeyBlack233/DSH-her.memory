# Continuous Integration

This document describes the GitHub Actions workflow that verifies `main` after a
release, gates release automation, what it checks, and what it deliberately
leaves to manual verification.

## Workflow

The workflow lives in `.github/workflows/ci.yml` and runs on:

- Pushes to `main`. In this repository `main` only moves when the release flow
  merges `release/<version>` into it.
- Manual dispatch (`workflow_dispatch`).

There is no `pull_request` trigger: pull requests do not target `main`, and
`dev` remains unguarded. CI is post-merge verification and the gate for release
automation, not a pre-merge gate.

## Jobs

One job, `verify`, runs in a matrix of Node.js 22 (the `engines` minimum) and
Node.js 24. Both entries must pass; `fail-fast` is disabled so a failure in one
version does not hide the result of the other.

Each entry:

1. Checks out the repository.
2. Installs the selected Node.js version.
3. Runs `npm run check` (syntax checks over all JavaScript).
4. Runs `npm test` (the `node:test` suite).

The package has no dependencies and no lockfile, so the workflow does not run
`npm install` and does not use a dependency cache. `npm` is only used as a
script runner.

## Permissions and concurrency

- The workflow has read-only `contents` permission.
- Runs are not cancelled or grouped: every push to `main` is verified, so a
  later release does not hide the result of an earlier one.

## Branch protection

Do not require status checks on `main`: the checks only run after the release is
already pushed, so a required check would block the release push itself. Protect
`main` by restricting who may push to it; the workflow is diagnostic, not
pre-merge validation.

## Scope

CI covers static syntax checks and the deterministic fake-backend test suite.
It does not cover the settings page or any live Harness surface: those still
follow the manual checklist in [testing-and-verification.md](testing-and-verification.md).

A successful push-triggered CI run on `main` is the trigger for release
automation, which tags the verified commit and publishes the GitHub Release; see
[release-automation.md](release-automation.md).
