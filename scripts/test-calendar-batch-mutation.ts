import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildNativeCalendarExportRequests,
  executeCalendarCreateMutations,
  executeCalendarDeleteMutations,
  planCalendarExportClearStatements,
  selectCalendarMutationSuccessfulItems,
  validateNativeCalendarMutationResults,
  type CalendarExportMutationVisit,
  type NativeCalendarMutationResult,
} from "../utils/calendar-batch-mutation-core.ts";

function nativeResult(
  inputIndex: number,
  requestId: string,
  status: NativeCalendarMutationResult["status"],
  eventId: string | null = null,
): NativeCalendarMutationResult {
  return { inputIndex, requestId, status, eventId, errorCode: status === "failed" ? "test" : null, errorMessage: null };
}

const visits: CalendarExportMutationVisit[] = [
  {
    id: "visit-雪's",
    restaurantName: "L’Atelier 雪",
    startTime: 1_720_000_000_000,
    endTime: 1_720_007_200_000,
    address: null,
    notes: null,
  },
  {
    id: "visit-b",
    restaurantName: "Chez O'Brien",
    startTime: 1_730_000_000_000,
    endTime: 1_730_003_600_000,
    address: "1 Rue de l’Été",
    notes: "Chef’s counter",
  },
];

async function testRequestBuildingAndDuplicateGuard(): Promise<void> {
  const requests = buildNativeCalendarExportRequests(visits);
  assert.deepEqual(requests, [
    {
      requestId: "visit-雪's",
      title: "L’Atelier 雪",
      startMs: 1_720_000_000_000,
      endMs: 1_720_007_200_000,
      location: null,
      notes: "[Palate Export] Visit ID: visit-雪's",
    },
    {
      requestId: "visit-b",
      title: "Chez O'Brien",
      startMs: 1_730_000_000_000,
      endMs: 1_730_003_600_000,
      location: "1 Rue de l’Été",
      notes: "Chef’s counter\n\n[Palate Export] Visit ID: visit-b",
    },
  ]);

  const calls = { native: 0, permission: 0, timeZone: 0, expo: 0 };
  await assert.rejects(
    executeCalendarCreateMutations([visits[0]!, { ...visits[1]!, id: visits[0]!.id }], "calendar", {
      invokeNative: async () => {
        calls.native++;
        return [];
      },
      hasCalendarPermission: async () => {
        calls.permission++;
        return true;
      },
      getTimeZone: () => {
        calls.timeZone++;
        return "America/Los_Angeles";
      },
      createWithExpo: async () => {
        calls.expo++;
        return "event";
      },
    }),
    /duplicate visit ID/,
  );
  assert.deepEqual(calls, { native: 0, permission: 0, timeZone: 0, expo: 0 });
}

async function testNativeCreateRoutingAndValidation(): Promise<void> {
  const calls = { native: 0, permission: 0, timeZone: 0, expo: 0 };
  let capturedCalendarId = "";
  let capturedTimeZone = "";
  let capturedRequests: readonly { requestId: string }[] = [];
  const result = await executeCalendarCreateMutations(visits, "calendar-雪", {
    invokeNative: async (calendarId, timeZone, requests) => {
      calls.native++;
      capturedCalendarId = calendarId;
      capturedTimeZone = timeZone;
      capturedRequests = requests;
      // Deliberately return out of order; inputIndex makes the mapping exact.
      return [nativeResult(1, "visit-b", "failed"), nativeResult(0, "visit-雪's", "created", "event-雪")];
    },
    hasCalendarPermission: async () => {
      calls.permission++;
      return true;
    },
    getTimeZone: () => {
      calls.timeZone++;
      return "America/Los_Angeles";
    },
    createWithExpo: async () => {
      calls.expo++;
      return "should-not-run";
    },
  });

  assert.deepEqual(calls, { native: 1, permission: 0, timeZone: 1, expo: 0 });
  assert.equal(capturedCalendarId, "calendar-雪");
  assert.equal(capturedTimeZone, "America/Los_Angeles");
  assert.deepEqual(
    capturedRequests.map(({ requestId }) => requestId),
    ["visit-雪's", "visit-b"],
  );
  assert.deepEqual(result.createdItems, [{ inputIndex: 0, visitId: "visit-雪's", eventId: "event-雪" }]);
  assert.deepEqual(result.failedInputIndices, [1]);

  let fallbackCalls = 0;
  const nativeFailure = new Error("native commit uncertain");
  await assert.rejects(
    executeCalendarCreateMutations(visits, "calendar", {
      invokeNative: async () => {
        throw nativeFailure;
      },
      hasCalendarPermission: async () => {
        fallbackCalls++;
        return true;
      },
      getTimeZone: () => "UTC",
      createWithExpo: async () => {
        fallbackCalls++;
        return "duplicate-risk";
      },
    }),
    (error) => error === nativeFailure,
  );
  assert.equal(fallbackCalls, 0, "a rejected native mutation must never fall back to Expo");

  await assert.rejects(
    executeCalendarCreateMutations(visits, "calendar", {
      invokeNative: async () => [
        nativeResult(0, "visit-雪's", "created", "event-a"),
        nativeResult(0, "visit-b", "failed"),
      ],
      hasCalendarPermission: async () => true,
      getTimeZone: () => "UTC",
      createWithExpo: async () => "never",
    }),
    /duplicate inputIndex 0/,
  );
}

