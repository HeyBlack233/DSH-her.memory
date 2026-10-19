/**
 * Release automation for the `main` branch.
 *
 * The release flow puts the released version at the top of `CHANGELOG.md` and
 * mirrors it in `package.json`. This script reads that entry and asks the GitHub
 * CLI to create the matching tag and release. It is idempotent: an existing
 * release is left alone, and an existing tag is never moved.
 *
 * @module scripts/release
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, derived from this file's location. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Semantic version, without a leading `v`. */
const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** A `## [version] - date` heading at the top level of the changelog. */
const RELEASE_HEADING_PATTERN = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?[ \t]*$/;

/** Any top-level bracketed heading, used to detect malformed release headings. */
const HEADING_PREFIX_PATTERN = /^## \[([^\]]+)\]/;

/** Run a command in the repository root and return its trimmed output. */
function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  }).trim();
}

/**
 * Extract the newest released entry from a changelog.
 *
 * `[Unreleased]` entries are skipped. The body keeps its `###` sections but not
 * the version heading, and stops at the next top-level `##` heading.
 *
 * @param {string} markdown Full contents of `CHANGELOG.md`.
 * @returns {{ version: string, date: string, body: string }}
 */
export function parseLatestRelease(markdown) {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new Error("CHANGELOG.md is empty.");
  }

  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const prefix = HEADING_PREFIX_PATTERN.exec(lines[index]);
    if (prefix === null) continue;

    const version = prefix[1].trim();
    if (version.toLowerCase() === "unreleased") continue;

    const match = RELEASE_HEADING_PATTERN.exec(lines[index]);
    if (match === null) {
      throw new Error(
        `CHANGELOG.md heading "${lines[index]}" is malformed `
          + `(expected "## [${version}] - YYYY-MM-DD").`,
      );
    }

    if (!VERSION_PATTERN.test(version)) {
      throw new Error(
        `CHANGELOG.md version "${version}" is not a valid semantic version (expected x.y.z).`,
      );
    }
    if (match[2] === undefined) {
      throw new Error(
        `CHANGELOG.md entry ${version} is missing its release date (expected "## [${version}] - YYYY-MM-DD").`,
      );
    }

    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (lines[next].startsWith("## ")) {
        end = next;
        break;
      }
    }

    const body = lines.slice(index + 1, end).join("\n").trim();
    if (body.length === 0) {
      throw new Error(`CHANGELOG.md entry ${version} has no content.`);
    }

    return { version, date: match[2], body };
  }

  throw new Error(
    "No released version found in CHANGELOG.md. The top entry is still [Unreleased]; "
      + "complete the release flow before pushing to main.",
  );
}

/**
 * Require the changelog version and the package version to agree.
 *
 * @param {string} version Version from the changelog.
 * @param {string} packageVersion Version from `package.json`.
 */
export function assertPackageVersion(version, packageVersion) {
  if (typeof packageVersion !== "string" || packageVersion.length === 0) {
    throw new Error("package.json is missing its version.");
  }
  if (version !== packageVersion) {
    throw new Error(
      `CHANGELOG.md version ${version} does not match package.json version ${packageVersion}. `
        + "Bump package.json in the release branch before merging.",
    );
  }
}

/** Build the Git tag name for a version. */
export function buildTag(version) {
  return `v${version}`;
}

/** Build the GitHub Release title for a tag. */
export function buildTitle(tag) {
  return `DSH-her.memory ${tag}`;
}

/** Whether a release with this tag already exists. */
function releaseExists(tag) {
  try {
    execFileSync("gh", ["release", "view", tag], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Resolve a local tag to the commit it points at, if the tag exists. */
function tagTarget(tag) {
  try {
    return run("git", ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]);
  } catch {
    return null;
  }
}

/** Tag the checked-out commit and publish a GitHub Release for it. */
function main() {
  const changelog = readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const release = parseLatestRelease(changelog);

  assertPackageVersion(release.version, manifest.version);

  const tag = buildTag(release.version);
  const title = buildTitle(tag);
  const prerelease = release.version.includes("-");
  const head = run("git", ["rev-parse", "HEAD"]);

  if (process.argv.includes("--dry-run")) {
    console.log(JSON.stringify({
      version: release.version,
      date: release.date,
      tag,
      title,
      prerelease,
      target: head,
      body: release.body,
    }, null, 2));
    return;
  }

  if (releaseExists(tag)) {
    console.log(`Release ${tag} already exists; nothing to do.`);
    return;
  }

  const existing = tagTarget(tag);
  if (existing !== null && existing !== head) {
    throw new Error(`Tag ${tag} already points at ${existing}, not at ${head}; refusing to move it.`);
  }

  const notesPath = path.join(tmpdir(), `dsh-her-memory-${tag}.md`);
  writeFileSync(notesPath, `${release.body}\n`, "utf8");

  const args = ["release", "create", tag, "--target", head, "--title", title, "--notes-file", notesPath];
  if (prerelease) args.push("--prerelease");

  const url = run("gh", args);
  console.log(`Created ${title}: ${url}`);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
