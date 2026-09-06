import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import tzLookup from "tz-lookup";
import * as resyTime from "../services/resy-time.ts";
import type { NormalizedReservationHistory, JsonValue } from "../services/reservation-import.ts";

function checkTime(value: string, day: string | null, zone: string, expected: string | null, after?: string) {
  assert.equal(
    resyTime.parseResyTime(value, day, zone, after ? Date.parse(after) : undefined),
    expected === null ? null : Date.parse(expected),
    `${value} in ${zone} under device timezone ${process.env.TZ}`,
  );
}

async function testCurrentDeviceTimeZone(): Promise<void> {
  checkTime("19:00:00", "2026-07-01", "America/New_York", "2026-07-01T23:00:00Z");
  checkTime("19:00", "2026-01-01", "America/New_York", "2026-01-02T00:00:00Z");
  checkTime("2026-07-01 19:00:00.123", null, "Asia/Kathmandu", "2026-07-01T13:15:00.123Z");
  checkTime("2026-01-01T19:00:00", null, "Australia/Lord_Howe", "2026-01-01T08:00:00Z");
  checkTime("2026-07-01T19:00:00", null, "Australia/Lord_Howe", "2026-07-01T08:30:00Z");
  checkTime("00:00", "2026-01-01", "America/New_York", "2026-01-01T05:00:00Z");
  checkTime("2026-07-01T19:00:00Z", null, "America/New_York", "2026-07-01T19:00:00Z");
  checkTime("2026-07-01T19:00:00+05:30", null, "America/New_York", "2026-07-01T13:30:00Z");
  checkTime("2026-07-01T19:00:00-0400", null, "Asia/Tokyo", "2026-07-01T23:00:00Z");
  checkTime("2026-07-01T19:00:00.123456Z", null, "Asia/Tokyo", "2026-07-01T19:00:00.123Z");
  checkTime("01:00-0500", "2026-12-31", "America/New_York", "2027-01-01T06:00:00Z", "2027-01-01T04:30:00Z");
  checkTime("02:30", "2026-03-08", "America/New_York", null);
  checkTime("01:30", "2026-11-01", "America/New_York", "2026-11-01T05:30:00Z");
  checkTime("02:15", "2026-10-04", "Australia/Lord_Howe", null);
  checkTime("01:45", "2026-04-05", "Australia/Lord_Howe", "2026-04-04T14:45:00Z");
  checkTime("01:30", "2026-11-01", "America/New_York", "2026-11-01T06:30:00Z", "2026-11-01T05:45:00Z");
  checkTime("01:00", "2026-12-31", "America/New_York", "2027-01-01T06:00:00Z", "2027-01-01T04:30:00Z");
  checkTime("2026-12-31T01:00", null, "America/New_York", null, "2027-01-01T04:30:00Z");
  checkTime("19:00", "2026-07-01", "America/New_York", null, "2026-07-01T23:00:00Z");
  checkTime("02:30", "2026-03-08", "America/New_York", null, "2026-03-08T06:00:00Z");
  for (const invalid of ["2026-02-30T19:00", "2026-13-01T19:00", "2026-07-01T25:00", "2026-07-01T19:60", "bad"]) {
    checkTime(invalid, null, "America/New_York", null);
  }
  checkTime("2024-02-29T19:00", null, "UTC", "2024-02-29T19:00:00Z");
  assert.equal(resyTime.getResyLocalDate(Date.parse("2027-01-01T04:30Z"), "America/New_York"), "2026-12-31");

  // Execute the production API normalization with real primitive decoders and
  // only replace network I/O. This exercises venue lookup, IDs, and invalid rows.
  const helperSource = readFileSync(new URL("../services/reservation-import.ts", import.meta.url), "utf8");
  const syntax = ts.createSourceFile("reservation-import.ts", helperSource, ts.ScriptTarget.Latest, true);
  const helperNames = new Set([
    "DEFAULT_VISIT_DURATION_MS",
    "ReservationApiError",
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
    "parseTimestamp",
    "defaultReservationEndTime",
  ]);
  const helperDeclarations = syntax.statements
    .filter((statement) => {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
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
  const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
  const helpers = {};
  runInNewContext(ts.transpileModule(helperDeclarations, { compilerOptions }).outputText, { exports: helpers });

  const payload: JsonValue = {
    reservations: [
      { id: "summer", venue_id: "nyc", day: "2026-07-01", time_slot: "19:00:00", end_time: "21:15" },
      { id: "winter", venue_id: "nyc", day: "2026-01-01", time_slot: "19:00:00" },
      { id: "absolute", venue_id: "nyc", time_slot: "2026-07-01T19:00:00Z" },
      { id: "overnight", venue_id: "nyc", day: "2026-12-31", time_slot: "23:30", end_time: "01:00" },
      { id: "gap", venue_id: "nyc", day: "2026-03-08", time_slot: "02:30" },
      { id: "invalid-date", venue_id: "nyc", day: "2026-02-30", time_slot: "19:00" },
      { id: "invalid-coordinates", venue_id: "bad", day: "2026-07-01", time_slot: "19:00" },
    ],
    venues: {
      nyc: { id: { resy: "nyc" }, name: "New York Fixture", location: { latitude: 40.73, longitude: -73.99 } },
      bad: { id: { resy: "bad" }, name: "Invalid Fixture", location: { latitude: 95, longitude: 0 } },
    },
    metadata: { total: 7 },
  };
  interface ResyApi {
    fetchResyVisitHistory?: (token: string) => Promise<NormalizedReservationHistory>;
  }
  const api: ResyApi = {};
  const modules = new Map<string, object>([
    ["@/services/reservation-import", helpers],
    ["./resy-time", resyTime],
    ["tz-lookup", tzLookup],
  ]);
  let requests = 0;
  runInNewContext(
    ts.transpileModule(readFileSync(new URL("../services/resy.ts", import.meta.url), "utf8"), { compilerOptions })
      .outputText,
    {
      exports: api,
      URL,
      fetch: async () => {
        requests++;
        return new Response(JSON.stringify(payload));
      },
      require(name: string) {
        const module = modules.get(name);
        assert.ok(module, `Unexpected Resy dependency: ${name}`);
        return module;
      },
    },
  );
  assert.ok(api.fetchResyVisitHistory);
  const history = await api.fetchResyVisitHistory("test-token");
  assert.equal(requests, 1);
  assert.equal(history.fetchedCount, 7);
  assert.equal(history.invalidCount, 3);
  const bySource = new Map(history.reservations.map((reservation) => [reservation.sourceEventId, reservation]));
  assert.equal(bySource.get("resy:summer")?.startTime, Date.parse("2026-07-01T23:00Z"));
  assert.equal(bySource.get("resy:summer")?.endTime, Date.parse("2026-07-02T01:15Z"));
  assert.equal(bySource.get("resy:winter")?.startTime, Date.parse("2026-01-02T00:00Z"));
  assert.equal(bySource.get("resy:winter")?.endTime, Date.parse("2026-01-02T02:00Z"));
  assert.equal(bySource.get("resy:absolute")?.startTime, Date.parse("2026-07-01T19:00Z"));
  assert.equal(bySource.get("resy:overnight")?.endTime, Date.parse("2027-01-01T06:00Z"));
}

if (process.argv.includes("--timezone-child")) {
  await testCurrentDeviceTimeZone();
} else {
  for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
    const child = spawnSync(
      process.execPath,
      ["--no-warnings", "--experimental-strip-types", fileURLToPath(import.meta.url), "--timezone-child"],
      {
        encoding: "utf8",
        env: { ...process.env, TZ: timeZone },
      },
    );
    assert.equal(child.status, 0, `${timeZone}\n${child.stdout}\n${child.stderr}`);
  }
  console.log(
    "Resy timezone tests passed: device independence, venue normalization, explicit offsets, DST, overnight ends, and invalid rows.",
  );
}