async function testExpoCreateFallback(): Promise<void> {
  const calls = { permission: 0, timeZone: 0, expo: 0, errors: [] as number[] };
  const capturedRequests: string[] = [];
  const result = await executeCalendarCreateMutations(visits, "fallback-calendar", {
    hasCalendarPermission: async () => {
      calls.permission++;
      return true;
    },
    getTimeZone: () => {
      calls.timeZone++;
      return "Europe/Paris";
    },
    createWithExpo: async (calendarId, timeZone, request) => {
      calls.expo++;
      assert.equal(calendarId, "fallback-calendar");
      assert.equal(timeZone, "Europe/Paris");
      capturedRequests.push(request.requestId);
      if (request.requestId === "visit-b") {
        throw new Error("per-item failure");
      }
      return "fallback-event";
    },
    onExpoError: (_error, inputIndex) => calls.errors.push(inputIndex),
  });
  assert.deepEqual(calls, { permission: 1, timeZone: 1, expo: 2, errors: [1] });
  assert.deepEqual(capturedRequests, ["visit-雪's", "visit-b"]);
  assert.deepEqual(result.createdItems, [{ inputIndex: 0, visitId: "visit-雪's", eventId: "fallback-event" }]);
  assert.deepEqual(result.failedInputIndices, [1]);

  let deniedExpoCalls = 0;
  let deniedTimeZoneCalls = 0;
  const denied = await executeCalendarCreateMutations(visits, "calendar", {
    hasCalendarPermission: async () => false,
    getTimeZone: () => {
      deniedTimeZoneCalls++;
      return "UTC";
    },
    createWithExpo: async () => {
      deniedExpoCalls++;
      return "never";
    },
  });
  assert.deepEqual(denied.failedInputIndices, [0, 1]);
  assert.equal(deniedExpoCalls, 0);
  assert.equal(deniedTimeZoneCalls, 0);
}

async function testDeleteRoutingAndExactSelection(): Promise<void> {
  const eventIds = ["event-a", "event-b", "event-c"];
  const calls = { native: 0, permission: 0, expo: 0 };
  const result = await executeCalendarDeleteMutations(eventIds, {
    invokeNative: async (requests) => {
      calls.native++;
      assert.deepEqual(
        requests.map(({ requestId, eventId, instanceStartMs, futureEvents }) => ({
          requestId,
          eventId,
          instanceStartMs,
          futureEvents,
        })),
        [
          { requestId: "calendar-delete-0", eventId: "event-a", instanceStartMs: null, futureEvents: false },
          { requestId: "calendar-delete-1", eventId: "event-b", instanceStartMs: null, futureEvents: false },
          { requestId: "calendar-delete-2", eventId: "event-c", instanceStartMs: null, futureEvents: false },
        ],
      );
      return [
        nativeResult(2, "calendar-delete-2", "deleted", "event-c"),
        nativeResult(0, "calendar-delete-0", "alreadyAbsent", "event-a"),
        nativeResult(1, "calendar-delete-1", "failed"),
      ];
    },
    hasCalendarPermission: async () => {
      calls.permission++;
      return true;
    },
    deleteWithExpo: async () => {
      calls.expo++;
    },
  });
  assert.deepEqual(calls, { native: 1, permission: 0, expo: 0 });
  assert.deepEqual(result.successfulInputIndices, [0, 2]);
  assert.deepEqual(result.alreadyAbsentInputIndices, [0]);
  assert.deepEqual(result.failedInputIndices, [1]);

  const exportedRows = [
    { visitId: "visit-a", eventId: "event-a" },
    { visitId: "visit-b", eventId: "event-b" },
    { visitId: "visit-c", eventId: "event-c" },
  ];
  assert.deepEqual(
    selectCalendarMutationSuccessfulItems(exportedRows, result.successfulInputIndices).map(({ visitId }) => visitId),
    ["visit-a", "visit-c"],
    "an interspersed failure must not be treated as a successful prefix",
  );

  let fallbackCalls = 0;
  await assert.rejects(
    executeCalendarDeleteMutations(eventIds, {
      invokeNative: async () => {
        throw new Error("native deletion uncertain");
      },
      hasCalendarPermission: async () => {
        fallbackCalls++;
        return true;
      },
      deleteWithExpo: async () => {
        fallbackCalls++;
      },
    }),
    /native deletion uncertain/,
  );
  assert.equal(fallbackCalls, 0);
}

