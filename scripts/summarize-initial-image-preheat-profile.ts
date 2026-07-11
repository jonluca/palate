#!/usr/bin/env node
/// <reference types="node" />

import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { summarizeInitialImagePreheatProfile } from "./initial-image-preheat-profile-summary-core.ts";

const inputArgument = process.argv.slice(2).find((argument) => argument.startsWith("--input="));
if (!inputArgument) {
  throw new Error("Usage: summarize-initial-image-preheat-profile.ts --input=/absolute/profile.json");
}
const inputPath = resolve(inputArgument.slice("--input=".length));
const bytes = readFileSync(inputPath);
const summary = summarizeInitialImagePreheatProfile(JSON.parse(bytes.toString("utf8")));
const output = {
  schemaVersion: 2,
  sourcePath: inputPath,
  sourceSHA256: createHash("sha256").update(bytes).digest("hex"),
  ...summary,
};
const outputJSON = JSON.stringify(output);
const outputArgument = process.argv.slice(2).find((argument) => argument.startsWith("--output="));
if (outputArgument) {
  const outputPath = resolve(outputArgument.slice("--output=".length));
  writeFileSync(outputPath, `${outputJSON}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(outputPath, 0o600);
}
console.log(outputJSON);
if (!summary.validationPassed) {
  process.exitCode = 1;
}
