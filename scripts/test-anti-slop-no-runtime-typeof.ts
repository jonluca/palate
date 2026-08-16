#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const fixtureDirectory = mkdtempSync(join(tmpdir(), "palate-anti-slop-"));

try {
  writeFileSync(
    join(fixtureDirectory, "tautological.ts"),
    `export function isTautologicalValue(value: string): value is string {
  return typeof value === "string";
}
`,
  );
  writeFileSync(
    join(fixtureDirectory, "parenthesized-tautological.ts"),
    `
export function isParenthesizedTautologicalValue(value: string): value is (string) {
  return typeof value === "string";
}
`,
  );
  writeFileSync(
    join(fixtureDirectory, "genuine-union.ts"),
    `
export function isGenuinelyNarrowedValue(value: string | undefined): value is string {
  return typeof value === "string";
}
`,
  );
  writeFileSync(
    join(fixtureDirectory, "genuine-optional.ts"),
    `
export function isOptionalNarrowedValue(value?: string): value is string {
  return typeof value === "string";
}
`,
  );
  writeFileSync(
    join(fixtureDirectory, "optional-tautological.ts"),
    `
export function isOptionalTautologicalValue(value?: string): value is string | undefined {
  return typeof value === "string";
}
`,
  );
  writeFileSync(
    join(fixtureDirectory, "reordered-union-tautological.ts"),
    `
export function isReorderedUnionTautologicalValue(value: string | number): value is number | string {
  return typeof value === "string";
}
`,
  );

  const fixturePaths = [
    "tautological.ts",
    "parenthesized-tautological.ts",
    "genuine-union.ts",
    "genuine-optional.ts",
    "optional-tautological.ts",
    "reordered-union-tautological.ts",
  ].map((filename) => join(fixtureDirectory, filename));

  const result = spawnSync(
    join(repositoryRoot, "node_modules", ".bin", "oxlint"),
    ["--config", join(repositoryRoot, ".oxlintrc.json"), "--format", "unix", ...fixturePaths],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
  if (result.error) {
    throw result.error;
  }

  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1, output);
  assert.equal((output.match(/anti-slop\(no-runtime-typeof\)/g) ?? []).length, 4, output);
  assert.match(output, /\/tautological\.ts:/);
  assert.match(output, /\/parenthesized-tautological\.ts:/);
  assert.match(output, /\/optional-tautological\.ts:/);
  assert.match(output, /\/reordered-union-tautological\.ts:/);
  assert.doesNotMatch(output, /\/genuine-union\.ts:/);
  assert.doesNotMatch(output, /\/genuine-optional\.ts:/);
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}

console.log("Anti-slop runtime-typeof guard regression test passed.");