async function testExpoDeleteFallback(): Promise<void> {
  const calls = { permission: 0, expo: 0, errors: [] as number[] };
  const result = await executeCalendarDeleteMutations(["a", "b", "c"], {
    hasCalendarPermission: async () => {
      calls.permission++;
      return true;
    },
    deleteWithExpo: async (request) => {
      calls.expo++;
      if (request.eventId === "b") {
        throw new Error("cannot delete b");
      }
    },
    onExpoError: (_error, inputIndex) => calls.errors.push(inputIndex),
  });
  assert.deepEqual(calls, { permission: 1, expo: 3, errors: [1] });
  assert.deepEqual(result.successfulInputIndices, [0, 2]);
  assert.deepEqual(result.failedInputIndices, [1]);

  let deniedCalls = 0;
  const denied = await executeCalendarDeleteMutations(["a", "b"], {
    hasCalendarPermission: async () => false,
    deleteWithExpo: async () => {
      deniedCalls++;
    },
  });
  assert.deepEqual(denied.failedInputIndices, [0, 1]);
  assert.equal(deniedCalls, 0);
}

function testStandaloneResultValidation(): void {
  assert.throws(
    () =>
      validateNativeCalendarMutationResults(
        [{ requestId: "duplicate" }, { requestId: "duplicate" }],
        [nativeResult(0, "duplicate", "deleted"), nativeResult(1, "duplicate", "deleted")],
        "delete",
      ),
    /duplicate request ID/,
  );
  assert.throws(
    () => validateNativeCalendarMutationResults([{ requestId: "a" }], [nativeResult(0, "wrong", "deleted")], "delete"),
    /expected "a"/,
  );
  assert.throws(() => selectCalendarMutationSuccessfulItems(["a"], [1]), /invalid successful inputIndex 1/);
}

function testClearStatementPlanningAndExecution(): void {
  const largeIds = Array.from({ length: 68_027 }, (_, index) => `visit-${index}`);
  const statements = planCalendarExportClearStatements(largeIds, 123_456);
  assert.equal(statements.length, 137);
  assert.equal(statements.at(-1)?.visitCount, 27);
  assert.ok(statements.every((statement) => statement.parameters.length <= 501));
  assert.ok(statements.every((statement) => statement.parameters[0] === 123_456));
  assert.deepEqual(
    statements.flatMap((statement) => statement.parameters.slice(1)),
    largeIds,
  );

  const deduplicated = planCalendarExportClearStatements(["visit-a", "visit-b", "visit-a"], 99);
  assert.equal(deduplicated.length, 1);
  assert.deepEqual(deduplicated[0]?.parameters, [99, "visit-a", "visit-b"]);

  const database = new DatabaseSync(":memory:");
  database.exec(`CREATE TABLE visits (
    id TEXT PRIMARY KEY,
    calendarEventId TEXT,
    calendarEventTitle TEXT,
    exportedToCalendarId TEXT,
    updatedAt INTEGER
  )`);
  const insert = database.prepare("INSERT INTO visits VALUES (?, 'event', 'title', 'calendar', 1)");
  for (let index = 0; index < 1_002; index++) {
    insert.run(`visit-${index}`);
  }
  database.exec("BEGIN");
  try {
    for (const statement of planCalendarExportClearStatements(largeIds.slice(0, 1_001), 777)) {
      database.prepare(statement.sql).run(...statement.parameters);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  const cleared = database
    .prepare(
      `SELECT COUNT(*) AS count FROM visits
       WHERE calendarEventId IS NULL AND calendarEventTitle IS NULL
         AND exportedToCalendarId IS NULL AND updatedAt = 777`,
    )
    .get() as { count: number };
  assert.equal(cleared.count, 1_001);
  assert.deepEqual(
    { ...database.prepare("SELECT * FROM visits WHERE id = 'visit-1001'").get() },
    {
      id: "visit-1001",
      calendarEventId: "event",
      calendarEventTitle: "title",
      exportedToCalendarId: "calendar",
      updatedAt: 1,
    },
  );
  database.close();
}

async function main(): Promise<void> {
  await testRequestBuildingAndDuplicateGuard();
  await testNativeCreateRoutingAndValidation();
  await testExpoCreateFallback();
  await testDeleteRoutingAndExactSelection();
  await testExpoDeleteFallback();
  testStandaloneResultValidation();
  testClearStatementPlanningAndExecution();
  console.log("Calendar batch mutation tests passed.");
}

await main();
