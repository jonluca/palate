#!/usr/bin/env node
/// <reference types="node" />

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { PhotoRecord, RestaurantRecord, VisitRecord } from "../utils/db/types.ts";
import {
  buildExportDataFromVisits,
  type ExportData,
  type ExportVisit,
  type ExportVisitPhoto,
  withExactExportPhotoCounts,
} from "../utils/export-core.ts";
import {
  BoundedUtf8BufferingSink,
  ExportJsonStreamWriter,
  ExportStreamStateError,
  type ExportStreamDocument,
  type ExportVisitHeader,
} from "../utils/export-stream-core.ts";
import { writeExportJsonSnapshot } from "../utils/export-stream-snapshot.ts";

const EXPECTED_COMPLEX_BYTES = 4_140;
const EXPECTED_COMPLEX_SHA256 = "b5a05a1d97bfe971644a8bc59f21765205a9ace650ada6211c7d0be4fe1bf953";

function documentFor(data: ExportData): ExportStreamDocument {
  return {
    exportedAt: data.exportedAt,
    stats: data.stats,
    restaurants: data.restaurants,
  };
}

function headerFor(visit: ExportVisit): ExportVisitHeader {
  const { photos: _photos, ...header } = visit;
  return header;
}

function streamExport(data: ExportData, sink: (fragment: string) => void): void {
  const writer = new ExportJsonStreamWriter(sink, documentFor(data));
  for (const visit of data.visits) {
    writer.beginVisit(headerFor(visit));
    for (const photo of visit.photos) {
      writer.writePhoto(photo);
    }
    writer.endVisit();
  }
  writer.finish();
}

