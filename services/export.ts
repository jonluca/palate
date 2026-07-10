import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Platform } from "react-native";
import {
  getAllRestaurants,
  getDatabase,
  getExportPhotoCountsByVisitIds,
  getPhotosByVisitIdsPage,
  getVisits,
} from "@/utils/db";
import type { ExportPhotoCursor } from "@/utils/db/export-photos-core";
import {
  buildExportDataFromVisits,
  buildExportPhoto,
  buildExportVisits,
  exportDataToCSVString,
  exportDataToJSONString,
  type ExportData,
  withExactExportPhotoCounts,
} from "@/utils/export-core";
import { BoundedUtf8BufferingSink } from "@/utils/export-stream-core";
import { writeExportJsonSnapshot } from "@/utils/export-stream-snapshot";

export type ExportFormat = "json" | "csv";

export interface ExportShareResult {
  fileUri: string | null;
  fileName: string | null;
  savedToFile: boolean;
  shared: boolean;
}

const STALE_EXPORT_PART_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

function formatTimestampForFilename(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function ensureExportDirectory(baseDir: Directory): Directory {
  const exportDir = new Directory(baseDir, "exports");
  exportDir.create({ intermediates: true, idempotent: true });
  return exportDir;
}

function cleanupStaleExportParts(exportDir: Directory): void {
  try {
    const cutoff = Date.now() - STALE_EXPORT_PART_MAX_AGE_MS;
    for (const entry of exportDir.list()) {
      if (!(entry instanceof File) || !entry.name.startsWith(".palate-export-") || !entry.name.endsWith(".json.part")) {
        continue;
      }
      const modifiedAt = entry.lastModified ?? entry.creationTime;
      if (modifiedAt !== null && modifiedAt <= cutoff) {
        try {
          entry.delete();
        } catch {
          // Stale cleanup is best-effort and must not prevent a new export.
        }
      }
    }
  } catch {
    // Directory enumeration can fail transiently; the current .part is still cleaned below.
  }
}

function downloadWebExport(data: string, format: ExportFormat): ExportShareResult {
  if (typeof document === "undefined") {
    throw new Error("Browser downloads require a DOM document.");
  }
  const timestamp = formatTimestampForFilename(new Date());
  const fileName = `palate-export-${timestamp}.${format}`;
  const mimeType = format === "json" ? "application/json" : "text/csv";
  const objectUrl = URL.createObjectURL(new Blob([data], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
  return { fileUri: null, fileName, savedToFile: true, shared: false };
}

type ExportStatusFilter = "all" | "confirmed" | "pending" | "rejected";
type ExportDatabaseConnection = Awaited<ReturnType<typeof getDatabase>>;

async function assembleExportData(
  database: ExportDatabaseConnection,
  includePhotos: boolean,
  statusFilter: ExportStatusFilter,
): Promise<ExportData> {
  const visits = await getVisits(statusFilter === "all" ? undefined : statusFilter, database);
  const restaurants = await getAllRestaurants(database);
  let exportVisits = buildExportVisits({ visits, restaurants, photosByVisitId: new Map() });
  const exportVisitsById = new Map(exportVisits.map((visit) => [visit.visitId, visit]));
  const visitIds = visits.map((visit) => visit.id);
  if (includePhotos && visitIds.length > 0) {
    let cursor: ExportPhotoCursor | null = null;
    do {
      const page = await getPhotosByVisitIdsPage(visitIds, cursor, database);
      for (const photo of page.photos) {
        const exportVisit = photo.visitId === null ? null : exportVisitsById.get(photo.visitId);
        if (!exportVisit) {
          throw new Error(`Export photo ${photo.id} did not match a requested visit.`);
        }
        exportVisit.photos.push(buildExportPhoto(photo));
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  const exactPhotoCounts = includePhotos
    ? new Map(exportVisits.map((visit) => [visit.visitId, visit.photos.length]))
    : await getExportPhotoCountsByVisitIds(visitIds, database);
  exportVisits = withExactExportPhotoCounts(exportVisits, exactPhotoCounts);

  return buildExportDataFromVisits({
    visits: exportVisits,
    restaurants,
    exportedAt: new Date().toISOString(),
  });
}

async function generateExportData(
  options: {
    includePhotos?: boolean;
    statusFilter?: ExportStatusFilter;
  } = {},
): Promise<ExportData> {
  const { includePhotos = true, statusFilter = "confirmed" } = options;
  const database = await getDatabase();

  // Expo SQLite cannot open the dedicated transaction connection on web. Keep
  // that existing surface functional there; native builds use a pinned snapshot.
  if (Platform.OS === "web") {
    return assembleExportData(database, includePhotos, statusFilter);
  }

  let result: ExportData | null = null;
  // The dedicated transaction connection pins one WAL read snapshot across all
  // keyset pages, so concurrent classification/association writes cannot move a
  // photo behind or ahead of the continuation cursor.
  await database.withExclusiveTransactionAsync(async (transaction) => {
    result = await assembleExportData(transaction, includePhotos, statusFilter);
  });

  if (result === null) {
    throw new Error("Export snapshot completed without producing data.");
  }
  return result;
}

async function generateJSONString(
  options: {
    includePhotos?: boolean;
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  const data = await generateExportData(options);
  return exportDataToJSONString(data);
}

async function generateCSVString(
  options: {
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  const data = await generateExportData({ ...options, includePhotos: false });
  return exportDataToCSVString(data);
}

export async function exportToJSON(
  options: {
    includePhotos?: boolean;
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  return generateJSONString(options);
}

export async function exportToCSV(
  options: {
    statusFilter?: "all" | "confirmed" | "pending" | "rejected";
  } = {},
): Promise<string> {
  return generateCSVString(options);
}

async function shareExportFile(file: File, fileName: string, format: ExportFormat): Promise<ExportShareResult> {
  const canShare = await Sharing.isAvailableAsync();
  let shared = false;
  if (canShare) {
    const mimeType = format === "json" ? "application/json" : "text/csv";
    await Sharing.shareAsync(file.uri, {
      mimeType,
      dialogTitle: "Share export",
    });
    shared = true;
  } else {
    console.warn("Sharing not available on this device.");
  }

  return {
    fileUri: file.uri,
    fileName,
    savedToFile: true,
    shared,
  };
}

async function writeStreamedJSONExport(
  options: { statusFilter?: ExportStatusFilter } = {},
): Promise<{ file: File; fileName: string }> {
  const { statusFilter = "confirmed" } = options;
  const exportDir = ensureExportDirectory(Paths.document ?? Paths.cache);
  cleanupStaleExportParts(exportDir);
  const timestamp = formatTimestampForFilename(new Date());
  const fileName = `palate-export-${timestamp}.json`;
  const file = new File(exportDir, fileName);
  const temporaryFile = new File(exportDir, `.${fileName}.part`);
  let handle: ReturnType<File["open"]> | null = null;

  try {
    temporaryFile.create({ intermediates: true, overwrite: true });
    handle = temporaryFile.open(FileMode.Truncate);
    const bufferedSink = new BoundedUtf8BufferingSink((chunk) => handle!.writeBytes(chunk));
    const database = await getDatabase();
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const visits = await getVisits(statusFilter === "all" ? undefined : statusFilter, transaction);
      const restaurants = await getAllRestaurants(transaction);
      await writeExportJsonSnapshot({
        visits,
        restaurants,
        exportedAt: new Date().toISOString(),
        sink: bufferedSink.write,
        loadPhotoCounts: (visitIds) => getExportPhotoCountsByVisitIds(visitIds, transaction),
        loadPhotoPage: (visitIds, cursor, pageSize) => getPhotosByVisitIdsPage(visitIds, cursor, transaction, pageSize),
      });
      bufferedSink.close();
    });
    handle.close();
    handle = null;
    await temporaryFile.move(file, { overwrite: true });
    return { file, fileName };
  } catch (error) {
    if (handle) {
      try {
        handle.close();
      } catch {
        // Preserve the original export failure.
      }
    }
    try {
      if (temporaryFile.exists) {
        temporaryFile.delete();
      }
    } catch {
      // Preserve the original export failure.
    }
    throw error;
  }
}

/** Stream the app's JSON share path without materializing the full export string. */
export async function exportAndShareJSON(
  options: { statusFilter?: ExportStatusFilter } = {},
): Promise<ExportShareResult> {
  // Expo's dedicated SQLite connection and native FileHandle are unavailable on web.
  if (Platform.OS === "web") {
    return shareExport(await exportToJSON(options), "json");
  }
  const { file, fileName } = await writeStreamedJSONExport(options);
  return shareExportFile(file, fileName, "json");
}

export async function shareExport(data: string, format: ExportFormat): Promise<ExportShareResult> {
  if (Platform.OS === "web") {
    return downloadWebExport(data, format);
  }
  const baseDir = Paths.document ?? Paths.cache;
  const exportDir = ensureExportDirectory(baseDir);
  const timestamp = formatTimestampForFilename(new Date());
  const fileName = `palate-export-${timestamp}.${format}`;
  const file = new File(exportDir, fileName);
  file.write(data, { encoding: "utf8" });
  return shareExportFile(file, fileName, format);
}
