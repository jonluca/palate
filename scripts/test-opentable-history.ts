import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type * as OpenTableApi from "../services/opentable.ts";
import type { JsonRecord } from "../services/reservation-import.ts";

// Run the production normalizer and primitive decoders without loading native
// database or network dependencies that normalization never uses.
const helperSource = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
const syntax = ts.createSourceFile("reservation-import.ts", helperSource, ts.ScriptTarget.Latest, true);
const helperNames = new Set([
  "DEFAULT_VISIT_DURATION_MS",
  "isJsonRecord",
  "isNonEmptyString",
  "isFiniteJsonNumber",
  "asRecord",
  "getPath",
  "getString",
  "getNumber",
  "hashString",
  "sanitizeIdPart",
  "compactAddress",
  "defaultReservationEndTime",
]);
const helperDeclarations = syntax.statements
  .filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) {
      return statement.name !== undefined && helperNames.has(statement.name.text);
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && helperNames.has(declaration.name.text),
      )
    );
  })
  .map((statement) => statement.getText(syntax))
  .join("\n");
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
const helpers = {};
runInNewContext(ts.transpileModule(helperDeclarations, { compilerOptions }).outputText, { exports: helpers });
const exports: Partial<typeof OpenTableApi> = {};
runInNewContext(
  ts.transpileModule(readFileSync(new URL("../services/opentable.ts", import.meta.url), "utf8"), { compilerOptions })
    .outputText,
  {
    exports,
    __DEV__: false,
    require(name: string) {
      assert.equal(name, "@/services/reservation-import");
      return helpers;
    },
  },
);
assert.ok(exports.normalizeOpenTableVisitHistory);
const normalize = exports.normalizeOpenTableVisitHistory;
const booking = {
  id: "fixture",
  restaurantName: "Neighborhood Cafe",
  startTime: "2025-01-03T19:30:00Z",
  restaurantId: "venue-1",
};

for (const key of ["reservation", "booking", "restaurantReservation"]) {
  for (const cancellation of [
    { status: "Canceled" },
    { state: "Cancelled" },
    { canceled: true },
    { cancelled: true },
    { isCanceled: true },
    { isCancelled: true },
  ] satisfies JsonRecord[]) {
    const history = normalize([{ ...cancellation, [key]: booking }]);
    assert.equal(history.reservations.length, 0, `Canceled ${key} must not be imported from its nested record`);
  }
}

const active = normalize({ data: { reservations: [{ status: "Confirmed", reservation: booking }] } });
assert.equal(active.reservations.length, 1, "Active nested reservations remain discoverable");
assert.equal(active.reservations[0]?.sourceEventId, "opentable:fixture");
assert.equal(active.reservations[0]?.startTime, Date.parse(booking.startTime));
const mixed = normalize({
  items: [
    { canceled: true, booking },
    { ...booking, id: "active" },
  ],
});
assert.equal(mixed.reservations.length, 1, "A canceled booking must not suppress an active sibling");
assert.equal(mixed.reservations[0]?.sourceEventId, "opentable:active");

console.log("OpenTable history passed: canceled nested reservations, active nested records, and mixed histories.");
