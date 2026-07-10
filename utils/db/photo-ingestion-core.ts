export const PHOTO_INGESTION_FLUSH_SIZE = 4_000;

export interface PhotoIngestionRecord {
  readonly id: string;
  readonly uri: string;
  readonly creationTime: number;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly mediaType: "photo" | "video";
  readonly duration: number | null;
}

export interface PhotoIngestionStatement {
  readonly sql: string;
  readonly parameters: Array<string | number | null>;
  readonly requestedCount: number;
}

/** Returns the next bounded flush size without removing records from the caller's buffer. */
export function getPhotoIngestionFlushCount(pendingCount: number, force: boolean): number {
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0) {
    throw new RangeError(`Pending photo count must be a non-negative safe integer; received ${pendingCount}.`);
  }
  if (pendingCount >= PHOTO_INGESTION_FLUSH_SIZE) {
    return PHOTO_INGESTION_FLUSH_SIZE;
  }
  return force ? pendingCount : 0;
}

/**
 * Build one atomic insert-or-ignore statement sized below Expo SQLite's 32,766
 * variable limit. Multi-row binding is materially faster than JSON extraction
 * while retaining first-occurrence-wins ordering for duplicate IDs.
 */
export function buildPhotoIngestionStatement(photos: readonly PhotoIngestionRecord[]): PhotoIngestionStatement | null {
  if (photos.length === 0) {
    return null;
  }
  if (photos.length > PHOTO_INGESTION_FLUSH_SIZE) {
    throw new RangeError(
      `Photo ingestion statements support at most ${PHOTO_INGESTION_FLUSH_SIZE} records; received ${photos.length}.`,
    );
  }

  const placeholders = photos.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ");
  const parameters = photos.flatMap((photo) => [
    photo.id,
    photo.uri,
    photo.creationTime,
    photo.latitude,
    photo.longitude,
    photo.mediaType,
    photo.duration,
  ]);

  return {
    sql: `INSERT OR IGNORE INTO photos (
        id, uri, creationTime, latitude, longitude, mediaType, duration
      )
      VALUES ${placeholders}`,
    parameters,
    requestedCount: photos.length,
  };
}
