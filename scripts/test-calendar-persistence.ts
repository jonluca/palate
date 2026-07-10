#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  buildCalendarEventPersistenceStatement,
  buildCalendarExportPersistenceStatement,
  CALENDAR_PERSISTENCE_BATCH_SIZE,
  coalesceCalendarEventUpdates,
  coalesceCalendarExportUpdates,
  type CalendarExportUpdate,
} from "../utils/db/calendar-persistence-core.ts";
import type { CalendarEventUpdate } from "../utils/db/types.ts";

const enrichmentUpdates: CalendarEventUpdate[] = [
  {
    visitId: "visit-a",
    calendarEventId: "event-a-first",
    calendarEventTitle: "First title",
    calendarEventLocation: "First location",
    calendarEventIsAllDay: false,
  },
  {
    visitId: "visit-b",
    calendarEventId: "event-b",
    calendarEventTitle: "Lunch",
    calendarEventLocation: null,
    calendarEventIsAllDay: false,
  },
  {
    visitId: "visit-a",
    calendarEventId: "event-a-final",
    calendarEventTitle: "Final title",
    calendarEventLocation: "Final location",
    calendarEventIsAllDay: true,
  },
  {
    visitId: "visit-雪's",
    calendarEventId: "event-雪-'quoted'",
    calendarEventTitle: "寿司 🍣",
    calendarEventLocation: "東京",
    calendarEventIsAllDay: false,
  },
  {
    visitId: "missing",
    calendarEventId: "missing-event",
    calendarEventTitle: "Missing",
    calendarEventLocation: null,
    calendarEventIsAllDay: false,
  },
];

const coalescedEnrichment = coalesceCalendarEventUpdates(enrichmentUpdates);
assert.deepEqual(
  coalescedEnrichment.map(({ visitId, calendarEventId }) => ({ visitId, calendarEventId })),
  [
    { visitId: "visit-a", calendarEventId: "event-a-final" },
    { visitId: "visit-b", calendarEventId: "event-b" },
    { visitId: "visit-雪's", calendarEventId: "event-雪-'quoted'" },
    { visitId: "missing", calendarEventId: "missing-event" },
  ],
);

const exportUpdates: CalendarExportUpdate[] = [
  {
    visitId: "visit-a",
    calendarEventId: "exported-a",
    calendarEventTitle: "Exported A",
    exportedToCalendarId: "calendar-a",
  },
  {
    visitId: "visit-b",
    calendarEventId: "imported-b",
    calendarEventTitle: "Imported B",
  },
  {
    visitId: "visit-a",
    calendarEventId: "exported-a-second",
    calendarEventTitle: "Exported A Second",
    exportedToCalendarId: "calendar-a-second",
  },
  {
    visitId: "visit-a",
    calendarEventId: "imported-a-final",
    calendarEventTitle: "Imported A Final",
  },
  {
    visitId: "visit-雪's",
    calendarEventId: "ignored-empty-export",
    calendarEventTitle: "Empty export",
    exportedToCalendarId: "",
  },
  {
    visitId: "visit-雪's",
    calendarEventId: "exported-unicode",
    calendarEventTitle: "Exported Unicode",
    exportedToCalendarId: "calendar-雪",
  },
  {
    visitId: "visit-雪's",
    calendarEventId: "imported-unicode-final",
    calendarEventTitle: "Imported Unicode Final",
  },
  {
    visitId: "missing",
    calendarEventId: "missing-export",
    calendarEventTitle: "Missing Export",
    exportedToCalendarId: "missing-calendar",
  },
];

const coalescedExports = coalesceCalendarExportUpdates(exportUpdates);
assert.deepEqual(coalescedExports, [
  {
    visitId: "visit-a",
    calendarEventId: "imported-a-final",
    calendarEventTitle: "Imported A Final",
    exportedToCalendarId: "calendar-a-second",
    updatesExportedCalendar: true,
  },
  {
    visitId: "visit-b",
    calendarEventId: "imported-b",
    calendarEventTitle: "Imported B",
    exportedToCalendarId: null,
    updatesExportedCalendar: false,
  },
  {
    visitId: "visit-雪's",
    calendarEventId: "imported-unicode-final",
    calendarEventTitle: "Imported Unicode Final",
    exportedToCalendarId: "calendar-雪",
    updatesExportedCalendar: true,
  },
  {
    visitId: "missing",
    calendarEventId: "missing-export",
    calendarEventTitle: "Missing Export",
    exportedToCalendarId: "missing-calendar",
    updatesExportedCalendar: true,
  },
]);

