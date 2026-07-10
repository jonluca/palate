export interface PhotoVisitAssociationUpdate {
  readonly photoIds: readonly string[];
  readonly visitId: string;
}

export interface PhotoVisitAssociation {
  readonly photoId: string;
  readonly visitId: string;
}

export interface PhotoVisitAssociationStatement {
  readonly sql: string;
  readonly parameters: string[];
}

// The previous literal CASE implementation split the raw association stream
// into 1,000-row statements. Duplicate IDs therefore used the first value in
// their final statement, rather than always using the first value globally.
export const LEGACY_PHOTO_VISIT_ASSOCIATION_BATCH_SIZE = 1_000;

// Two bind parameters are used per row. Staying below 999 keeps this portable
// across SQLite builds with the historical default variable limit.
export const PHOTO_VISIT_ASSOCIATION_BATCH_SIZE = 400;

/**
 * Flatten visit groups while preserving the previous batched CASE behavior.
 * The first occurrence inside each legacy statement wins, while the first
 * occurrence in a later statement replaces the earlier statement's result.
 */
export function flattenPhotoVisitAssociations(
  updates: readonly PhotoVisitAssociationUpdate[],
  legacyBatchSize = LEGACY_PHOTO_VISIT_ASSOCIATION_BATCH_SIZE,
): PhotoVisitAssociation[] {
  if (!Number.isSafeInteger(legacyBatchSize) || legacyBatchSize <= 0) {
    throw new RangeError(
      `Legacy photo association batch size must be a positive integer; received ${legacyBatchSize}.`,
    );
  }

  const associationsByPhotoId = new Map<string, PhotoVisitAssociation>();
  const seenInCurrentLegacyBatch = new Set<string>();
  let rawAssociationIndex = 0;

  for (const { photoIds, visitId } of updates) {
    for (const photoId of photoIds) {
      if (rawAssociationIndex % legacyBatchSize === 0) {
        seenInCurrentLegacyBatch.clear();
      }
      if (!seenInCurrentLegacyBatch.has(photoId)) {
        seenInCurrentLegacyBatch.add(photoId);
        associationsByPhotoId.set(photoId, { photoId, visitId });
      }
      rawAssociationIndex += 1;
    }
  }

  return [...associationsByPhotoId.values()];
}

export function buildPhotoVisitAssociationStatement(
  associations: readonly PhotoVisitAssociation[],
): PhotoVisitAssociationStatement {
  if (associations.length === 0) {
    throw new RangeError("At least one photo association is required.");
  }
  if (associations.length > PHOTO_VISIT_ASSOCIATION_BATCH_SIZE) {
    throw new RangeError(
      `Photo association batches cannot exceed ${PHOTO_VISIT_ASSOCIATION_BATCH_SIZE} rows; received ${associations.length}.`,
    );
  }

  const valuePlaceholders = associations.map(() => "(?, ?)").join(", ");
  return {
    sql: `WITH mapping(id, visitId) AS (VALUES ${valuePlaceholders})
      UPDATE photos AS target
      SET visitId = mapping.visitId
      FROM mapping
      WHERE target.id = mapping.id`,
    parameters: associations.flatMap(({ photoId, visitId }) => [photoId, visitId]),
  };
}
