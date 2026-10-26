#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const database = new DatabaseSync(":memory:");
database.exec(`
  CREATE TABLE visits (id TEXT PRIMARY KEY, foodProbable INTEGER NOT NULL, notes TEXT);
  CREATE TABLE photos (id TEXT PRIMARY KEY, visitId TEXT, foodDetected INTEGER);
  CREATE INDEX idx_photos_visit ON photos(visitId);
  CREATE TABLE updated_visits (id TEXT);
  CREATE TRIGGER record_summary_update AFTER UPDATE OF foodProbable ON visits
    BEGIN INSERT INTO updated_visits VALUES (NEW.id); END;
  INSERT INTO visits VALUES
    ('positive', 0, 'keep positive'),
    ('negative', 1, 'keep negative'),
    ('unknown', 1, 'keep unknown'),
    ('outside-batch-positive', 0, 'keep other photo'),
    ('untouched', 1, 'keep unrelated'),
    ('empty', 1, 'keep empty');
  INSERT INTO photos VALUES
    ('positive-photo', 'positive', 1),
    ('negative-photo', 'negative', 0),
    ('unknown-photo', 'unknown', NULL),
    ('batch-negative-photo', 'outside-batch-positive', 0),
    ('earlier-positive-photo', 'outside-batch-positive', 1),
    ('unrelated-photo', 'untouched', 0),
    ('unassigned-photo', NULL, 1);
`);

let acquisitions = 0;
const statements: Array<{ sql: string; parameters: readonly SQLInputValue[] }> = [];
const adapter = {
  async runAsync(sql: string, parameters: readonly SQLInputValue[] = []) {
    statements.push({ sql, parameters });
    return database.prepare(sql).run(...parameters);
  },
};
interface SummaryApi {
  syncAllVisitsFoodProbable(): Promise<void>;
  syncVisitsFoodProbableForPhotos(photoIds: readonly string[]): Promise<void>;
}
const exports: Partial<SummaryApi> = {};
const compiled = ts.transpileModule(readFileSync(new URL("../utils/db/visits.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
runInNewContext(compiled, {
  exports,
  require: (name: string) =>
    name === "./core"
      ? {
          getDatabase: async () => {
            acquisitions++;
            return adapter;
          },
        }
      : {},
});
const { syncVisitsFoodProbableForPhotos, syncAllVisitsFoodProbable } = exports;
assert.ok(syncVisitsFoodProbableForPhotos && syncAllVisitsFoodProbable);

function summary(id: string): SQLInputValue | undefined {
  return database.prepare("SELECT foodProbable FROM visits WHERE id = ?").get(id)?.foodProbable;
}

await syncVisitsFoodProbableForPhotos([]);
assert.equal(acquisitions, 0, "an empty batch must not initialize or write the database");
assert.equal(statements.length, 0);

const batch = [
  "positive-photo",
  "negative-photo",
  "unknown-photo",
  "batch-negative-photo",
  "positive-photo",
  "unassigned-photo",
  "deleted-photo",
] as const;
await syncVisitsFoodProbableForPhotos(batch);
assert.equal(statements.length, 1, "the affected summaries must update in one atomic statement");
assert.equal(summary("positive"), 1);
assert.equal(summary("negative"), 0);
assert.equal(summary("unknown"), 0, "all-unknown photos use the full-sync zero fallback");
assert.equal(summary("outside-batch-positive"), 1, "MAX must include earlier photos outside this batch");
assert.equal(summary("untouched"), 1, "unrelated stale summaries must remain untouched");
assert.equal(summary("empty"), 1, "visits not owning batch photos must remain untouched");
assert.deepEqual(
  database
    .prepare("SELECT id FROM updated_visits ORDER BY id")
    .all()
    .map((row) => row.id),
  ["negative", "outside-batch-positive", "positive", "unknown"],
  "duplicate IDs and multiple photos must not repeatedly update a visit",
);
assert.equal(database.prepare("SELECT notes FROM visits WHERE id = 'positive'").get()?.notes, "keep positive");

const [statement] = statements;
const plan = database.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.parameters);
const details = plan.map((row) => String(row.detail));
assert.ok(
  details.some((detail) => /SEARCH visits USING (?:COVERING )?INDEX/.test(detail)),
  "visit IDs must use the primary key",
);
assert.ok(
  details.some((detail) => /SEARCH photos USING INDEX .*\(id=\?\)/.test(detail)),
  "batch IDs must use the photo primary key",
);
assert.ok(
  details.some((detail) => /SEARCH photos USING INDEX idx_photos_visit/.test(detail)),
  "summary aggregation must use the visit index",
);

database.exec("DELETE FROM updated_visits");
await syncVisitsFoodProbableForPhotos(["deleted-photo", "unassigned-photo"]);
assert.equal(database.prepare("SELECT COUNT(*) AS count FROM updated_visits").get()?.count, 0);

database.exec("UPDATE photos SET foodDetected = 0 WHERE id = 'earlier-positive-photo'");
await syncVisitsFoodProbableForPhotos(["earlier-positive-photo"]);
assert.equal(summary("outside-batch-positive"), 0, "a later negative result can clear the last positive");

const affected = ["positive", "negative", "unknown", "outside-batch-positive"];
const incrementalSummaries = affected.map(summary);
await syncAllVisitsFoodProbable();
assert.deepEqual(affected.map(summary), incrementalSummaries, "batch summaries must match full synchronization");
assert.equal(summary("untouched"), 0, "the full sync confirms the unrelated fixture was deliberately stale");

database.close();
console.log("Visit food summary batch synchronization tests passed.");