const database = new DatabaseSync(":memory:");
try {
  database.exec(`CREATE TABLE visits (
    id TEXT PRIMARY KEY,
    calendarEventId TEXT,
    calendarEventTitle TEXT,
    calendarEventLocation TEXT,
    calendarEventIsAllDay INTEGER,
    exportedToCalendarId TEXT,
    updatedAt INTEGER,
    payload TEXT NOT NULL
  )`);
  const insert = database.prepare(
    `INSERT INTO visits
      (id, calendarEventId, calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
       exportedToCalendarId, updatedAt, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run("visit-a", "old-a", "Old A", "Old location A", 0, "old-calendar-a", 1, "sentinel-a");
  insert.run("visit-b", "old-b", "Old B", "Old location B", 1, "old-calendar-b", 2, "sentinel-b");
  insert.run("visit-雪's", "old-u", "Old U", "Old location U", 1, null, 3, "sentinel-雪");
  insert.run("untouched", "old-t", "Old T", "Old location T", 0, "old-calendar-t", 4, "sentinel-t");

  const enrichmentStatement = buildCalendarEventPersistenceStatement(coalescedEnrichment);
  database.prepare(enrichmentStatement.sql).run(...enrichmentStatement.parameters);
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT calendarEventId, calendarEventLocation, calendarEventIsAllDay,
             exportedToCalendarId, updatedAt, payload
           FROM visits WHERE id = ?`,
        )
        .get("visit-a"),
    },
    {
      calendarEventId: "event-a-final",
      calendarEventLocation: "Final location",
      calendarEventIsAllDay: 1,
      exportedToCalendarId: "old-calendar-a",
      updatedAt: 1,
      payload: "sentinel-a",
    },
  );
  const exportStatement = buildCalendarExportPersistenceStatement(coalescedExports, 123_456);
  database.prepare(exportStatement.sql).run(...exportStatement.parameters);

  const rows = database
    .prepare("SELECT * FROM visits ORDER BY id")
    .all()
    .map((row) => ({ ...row }));
  assert.deepEqual(rows, [
    {
      id: "untouched",
      calendarEventId: "old-t",
      calendarEventTitle: "Old T",
      calendarEventLocation: "Old location T",
      calendarEventIsAllDay: 0,
      exportedToCalendarId: "old-calendar-t",
      updatedAt: 4,
      payload: "sentinel-t",
    },
    {
      id: "visit-a",
      calendarEventId: "imported-a-final",
      calendarEventTitle: "Imported A Final",
      calendarEventLocation: "Final location",
      calendarEventIsAllDay: 1,
      exportedToCalendarId: "calendar-a-second",
      updatedAt: 123_456,
      payload: "sentinel-a",
    },
    {
      id: "visit-b",
      calendarEventId: "imported-b",
      calendarEventTitle: "Imported B",
      calendarEventLocation: null,
      calendarEventIsAllDay: 0,
      exportedToCalendarId: "old-calendar-b",
      updatedAt: 123_456,
      payload: "sentinel-b",
    },
    {
      id: "visit-雪's",
      calendarEventId: "imported-unicode-final",
      calendarEventTitle: "Imported Unicode Final",
      calendarEventLocation: "東京",
      calendarEventIsAllDay: 0,
      exportedToCalendarId: "calendar-雪",
      updatedAt: 123_456,
      payload: "sentinel-雪",
    },
  ]);
} finally {
  database.close();
}

assert.throws(() => buildCalendarEventPersistenceStatement([]), RangeError);
assert.throws(() => buildCalendarExportPersistenceStatement([], 0), RangeError);
assert.throws(
  () => buildCalendarEventPersistenceStatement([coalescedEnrichment[0], coalescedEnrichment[0]]),
  /duplicate visit IDs/,
);
assert.throws(() => buildCalendarExportPersistenceStatement(coalescedExports, Number.NaN), RangeError);

