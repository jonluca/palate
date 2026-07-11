#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(repositoryRoot, relativePath), "utf8");
}

function section(source: string, start: string, end: string, label: string): string {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `${label} start marker is missing`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${label} end marker is missing`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, needles: readonly string[], label: string): void {
  let previousIndex = -1;
  for (const needle of needles) {
    const index = source.indexOf(needle, previousIndex + 1);
    assert.notEqual(index, -1, `${label} is missing ordered contract marker: ${needle}`);
    assert.ok(index > previousIndex, `${label} marker is out of order: ${needle}`);
    previousIndex = index;
  }
}

function assertBuildFlag(flags: string, expectedFlag: string, label: string): void {
  const tokens = flags.trim().split(/\s+/);
  assert.ok(tokens.includes(expectedFlag), `${label} must include ${expectedFlag}`);
}

const visitSource = readRepositoryFile("services/visit.ts");
const michelinServiceSource = readRepositoryFile("services/michelin.ts");
const michelinDatabaseSource = readRepositoryFile("utils/db/michelin.ts");
const appConfigSource = readRepositoryFile("app.config.ts");
const podfileProperties = JSON.parse(readRepositoryFile("ios/Podfile.properties.json")) as Record<string, unknown>;

const appSqlitePlugin = appConfigSource.match(/["']expo-sqlite["'][\s\S]{0,300}?customBuildFlags:\s*["']([^"']+)["']/);
assert.ok(appSqlitePlugin, "app.config.ts must configure expo-sqlite custom build flags");
assertBuildFlag(appSqlitePlugin[1]!, "-DSQLITE_USE_URI=1", "app.config.ts expo-sqlite configuration");

const podfileSqliteFlags = podfileProperties["expo.sqlite.customBuildFlags"];
if (typeof podfileSqliteFlags !== "string") {
  throw new Error("Podfile properties must provide expo.sqlite.customBuildFlags");
}
assertBuildFlag(podfileSqliteFlags, "-DSQLITE_USE_URI=1", "ios/Podfile.properties.json");

const resolutionSource = section(
  michelinDatabaseSource,
  "export async function getMichelinImportResolution(",
  "async function openDedicatedMichelinImportConnection(",
  "Michelin strategy resolution",
);
assert.match(resolutionSource, /let sqliteUriAvailable = false;/);
assert.match(resolutionSource, /if \(Platform\.OS !== ["']web["']\)/);
assert.match(resolutionSource, /SELECT sqlite_compileoption_used\(\?\) AS enabled/);
assert.match(resolutionSource, /\[\s*["']USE_URI["']\s*\]/);
assert.match(resolutionSource, /sqliteUriAvailable = capability\?\.enabled === 1;/);
assertOrdered(
  resolutionSource,
  [
    "let sqliteUriAvailable = false;",
    "sqlite_compileoption_used(?) AS enabled",
    '"USE_URI"',
    "sqliteUriAvailable = capability?.enabled === 1;",
    "return resolveMichelinImportStrategy(",
    "sqliteUriAvailable,",
  ],
  "Michelin URI capability gate",
);
assert.doesNotMatch(
  resolutionSource,
  /sqliteUriAvailable\s*=\s*true/,
  "URI mode must only be enabled by the runtime compile-option result",
);

const dedicatedConnectionSource = section(
  michelinDatabaseSource,
  "async function openDedicatedMichelinImportConnection(",
  "function assertSafeMichelinSource(",
  "dedicated Michelin import connection",
);
assert.match(dedicatedConnectionSource, /const mainDatabase = await getDatabase\(\);/);
assert.match(dedicatedConnectionSource, /return SQLite\.openDatabaseAsync\(/);
assert.match(dedicatedConnectionSource, /useNewConnection:\s*true/);
assert.match(dedicatedConnectionSource, /enableChangeListener:\s*false/);
assert.match(dedicatedConnectionSource, /finalizeUnusedStatementsBeforeClosing:\s*false/);

const SOURCE_URI_SUFFIX = "?mode=ro&immutable=1&cache=private";
const referenceMaterializationSource = section(
  michelinServiceSource,
  "async function getMichelinReferenceFile()",
  "/**\n * Prepare the source descriptor used by the set-based importer.",
  "Michelin reference materialization",
);
assert.match(
  referenceMaterializationSource,
  /const expectedMd5 = \(asset\.hash \?\? source\.md5\)\?\.toLowerCase\(\);/,
);
assert.match(referenceMaterializationSource, /\/\^\[0-9a-f\]\{32\}\$\/\.test\(expectedMd5\)/);
assert.match(
  referenceMaterializationSource,
  /const staging = new File\(Paths\.document, `\$\{destination\.name\}\.partial`\);/,
);
assert.match(
  referenceMaterializationSource,
  /destination\.exists && destination\.md5\?\.toLowerCase\(\) !== expectedMd5/,
);
assert.match(referenceMaterializationSource, /await source\.copy\(staging\);/);
assert.match(referenceMaterializationSource, /staging\.md5\?\.toLowerCase\(\) !== expectedMd5/);
assert.match(referenceMaterializationSource, /await staging\.move\(destination\);/);
assert.match(referenceMaterializationSource, /if \(!published && staging\.exists\) \{\s*staging\.delete\(\);\s*\}/);
assertOrdered(
  referenceMaterializationSource,
  [
    "const expectedMd5 = (asset.hash ?? source.md5)?.toLowerCase();",
    "const destination = new File(",
    "const staging = new File(",
    "destination.exists && destination.md5?.toLowerCase() !== expectedMd5",
    "destination.delete();",
    "if (staging.exists) {",
    "staging.delete();",
    "if (!destination.exists) {",
    "let published = false;",
    "await source.copy(staging);",
    "staging.md5?.toLowerCase() !== expectedMd5",
    "await staging.move(destination);",
    "published = true;",
    "if (!published && staging.exists) {",
    "staging.delete();",
  ],
  "verified atomic Michelin reference publication",
);
assert.doesNotMatch(
  referenceMaterializationSource,
  /source\.copy\(destination\)/,
  "the bundled guide must never be copied directly onto the published destination",
);

const preparedSource = section(
  michelinServiceSource,
  "export async function prepareMichelinImportSource(",
  "/**\n * Get or initialize the Michelin database connection.",
  "prepared Michelin source descriptor",
);
assert.match(preparedSource, /source\.uri\.startsWith\(["']file:["']\)/);
assert.match(preparedSource, /\/\[\?#\]\/\.test\(source\.uri\)/);
assert.ok(
  preparedSource.includes(`immutableReadOnlyUri: \`\${source.uri}${SOURCE_URI_SUFFIX}\``),
  `the prepared source must append the exact ${SOURCE_URI_SUFFIX} suffix`,
);

