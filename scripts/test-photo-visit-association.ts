#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildPhotoVisitAssociationStatement,
  flattenPhotoVisitAssociations,
  LEGACY_PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
  PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
  type PhotoVisitAssociation,
} from "../utils/db/photo-association-core.ts";

const flattened = flattenPhotoVisitAssociations([
  { photoIds: ["photo-a", "photo's", "写真-1"], visitId: "visit-one" },
  { photoIds: ["photo-a", "missing-photo", "photo-b"], visitId: "visit-two" },
]);

assert.deepEqual(flattened, [
  { photoId: "photo-a", visitId: "visit-one" },
  { photoId: "photo's", visitId: "visit-one" },
  { photoId: "写真-1", visitId: "visit-one" },
  { photoId: "missing-photo", visitId: "visit-two" },
  { photoId: "photo-b", visitId: "visit-two" },
]);
assert.deepEqual(flattenPhotoVisitAssociations([]), []);
assert.deepEqual(flattenPhotoVisitAssociations([{ photoIds: [], visitId: "visit" }]), []);
assert.throws(() => flattenPhotoVisitAssociations([], 0), /positive integer/);

const legacyBoundaryAssociations = flattenPhotoVisitAssociations([
  {
    photoIds: [
      "repeated-across-boundary",
      ...Array.from({ length: LEGACY_PHOTO_VISIT_ASSOCIATION_BATCH_SIZE - 1 }, (_, index) => `padding-${index}`),
    ],
    visitId: "visit-before-boundary",
  },
  { photoIds: ["repeated-across-boundary"], visitId: "visit-first-in-final-batch" },
  { photoIds: ["repeated-across-boundary"], visitId: "visit-later-in-final-batch" },
]);
assert.equal(
  legacyBoundaryAssociations.find(({ photoId }) => photoId === "repeated-across-boundary")?.visitId,
  "visit-first-in-final-batch",
);

assert.throws(() => buildPhotoVisitAssociationStatement([]), /At least one photo association/);
assert.throws(
  () =>
    buildPhotoVisitAssociationStatement(
      Array.from({ length: PHOTO_VISIT_ASSOCIATION_BATCH_SIZE + 1 }, (_, index) => ({
        photoId: `photo-${index}`,
        visitId: "visit",
      })),
    ),
  /cannot exceed/,
);

const database = new DatabaseSync(":memory:");
database.exec(`
  CREATE TABLE photos (
    id TEXT PRIMARY KEY,
    visitId TEXT,
    untouched TEXT NOT NULL
  );
`);
const insert = database.prepare("INSERT INTO photos (id, visitId, untouched) VALUES (?, ?, ?)");
for (const photoId of ["photo-a", "photo's", "写真-1", "photo-b", "unmapped"]) {
  insert.run(photoId, null, `sentinel:${photoId}`);
}

function applyAssociations(associations: readonly PhotoVisitAssociation[]): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (let offset = 0; offset < associations.length; offset += PHOTO_VISIT_ASSOCIATION_BATCH_SIZE) {
      const statement = buildPhotoVisitAssociationStatement(
        associations.slice(offset, offset + PHOTO_VISIT_ASSOCIATION_BATCH_SIZE),
      );
      assert.ok(!statement.sql.includes("photo's"), "IDs must remain bound parameters");
      database.prepare(statement.sql).run(...statement.parameters);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

applyAssociations(flattened);

assert.deepEqual(
  database
    .prepare("SELECT id, visitId, untouched FROM photos ORDER BY id")
    .all()
    .map((row) => ({ ...row })),
  [
    { id: "photo's", visitId: "visit-one", untouched: "sentinel:photo's" },
    { id: "photo-a", visitId: "visit-one", untouched: "sentinel:photo-a" },
    { id: "photo-b", visitId: "visit-two", untouched: "sentinel:photo-b" },
    { id: "unmapped", visitId: null, untouched: "sentinel:unmapped" },
    { id: "写真-1", visitId: "visit-one", untouched: "sentinel:写真-1" },
  ],
);

database.close();
console.log("Photo-visit association tests passed.");
