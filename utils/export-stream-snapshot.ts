import type { PhotoRecord, RestaurantRecord, VisitRecord } from "./db/types.ts";
import { EXPORT_PHOTO_PAGE_SIZE, type ExportPhotoCursor } from "./db/export-photos-core.ts";
import {
  buildExportDataFromVisits,
  buildExportPhoto,
  buildExportVisits,
  type ExportVisit,
  withExactExportPhotoCounts,
} from "./export-core.ts";
import { ExportJsonStreamWriter, type TextFragmentSink } from "./export-stream-core.ts";
import { planExportPhotoBatches, type ExportPhotoBatch } from "./export-stream-plan.ts";

export interface ExportSnapshotPhotoPage {
  readonly photos: readonly PhotoRecord[];
  readonly nextCursor: ExportPhotoCursor | null;
}

export interface WriteExportJsonSnapshotInput {
  readonly visits: readonly VisitRecord[];
  readonly restaurants: readonly RestaurantRecord[];
  readonly exportedAt: string;
  readonly sink: TextFragmentSink;
  readonly loadPhotoCounts: (visitIds: readonly string[]) => Promise<Map<string, number>>;
  readonly loadPhotoPage: (
    visitIds: readonly string[],
    cursor: ExportPhotoCursor | null,
    pageSize: number,
  ) => Promise<ExportSnapshotPhotoPage>;
}

function getExportVisitHeader(visit: ExportVisit): Omit<ExportVisit, "photos"> {
  const { photos: _photos, ...header } = visit;
  return header;
}

async function writeBoundedExportBatch(
  writer: ExportJsonStreamWriter,
  batch: Extract<ExportPhotoBatch, { mode: "bounded" }>,
  visitsById: ReadonlyMap<string, ExportVisit>,
  loadPhotoPage: WriteExportJsonSnapshotInput["loadPhotoPage"],
): Promise<void> {
  const photosByVisitId = new Map<string, PhotoRecord[]>();

  if (batch.photoCount > 0) {
    const page = await loadPhotoPage(batch.visitIds, null, EXPORT_PHOTO_PAGE_SIZE);
    if (page.nextCursor !== null || page.photos.length !== batch.photoCount) {
      throw new Error(
        `Export snapshot count changed inside a bounded batch (${page.photos.length}/${batch.photoCount}).`,
      );
    }
    const requestedVisitIds = new Set(batch.visitIds);
    for (const photo of page.photos) {
      if (photo.visitId === null || !requestedVisitIds.has(photo.visitId)) {
        throw new Error(`Export photo ${photo.id} did not match its bounded visit batch.`);
      }
      const photos = photosByVisitId.get(photo.visitId);
      if (photos) {
        photos.push(photo);
      } else {
        photosByVisitId.set(photo.visitId, [photo]);
      }
    }
  }

  for (const visitId of batch.visitIds) {
    const visit = visitsById.get(visitId);
    if (!visit) {
      throw new Error(`Export batch referenced unknown visit ${visitId}.`);
    }
    writer.beginVisit(getExportVisitHeader(visit));
    for (const photo of photosByVisitId.get(visitId) ?? []) {
      writer.writePhoto(buildExportPhoto(photo));
    }
    writer.endVisit();
  }
}

async function writeStreamingExportBatch(
  writer: ExportJsonStreamWriter,
  batch: Extract<ExportPhotoBatch, { mode: "streaming" }>,
  visitsById: ReadonlyMap<string, ExportVisit>,
  loadPhotoPage: WriteExportJsonSnapshotInput["loadPhotoPage"],
): Promise<void> {
  const visitId = batch.visitIds[0];
  const visit = visitsById.get(visitId);
  if (!visit) {
    throw new Error(`Export stream referenced unknown visit ${visitId}.`);
  }

  writer.beginVisit(getExportVisitHeader(visit));
  let cursor: ExportPhotoCursor | null = null;
  let writtenPhotoCount = 0;
  do {
    const page = await loadPhotoPage([visitId], cursor, EXPORT_PHOTO_PAGE_SIZE);
    for (const photo of page.photos) {
      if (photo.visitId !== visitId) {
        throw new Error(`Export photo ${photo.id} did not match streaming visit ${visitId}.`);
      }
      writer.writePhoto(buildExportPhoto(photo));
      writtenPhotoCount += 1;
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  writer.endVisit();

  if (writtenPhotoCount !== batch.photoCount) {
    throw new Error(`Export snapshot count changed for visit ${visitId} (${writtenPhotoCount}/${batch.photoCount}).`);
  }
}

/** Assemble and stream one exact, snapshot-pinned export through injected database readers. */
export async function writeExportJsonSnapshot(input: WriteExportJsonSnapshotInput): Promise<void> {
  const visitsWithStoredCounts = buildExportVisits({
    visits: input.visits,
    restaurants: input.restaurants,
    photosByVisitId: new Map(),
  });
  const visitIds = visitsWithStoredCounts.map((visit) => visit.visitId);
  const photoCounts = await input.loadPhotoCounts(visitIds);
  const batches = planExportPhotoBatches(visitIds, photoCounts);
  const exportVisits = withExactExportPhotoCounts(visitsWithStoredCounts, photoCounts);
  const document = buildExportDataFromVisits({
    visits: exportVisits,
    restaurants: input.restaurants,
    exportedAt: input.exportedAt,
  });
  const visitsById = new Map(exportVisits.map((visit) => [visit.visitId, visit]));
  const writer = new ExportJsonStreamWriter(input.sink, {
    exportedAt: document.exportedAt,
    stats: document.stats,
    restaurants: document.restaurants,
  });

  for (const batch of batches) {
    if (batch.mode === "bounded") {
      await writeBoundedExportBatch(writer, batch, visitsById, input.loadPhotoPage);
    } else {
      await writeStreamingExportBatch(writer, batch, visitsById, input.loadPhotoPage);
    }
  }
  writer.finish();
}
