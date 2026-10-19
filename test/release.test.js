/**
 * Tests for the changelog parser used by release automation.
 *
 * @module test/release.test
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPackageVersion,
  buildTag,
  buildTitle,
  parseLatestRelease,
} from "../scripts/release.js";

const CHANGELOG = `# Changelog

## [Unreleased]

### Highlights

<!-- Placeholder on the dev branch. -->

### Added

- Work in progress.

## [0.2.0] - 2026-10-19

### Highlights

- Second release.

### Added

- Feature A.

### Contributors

- @alice

## [0.1.0] - 2026-09-01

### Highlights

- First release.
`;

test("parseLatestRelease skips Unreleased and returns the newest release", () => {
  const release = parseLatestRelease(CHANGELOG);

  assert.equal(release.version, "0.2.0");
  assert.equal(release.date, "2026-10-19");
  assert.match(release.body, /^### Highlights/);
  assert.match(release.body, /- Feature A\./);
  assert.match(release.body, /### Contributors\n\n- @alice/);
  assert.doesNotMatch(release.body, /0\.1\.0|First release/);
});

test("parseLatestRelease accepts CRLF changelogs", () => {
  const release = parseLatestRelease(CHANGELOG.replaceAll("\n", "\r\n"));

  assert.equal(release.version, "0.2.0");
  assert.match(release.body, /- @alice/);
});

test("parseLatestRelease rejects a changelog with only an Unreleased entry", () => {
  assert.throws(
    () => parseLatestRelease("## [Unreleased]\n\n- Work in progress.\n"),
    /No released version/,
  );
});

test("parseLatestRelease rejects a non-semver version", () => {
  assert.throws(
    () => parseLatestRelease("## [0.2] - 2026-10-19\n\n- Feature.\n"),
    /not a valid semantic version/,
  );
});

test("parseLatestRelease requires a release date", () => {
  assert.throws(
    () => parseLatestRelease("## [0.2.0]\n\n- Feature.\n"),
    /missing its release date/,
  );
});

test("parseLatestRelease rejects a malformed release heading", () => {
  assert.throws(
    () => parseLatestRelease("## [0.2.0] - 2026-10-19 (draft)\n\n- Feature.\n"),
    /heading .* is malformed/,
  );
});

test("parseLatestRelease rejects an empty release section", () => {
  assert.throws(
    () => parseLatestRelease(
      "## [0.2.0] - 2026-10-19\n\n## [0.1.0] - 2026-09-01\n\n- Feature.\n",
    ),
    /has no content/,
  );
});

test("assertPackageVersion requires an exact match", () => {
  assert.doesNotThrow(() => assertPackageVersion("0.2.0", "0.2.0"));
  assert.throws(
    () => assertPackageVersion("0.2.0", "0.1.0"),
    /does not match package\.json version 0\.1\.0/,
  );
  assert.throws(() => assertPackageVersion("0.2.0", ""), /missing its version/);
});

test("buildTag and buildTitle use the v-prefixed version", () => {
  assert.equal(buildTag("0.2.0"), "v0.2.0");
  assert.equal(buildTag("0.2.0-rc.1"), "v0.2.0-rc.1");
  assert.equal(buildTitle("v0.2.0"), "DSH-her.memory v0.2.0");
});