const fullEnrichmentBatch = Array.from({ length: CALENDAR_PERSISTENCE_BATCH_SIZE }, (_, index) => ({
  visitId: `visit-${index}`,
  calendarEventId: `event-${index}`,
  calendarEventTitle: `Title ${index}`,
  calendarEventLocation: index % 2 === 0 ? null : `Location ${index}`,
  calendarEventIsAllDay: index % 3 === 0,
}));
assert.equal(buildCalendarEventPersistenceStatement(fullEnrichmentBatch).parameters.length, 800);
assert.throws(
  () => buildCalendarEventPersistenceStatement([...fullEnrichmentBatch, fullEnrichmentBatch[0]]),
  RangeError,
);

const largeDatabase = new DatabaseSync(":memory:");
try {
  largeDatabase.exec(`CREATE TABLE visits (
    id TEXT PRIMARY KEY,
    calendarEventId TEXT,
    calendarEventTitle TEXT,
    calendarEventLocation TEXT,
    calendarEventIsAllDay INTEGER,
    exportedToCalendarId TEXT,
    updatedAt INTEGER,
    payload TEXT NOT NULL
  )`);
  const insert = largeDatabase.prepare(`INSERT INTO visits
    (id, calendarEventId, calendarEventTitle, calendarEventLocation, calendarEventIsAllDay,
     exportedToCalendarId, updatedAt, payload)
    VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)`);
  for (let index = 0; index < 321; index++) {
    insert.run(
      `large-${index}`,
      `old-location-${index}`,
      index % 2,
      index % 2 === 0 ? `old-calendar-${index}` : null,
      index,
      `payload-${index}`,
    );
  }

  const largeEnrichmentUpdates: CalendarEventUpdate[] = Array.from({ length: 321 }, (_, index) => ({
    visitId: `large-${index}`,
    calendarEventId: `large-event-${index}`,
    calendarEventTitle: `Large title ${index}`,
    calendarEventLocation: index % 3 === 0 ? null : `large-location-${index}`,
    calendarEventIsAllDay: index % 5 === 0,
  }));
  // The duplicate is separated from its first occurrence by more than two
  // statement batches; the final value must still win before chunking.
  largeEnrichmentUpdates.push({
    visitId: "large-0",
    calendarEventId: "large-event-0-final",
    calendarEventTitle: "Large title 0 final",
    calendarEventLocation: "large-location-0-final",
    calendarEventIsAllDay: false,
  });
  const coalescedLargeEnrichment = coalesceCalendarEventUpdates(largeEnrichmentUpdates);
  assert.equal(coalescedLargeEnrichment.length, 321);
  let reusableEnrichmentStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
  let fullEnrichmentExecutions = 0;
  for (let offset = 0; offset < coalescedLargeEnrichment.length; offset += CALENDAR_PERSISTENCE_BATCH_SIZE) {
    const batch = coalescedLargeEnrichment.slice(offset, offset + CALENDAR_PERSISTENCE_BATCH_SIZE);
    const statement = buildCalendarEventPersistenceStatement(batch);
    if (batch.length === CALENDAR_PERSISTENCE_BATCH_SIZE) {
      reusableEnrichmentStatement ??= largeDatabase.prepare(statement.sql);
      reusableEnrichmentStatement.run(...statement.parameters);
      fullEnrichmentExecutions += 1;
    } else {
      largeDatabase.prepare(statement.sql).run(...statement.parameters);
    }
  }
  assert.equal(fullEnrichmentExecutions, 2);
  assert.deepEqual(
    {
      ...largeDatabase
        .prepare(
          `SELECT calendarEventId, calendarEventLocation, calendarEventIsAllDay,
             exportedToCalendarId, updatedAt, payload
           FROM visits WHERE id = 'large-0'`,
        )
        .get(),
    },
    {
      calendarEventId: "large-event-0-final",
      calendarEventLocation: "large-location-0-final",
      calendarEventIsAllDay: 0,
      exportedToCalendarId: "old-calendar-0",
      updatedAt: 0,
      payload: "payload-0",
    },
  );

  const largeExportUpdates: CalendarExportUpdate[] = Array.from({ length: 321 }, (_, index) => ({
    visitId: `large-${index}`,
    calendarEventId: `export-event-${index}`,
    calendarEventTitle: `Export title ${index}`,
  }));
  largeExportUpdates.push(
    {
      visitId: "large-0",
      calendarEventId: "export-event-0-first",
      calendarEventTitle: "Export title 0 first",
      exportedToCalendarId: "new-calendar-first",
    },
    {
      visitId: "large-0",
      calendarEventId: "export-event-0-second",
      calendarEventTitle: "Export title 0 second",
      exportedToCalendarId: "new-calendar-second",
    },
    {
      visitId: "large-0",
      calendarEventId: "export-event-0-final",
      calendarEventTitle: "Export title 0 final",
    },
    {
      visitId: "large-1",
      calendarEventId: "export-event-1-empty-final",
      calendarEventTitle: "Export title 1 empty final",
      exportedToCalendarId: "",
    },
  );
  const coalescedLargeExports = coalesceCalendarExportUpdates(largeExportUpdates);
  assert.equal(coalescedLargeExports.length, 321);
  let reusableExportStatement: ReturnType<DatabaseSync["prepare"]> | null = null;
  let fullExportExecutions = 0;
  for (let offset = 0; offset < coalescedLargeExports.length; offset += CALENDAR_PERSISTENCE_BATCH_SIZE) {
    const batch = coalescedLargeExports.slice(offset, offset + CALENDAR_PERSISTENCE_BATCH_SIZE);
    const statement = buildCalendarExportPersistenceStatement(batch, 999_999);
    if (batch.length === CALENDAR_PERSISTENCE_BATCH_SIZE) {
      reusableExportStatement ??= largeDatabase.prepare(statement.sql);
      reusableExportStatement.run(...statement.parameters);
      fullExportExecutions += 1;
    } else {
      largeDatabase.prepare(statement.sql).run(...statement.parameters);
    }
  }
  assert.equal(fullExportExecutions, 2);
  assert.deepEqual(
    ["large-0", "large-1", "large-2", "large-160", "large-320"].map((id) => ({
      ...largeDatabase
        .prepare(
          `SELECT id, calendarEventId, calendarEventTitle, calendarEventLocation,
             calendarEventIsAllDay, exportedToCalendarId, updatedAt, payload
           FROM visits WHERE id = ?`,
        )
        .get(id),
    })),
    [
      {
        id: "large-0",
        calendarEventId: "export-event-0-final",
        calendarEventTitle: "Export title 0 final",
        calendarEventLocation: "large-location-0-final",
        calendarEventIsAllDay: 0,
        exportedToCalendarId: "new-calendar-second",
        updatedAt: 999_999,
        payload: "payload-0",
      },
      {
        id: "large-1",
        calendarEventId: "export-event-1-empty-final",
        calendarEventTitle: "Export title 1 empty final",
        calendarEventLocation: "large-location-1",
        calendarEventIsAllDay: 0,
        exportedToCalendarId: null,
        updatedAt: 999_999,
        payload: "payload-1",
      },
      {
        id: "large-2",
        calendarEventId: "export-event-2",
        calendarEventTitle: "Export title 2",
        calendarEventLocation: "large-location-2",
        calendarEventIsAllDay: 0,
        exportedToCalendarId: "old-calendar-2",
        updatedAt: 999_999,
        payload: "payload-2",
      },
      {
        id: "large-160",
        calendarEventId: "export-event-160",
        calendarEventTitle: "Export title 160",
        calendarEventLocation: "large-location-160",
        calendarEventIsAllDay: 1,
        exportedToCalendarId: "old-calendar-160",
        updatedAt: 999_999,
        payload: "payload-160",
      },
      {
        id: "large-320",
        calendarEventId: "export-event-320",
        calendarEventTitle: "Export title 320",
        calendarEventLocation: "large-location-320",
        calendarEventIsAllDay: 1,
        exportedToCalendarId: "old-calendar-320",
        updatedAt: 999_999,
        payload: "payload-320",
      },
    ],
  );
} finally {
  largeDatabase.close();
}

console.log(
  JSON.stringify(
    {
      status: "ok",
      subsystem: "calendar persistence",
      assertions: {
        enrichmentLastUpdateWins: true,
        exportLastEventFieldsWin: true,
        importedUpdatePreservesExportedCalendar: true,
        nullLocationAndAllDaySemantics: true,
        missingRowsIgnored: true,
        unicodeAndQuotesParameterized: true,
        unrelatedColumnsPreserved: true,
        boundedBatchesAndDuplicateGuards: true,
        fullBatchStatementReuseAcross321Rows: true,
        lastTruthyExportCalendarWins: true,
        falseyOnlyExportSequencesPreserveExistingValue: true,
      },
    },
    null,
    2,
  ),
);