function streamExportToString(data: ExportData): string {
  const fragments: string[] = [];
  streamExport(data, (fragment) => fragments.push(fragment));
  return fragments.join("");
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function createEmptyExport(): ExportData {
  return {
    exportedAt: "2026-07-09T01:02:03.456Z",
    stats: {
      totalVisits: 0,
      confirmedVisits: 0,
      totalPhotos: 0,
      uniqueRestaurants: 0,
    },
    visits: [],
    restaurants: [],
  };
}

function createComplexExport(): ExportData {
  const undefinedPayloadPhoto: ExportVisitPhoto = {
    id: "photo-undefined-雪",
    uri: 'ph://asset/quote-"-and-newline\n🍣',
    createdAt: "2026-06-20T12:00:00.000Z",
    latitude: null,
    longitude: null,
    mediaType: "photo",
    duration: null,
    foodDetected: null,
    foodConfidence: undefined,
    foodLabels: undefined,
    allLabels: undefined,
  };
  const malformedPayloadPhoto: ExportVisitPhoto = {
    id: "photo-malformed-is-null",
    uri: "ph://asset/malformed",
    createdAt: "2026-06-20T12:01:00.000Z",
    latitude: 0,
    longitude: -0,
    mediaType: "video",
    duration: 12.5,
    foodDetected: false,
    foodConfidence: 0,
    foodLabels: null,
    allLabels: null,
  };
  const unicodeLabelsPhoto: ExportVisitPhoto = {
    id: "photo-labels-🍜",
    uri: "ph://asset/東京/𐐷",
    createdAt: "2026-06-20T12:02:00.000Z",
    latitude: 35.6762,
    longitude: 139.6503,
    mediaType: "photo",
    duration: null,
    foodDetected: true,
    foodConfidence: 0.999,
    foodLabels: [{ label: '寿司 🍣, "chef"\nline', confidence: 0.999 }],
    allLabels: [
      { label: "plate", confidence: 0.8 },
      { label: "surrogate-pair-𝄞", confidence: 0.7 },
    ],
  };

  return {
    exportedAt: "2026-07-09T01:02:03.456Z",
    stats: {
      totalVisits: 2,
      confirmedVisits: 1,
      totalPhotos: 3,
      uniqueRestaurants: 1,
    },
    visits: [
      {
        visitId: "visit-雪-🍣",
        status: "confirmed",
        restaurant: {
          id: "restaurant-東京",
          name: 'Café "雪",\nSushi 🍣',
          latitude: 35.6762,
          longitude: 139.6503,
          address: "1 Main St\n二階",
          phone: null,
          website: 'https://example.test/menu?q=寿司&quote="yes"',
          googlePlaceId: "place-𐐷",
          cuisine: "日本料理",
          priceLevel: 4,
          rating: 4.9,
          notes: "Chef's counter\nまたね",
        },
        suggestedRestaurantId: "michelin-雪",
        visitDate: "2026-06-20",
        startTime: "12:00 PM",
        endTime: "02:00 PM",
        duration: "2 hours",
        startTimestamp: 1_750_420_800_000,
        endTimestamp: 1_750_428_000_000,
        location: { latitude: 35.6762, longitude: 139.6503 },
        photoCount: 3,
        foodProbable: true,
        awardAtVisit: "Two Stars, Green Star",
        notes: 'Dinner, "birthday"\n🍰',
        calendarEvent: {
          id: "calendar-雪",
          title: 'Dinner, "birthday"',
          location: "東京\nUpstairs",
          isAllDay: false,
        },
        exportedToCalendarId: "exported-🍣",
        updatedAt: "2026-06-21T00:00:00.000Z",
        photos: [undefinedPayloadPhoto, malformedPayloadPhoto, unicodeLabelsPhoto],
      },
      {
        visitId: "visit-empty-photos",
        status: "rejected",
        restaurant: null,
        suggestedRestaurantId: null,
        visitDate: "2026-06-19",
        startTime: "09:00 AM",
        endTime: "09:30 AM",
        duration: "30 minutes",
        startTimestamp: 1_750_323_600_000,
        endTimestamp: 1_750_325_400_000,
        location: { latitude: 0, longitude: 0 },
        photoCount: 0,
        foodProbable: false,
        awardAtVisit: null,
        notes: null,
        calendarEvent: { id: null, title: null, location: null, isAllDay: null },
        exportedToCalendarId: null,
        updatedAt: null,
        photos: [],
      },
    ],
    restaurants: [
      {
        id: "restaurant-東京",
        name: 'Café "雪",\nSushi 🍣',
        latitude: 35.6762,
        longitude: 139.6503,
        visitCount: 1,
        address: "1 Main St\n二階",
        phone: null,
        website: 'https://example.test/menu?q=寿司&quote="yes"',
        googlePlaceId: "place-𐐷",
        cuisine: "日本料理",
        priceLevel: 4,
        rating: 4.9,
        notes: "Chef's counter\nまたね",
      },
    ],
  };
}

function assertExactStreaming(data: ExportData): string {
  const expected = JSON.stringify(data, null, 2);
  const actual = streamExportToString(data);
  assert.equal(actual, expected);
  assert.deepEqual(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8"));
  assert.equal(Buffer.byteLength(actual, "utf8"), Buffer.byteLength(expected, "utf8"));
  assert.equal(sha256(actual), sha256(expected));
  return actual;
}

function testExactCountReconciliation(data: ExportData): void {
  const visitsWithStaleCounts = data.visits.map((visit, index) => ({
    ...visit,
    photoCount: 100 + index,
  }));
  const exactCounts = new Map<string, number>([
    [data.visits[0]!.visitId, 3],
    [data.visits[1]!.visitId, 0],
  ]);
  const reconciled = withExactExportPhotoCounts(visitsWithStaleCounts, exactCounts);
  const document = buildExportDataFromVisits({
    visits: reconciled,
    restaurants: [],
    exportedAt: data.exportedAt,
  });

  assert.deepEqual(
    reconciled.map((visit) => visit.photoCount),
    [3, 0],
  );
  assert.equal(document.stats.totalPhotos, 3);
  assert.deepEqual(
    visitsWithStaleCounts.map((visit) => visit.photoCount),
    [100, 101],
    "reconciliation must not mutate the input visits",
  );
  assert.throws(() => withExactExportPhotoCounts(visitsWithStaleCounts, new Map()), /missing visit ID/);
  assert.throws(
    () => withExactExportPhotoCounts(visitsWithStaleCounts, new Map([...exactCounts, ["unexpected", 1]])),
    /unexpected visit ID/,
  );
}

async function testSnapshotWriterIntegration(): Promise<void> {
  const restaurants: RestaurantRecord[] = [
    {
      id: "restaurant-snapshot",
      name: "Snapshot Café",
      latitude: 37.5,
      longitude: -122.4,
      address: "1 Exact Count Way",
      phone: null,
      website: null,
      googlePlaceId: null,
      cuisine: "Test",
      priceLevel: 2,
      rating: 4.5,
      notes: null,
    },
  ];
  const visits: VisitRecord[] = [
    {
      id: "visit-stale-two",
      restaurantId: restaurants[0]!.id,
      suggestedRestaurantId: null,
      status: "confirmed",
      startTime: 1_750_420_800_000,
      endTime: 1_750_424_400_000,
      centerLat: 37.5,
      centerLon: -122.4,
      photoCount: 999,
      foodProbable: true,
      calendarEventId: null,
      calendarEventTitle: null,
      calendarEventLocation: null,
      calendarEventIsAllDay: null,
      exportedToCalendarId: null,
      notes: null,
      updatedAt: null,
      awardAtVisit: null,
    },
    {
      id: "visit-stale-zero",
      restaurantId: null,
      suggestedRestaurantId: null,
      status: "pending",
      startTime: 1_750_507_200_000,
      endTime: 1_750_509_000_000,
      centerLat: 0,
      centerLon: 0,
      photoCount: 888,
      foodProbable: false,
      calendarEventId: null,
      calendarEventTitle: null,
      calendarEventLocation: null,
      calendarEventIsAllDay: null,
      exportedToCalendarId: null,
      notes: null,
      updatedAt: null,
      awardAtVisit: null,
    },
  ];
  const photos: PhotoRecord[] = [
    {
      id: "snapshot-photo-a",
      uri: "ph://snapshot-a",
      creationTime: 1_750_420_900_000,
      latitude: 37.5,
      longitude: -122.4,
      visitId: visits[0]!.id,
      foodDetected: true,
      foodLabels: [{ label: "food", confidence: 0.9 }],
      foodConfidence: 0.9,
      allLabels: [{ label: "plate", confidence: 0.8 }],
      mediaType: "photo",
      duration: null,
    },
    {
      id: "snapshot-photo-b",
      uri: "ph://snapshot-b",
      creationTime: 1_750_421_000_000,
      latitude: null,
      longitude: null,
      visitId: visits[0]!.id,
      foodDetected: false,
      foodLabels: [],
      foodConfidence: null,
      allLabels: [],
      mediaType: "video",
      duration: 5,
    },
  ];
  const fragments: string[] = [];
  const countRequests: string[][] = [];
  const pageRequests: string[][] = [];

  await writeExportJsonSnapshot({
    visits,
    restaurants,
    exportedAt: "2026-07-09T06:00:00.000Z",
    sink: (fragment) => fragments.push(fragment),
    loadPhotoCounts: async (visitIds) => {
      countRequests.push([...visitIds]);
      return new Map([
        [visits[0]!.id, 2],
        [visits[1]!.id, 0],
      ]);
    },
    loadPhotoPage: async (visitIds, cursor, pageSize) => {
      assert.equal(cursor, null);
      assert.equal(pageSize, 4_000);
      pageRequests.push([...visitIds]);
      const requestedIds = new Set(visitIds);
      return { photos: photos.filter((photo) => requestedIds.has(photo.visitId!)), nextCursor: null };
    },
  });

  const json = fragments.join("");
  const parsed = JSON.parse(json) as ExportData;
  assert.deepEqual(countRequests, [[visits[0]!.id, visits[1]!.id]]);
  assert.deepEqual(pageRequests, [[visits[0]!.id, visits[1]!.id]]);
  assert.equal(parsed.stats.totalPhotos, 2);
  assert.deepEqual(
    parsed.visits.map((visit) => ({ id: visit.visitId, photoCount: visit.photoCount, photos: visit.photos.length })),
    [
      { id: visits[0]!.id, photoCount: 2, photos: 2 },
      { id: visits[1]!.id, photoCount: 0, photos: 0 },
    ],
  );
  assert.equal(json, JSON.stringify(parsed, null, 2));
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function testWriterStateErrors(data: ExportData): void {
  const fragments: string[] = [];
  const writer = new ExportJsonStreamWriter((fragment) => fragments.push(fragment), documentFor(data));
  const visit = data.visits[0]!;
  const header = headerFor(visit);
  const photo = visit.photos[0]!;

  assert.throws(() => writer.writePhoto(photo), ExportStreamStateError);
  assert.throws(() => writer.endVisit(), ExportStreamStateError);
  writer.beginVisit(header);
  assert.throws(() => writer.beginVisit(header), ExportStreamStateError);
  assert.throws(() => writer.finish(), ExportStreamStateError);
  writer.writePhoto(photo);
  writer.endVisit();
  writer.finish();
  assert.throws(() => writer.beginVisit(header), ExportStreamStateError);
  assert.throws(() => writer.writePhoto(photo), ExportStreamStateError);
  assert.throws(() => writer.endVisit(), ExportStreamStateError);
  assert.throws(() => writer.finish(), ExportStreamStateError);
}

function testWriterSinkFailure(data: ExportData): void {
  const failure = new Error("injected text sink failure");
  let calls = 0;
  const writer = new ExportJsonStreamWriter((_) => {
    calls += 1;
    if (calls === 2) {
      throw failure;
    }
  }, documentFor(data));

  assert.throws(
    () => writer.beginVisit(headerFor(data.visits[0]!)),
    (error: unknown) => error === failure,
  );
  assert.equal(calls, 2);
  assert.throws(() => writer.finish(), /after the export sink failed/);
  assert.throws(() => writer.endVisit(), /after the export sink failed/);
  assert.equal(calls, 2, "a failed writer must never call its sink again");
}

function testPageLikeWrites(data: ExportData): void {
  const fragments: string[] = [];
  const writer = new ExportJsonStreamWriter((fragment) => fragments.push(fragment), documentFor(data));
  const [firstVisit, secondVisit] = data.visits;
  assert.ok(firstVisit && secondVisit);

  writer.beginVisit(headerFor(firstVisit));
  // Simulate one visit crossing three bounded database pages.
  writer.writePhoto(firstVisit.photos[0]!);
  writer.writePhoto(firstVisit.photos[1]!);
  writer.writePhoto(firstVisit.photos[2]!);
  writer.endVisit();
  writer.beginVisit(headerFor(secondVisit));
  writer.endVisit();
  writer.finish();

  assert.equal(fragments.join(""), JSON.stringify(data, null, 2));
}

function testUtf8Buffering(data: ExportData): void {
  const normalChunks: Uint8Array[] = [];
  const normal = new BoundedUtf8BufferingSink((chunk) => normalChunks.push(chunk), 6);
  normal.write("ab");
  normal.write("🍣");
  normal.write("cd");
  assert.equal(normal.bufferedCodeUnits, 6);
  normal.write("éé");
  assert.equal(normal.bufferedCodeUnits, 2);
  assert.ok(normal.maximumBufferedCodeUnitsObserved <= normal.maxBufferedCodeUnits);
  normal.flush();
  assert.equal(normal.bufferedCodeUnits, 0);
  assert.deepEqual(
    normalChunks.map((chunk) => new TextDecoder("utf-8", { fatal: true }).decode(chunk)),
    ["ab🍣cd", "éé"],
  );
  const normalChunkCount = normalChunks.length;
  normal.flush();
  normal.close();
  normal.close();
  normal.flush();
  assert.equal(normal.isClosed, true);
  assert.equal(normalChunks.length, normalChunkCount);
  assert.throws(() => normal.write("after-close"), ExportStreamStateError);

  const oversizedChunks: Uint8Array[] = [];
  const oversized = new BoundedUtf8BufferingSink((chunk) => oversizedChunks.push(chunk), 4);
  const oversizedFragment = "whole-🍣-fragment";
  oversized.write("x");
  oversized.write(oversizedFragment);
  assert.equal(oversized.bufferedCodeUnits, 0);
  assert.equal(oversized.maximumBufferedCodeUnitsObserved, oversizedFragment.length);
  assert.ok(oversized.maximumBufferedCodeUnitsObserved > oversized.maxBufferedCodeUnits);
  assert.deepEqual(
    oversizedChunks.map((chunk) => new TextDecoder("utf-8", { fatal: true }).decode(chunk)),
    ["x", oversizedFragment],
  );

  const retryFailure = new Error("injected byte sink failure");
  const retryChunks: Uint8Array[] = [];
  let shouldFail = true;
  const retry = new BoundedUtf8BufferingSink((chunk) => {
    if (shouldFail) {
      shouldFail = false;
      throw retryFailure;
    }
    retryChunks.push(chunk);
  }, 32);
  const retryFragment = "retry-🍣-without-loss";
  retry.write(retryFragment);
  assert.throws(
    () => retry.close(),
    (error: unknown) => error === retryFailure,
  );
  assert.equal(retry.isClosed, false);
  assert.equal(retry.bufferedCodeUnits, retryFragment.length);
  retry.close();
  assert.equal(retry.isClosed, true);
  assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(concatChunks(retryChunks)), retryFragment);

  const streamedChunks: Uint8Array[] = [];
  const buffered = new BoundedUtf8BufferingSink((chunk) => streamedChunks.push(chunk), 37);
  streamExport(data, buffered.write);
  buffered.close();
  for (const chunk of streamedChunks) {
    assert.doesNotThrow(() => new TextDecoder("utf-8", { fatal: true }).decode(chunk));
    assert.equal(new TextDecoder().decode(chunk).includes("�"), false);
  }
  const actualBytes = concatChunks(streamedChunks);
  const expectedBytes = Buffer.from(JSON.stringify(data, null, 2), "utf8");
  assert.deepEqual(Buffer.from(actualBytes), expectedBytes);
  assert.equal(sha256(actualBytes), sha256(expectedBytes));
}

assert.throws(() => new BoundedUtf8BufferingSink(() => {}, 0), /positive safe integer/);
assert.throws(
  () => new ExportJsonStreamWriter(null as unknown as (fragment: string) => void, documentFor(createEmptyExport())),
  /must be a function/,
);

const emptyExport = createEmptyExport();
assertExactStreaming(emptyExport);

const complexExport = createComplexExport();
const complexJson = assertExactStreaming(complexExport);
assert.equal(Buffer.byteLength(complexJson, "utf8"), EXPECTED_COMPLEX_BYTES);
assert.equal(sha256(complexJson), EXPECTED_COMPLEX_SHA256);

const parsed = JSON.parse(complexJson) as ExportData;
const undefinedPhoto = parsed.visits[0]?.photos.find(({ id }) => id === "photo-undefined-雪");
const malformedPhoto = parsed.visits[0]?.photos.find(({ id }) => id === "photo-malformed-is-null");
assert.ok(undefinedPhoto && malformedPhoto);
assert.equal(Object.hasOwn(undefinedPhoto, "foodConfidence"), false);
assert.equal(Object.hasOwn(undefinedPhoto, "foodLabels"), false);
assert.equal(Object.hasOwn(undefinedPhoto, "allLabels"), false);
assert.equal(malformedPhoto.foodLabels, null);
assert.equal(malformedPhoto.allLabels, null);
assert.equal(parsed.visits[1]?.photos.length, 0);

testPageLikeWrites(complexExport);
testExactCountReconciliation(complexExport);
testWriterStateErrors(complexExport);
testWriterSinkFailure(complexExport);
testUtf8Buffering(complexExport);
await testSnapshotWriterIntegration();

console.log("Export streaming tests passed.");