const safeSourceAssertion = section(
  michelinDatabaseSource,
  "function assertSafeMichelinSource(",
  "/**\n * Import the guide entirely inside SQLite.",
  "Michelin source safety assertion",
);
assert.match(safeSourceAssertion, /sourcePath\.startsWith\(["']file:["']\)/);
assert.ok(safeSourceAssertion.includes(`requiredUriSuffix = "${SOURCE_URI_SUFFIX}"`));
assert.match(safeSourceAssertion, /immutableReadOnlyUri\.endsWith\(requiredUriSuffix\)/);
assert.match(safeSourceAssertion, /\/\[\?#\]\/\.test\(sourcePath\)/);
assert.match(safeSourceAssertion, /\/\[\\0\\r\\n\]\/\.test\(source\.immutableReadOnlyUri\)/);

const attachedImportSource = section(
  michelinDatabaseSource,
  "export async function importMichelinRestaurantsFromAttachedSource(",
  "export async function getImportedMichelinDatasetVersion(",
  "set-based Michelin importer",
);
assert.match(attachedImportSource, /database = await openDedicatedMichelinImportConnection\(\);/);
assert.match(
  attachedImportSource,
  /database\.runAsync\(\s*`ATTACH DATABASE \? AS michelin_source`,\s*\[source\.immutableReadOnlyUri\],?\s*\)/,
);
assert.doesNotMatch(attachedImportSource, /ATTACH DATABASE\s+\$\{/);
assert.doesNotMatch(attachedImportSource, /ATTACH DATABASE\s+["'`]file:/i);
assertOrdered(
  attachedImportSource,
  [
    "database = await openDedicatedMichelinImportConnection();",
    "ATTACH DATABASE ? AS michelin_source",
    'await database.execAsync("BEGIN IMMEDIATE");',
    "transactionOpen = true;",
    "writeMayHaveOccurred = true;",
    "database.runAsync(ATTACHED_MICHELIN_INSERT_SELECT_SQL, [source.datasetVersion])",
    "const attestation = serializeMichelinImportAttestation({",
    "[MICHELIN_DATASET_VERSION_KEY, source.datasetVersion]",
    "[MICHELIN_IMPORT_ATTESTATION_KEY, attestation]",
    'await database.execAsync("COMMIT");',
    "transactionOpen = false;",
    "committed = true;",
  ],
  "set-based Michelin transaction",
);
assert.equal(
  attachedImportSource.match(/BEGIN IMMEDIATE/g)?.length,
  1,
  "the set-based importer must begin exactly one immediate transaction",
);
assert.equal(attachedImportSource.match(/execAsync\(["']COMMIT["']\)/g)?.length, 1);
assert.match(
  attachedImportSource,
  /throw new MichelinImportTerminalError\(["']Set-based Michelin import failed["'], error\);/,
);
assert.doesNotMatch(attachedImportSource, /\binsertMichelinRestaurants\s*\(/);
assert.doesNotMatch(attachedImportSource, /\bloadMichelinRestaurants\s*\(/);
assert.doesNotMatch(attachedImportSource, /MICHELIN_IMPORT_LEGACY_STRATEGY/);

const postCommitCleanupSource = section(
  attachedImportSource,
  "if (committed) {",
  "invalidateRestaurantIndex();\n  return { importedRows, sourceRows, strategy: MICHELIN_IMPORT_ATTACH_STRATEGY };",
  "post-COMMIT Michelin cleanup",
);
assertOrdered(
  postCommitCleanupSource,
  [
    "const cleanupErrors: unknown[] = [];",
    'await database.execAsync("DETACH DATABASE michelin_source");',
    "catch (error) {",
    "cleanupErrors.push(error);",
    "await database.closeAsync();",
    "catch (error) {",
    "cleanupErrors.push(error);",
    "if (cleanupErrors.length > 0) {",
    "invalidateRestaurantIndex();",
    "throw new MichelinImportTerminalError(",
    '"Set-based Michelin import committed but its connection did not close cleanly",',
    "cleanupErrors,",
  ],
  "terminal post-COMMIT cleanup handling",
);
assert.equal(
  postCommitCleanupSource.match(/cleanupErrors\.push\(error\);/g)?.length,
  2,
  "both DETACH and close failures must be retained as terminal cleanup causes",
);
assert.doesNotMatch(
  postCommitCleanupSource,
  /catch\s*\{[\s\S]*?(?:console\.(?:warn|error)|\/\/\s*(?:ignore|swallow|preserve))/i,
  "post-COMMIT cleanup failures must not be swallowed",
);

const internalInitializationSource = section(
  visitSource,
  "async function initializeMichelinDataInternal(",
  "/**\n * Initialize Michelin restaurant reference data in the database",
  "internal Michelin initialization",
);
const attachedInitializationBranch = section(
  internalInitializationSource,
  "if (resolution.resolvedStrategy === MICHELIN_IMPORT_ATTACH_STRATEGY) {",
  "let sourceRows = 0;",
  "set-based Michelin initialization branch",
);
assertOrdered(
  attachedInitializationBranch,
  [
    "source = await prepareMichelinImportSource();",
    "throw new MichelinImportTerminalError(",
    "const result = await importMichelinRestaurantsFromAttachedSource(source, resolution);",
    "return { loaded: result.importedRows, skipped: false };",
  ],
  "set-based Michelin initialization branch",
);
assert.doesNotMatch(attachedInitializationBranch, /\bloadMichelinRestaurants\s*\(/);
assert.doesNotMatch(attachedInitializationBranch, /\binsertMichelinRestaurants\s*\(/);

assert.match(visitSource, /let michelinInitializationTerminalError:\s*MichelinImportTerminalError \| null = null;/);
const publicInitializationSource = section(
  visitSource,
  "export async function initializeMichelinData(",
  "/**\n * Generate a deterministic hash for a visit",
  "public Michelin initialization",
);
assertOrdered(
  publicInitializationSource,
  [
    "if (michelinInitializationTerminalError) {",
    "throw michelinInitializationTerminalError;",
    "if (!michelinInitializationPromise) {",
    "initializeMichelinDataInternal(emitProgress).catch((error: unknown) => {",
    "if (error instanceof MichelinImportTerminalError) {",
    "michelinInitializationTerminalError = error;",
    "throw error;",
  ],
  "process-terminal Michelin latch",
);
assert.equal(
  visitSource.match(/michelinInitializationTerminalError:\s*MichelinImportTerminalError \| null = null/g)?.length,
  1,
  "the process-terminal latch must be initialized exactly once",
);
assert.doesNotMatch(
  publicInitializationSource,
  /michelinInitializationTerminalError\s*=\s*null/,
  "the public initializer must never clear a terminal error in-process",
);

console.log("Michelin import production wiring tests passed");
