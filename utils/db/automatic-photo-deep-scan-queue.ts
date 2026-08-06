import { getDatabase } from "./core";
import {
  CLEAR_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
  COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL,
  GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL,
  IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL,
  MARK_AUTOMATIC_PHOTO_DEEP_SCAN_ATTEMPTS_SQL,
  MARK_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL,
  PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL,
  validateAutomaticPhotoDeepScanBatchLimit,
} from "./automatic-photo-deep-scan-queue-core";

async function getAutomaticPhotoStateFlag(source: string): Promise<boolean> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ isPending: number }>(source);
  return row?.isPending === 1;
}

export async function getAutomaticPhotoDeepScanQueueCount(): Promise<number> {
  const database = await getDatabase();
  const row = await database.getFirstAsync<{ pendingCount: number }>(COUNT_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL);
  return row?.pendingCount ?? 0;
}

export async function claimAutomaticPhotoDeepScanCandidates(limit: number): Promise<Array<{ id: string }>> {
  const database = await getDatabase();
  let candidates: Array<{ id: string }> = [];
  await database.withExclusiveTransactionAsync(async (transaction) => {
    candidates = await transaction.getAllAsync<{ id: string }>(
      GET_AUTOMATIC_PHOTO_DEEP_SCAN_CANDIDATES_SQL,
      validateAutomaticPhotoDeepScanBatchLimit(limit),
    );
    if (candidates.length > 0) {
      await transaction.runAsync(
        MARK_AUTOMATIC_PHOTO_DEEP_SCAN_ATTEMPTS_SQL,
        JSON.stringify(candidates.map((candidate) => candidate.id)),
      );
    }
  });
  return candidates;
}

export async function pruneAutomaticPhotoDeepScanQueue(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(PRUNE_AUTOMATIC_PHOTO_DEEP_SCAN_QUEUE_SQL);
}

export function isAutomaticPhotoQuickPipelineIncomplete(): Promise<boolean> {
  return getAutomaticPhotoStateFlag(IS_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL);
}

export async function clearAutomaticPhotoQuickPipelineIncomplete(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(CLEAR_AUTOMATIC_PHOTO_QUICK_PIPELINE_INCOMPLETE_SQL);
}

export function isAutomaticPhotoFoodSyncRequired(): Promise<boolean> {
  return getAutomaticPhotoStateFlag(IS_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL);
}

export async function markAutomaticPhotoFoodSyncRequired(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(MARK_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL);
}

export async function clearAutomaticPhotoFoodSyncRequired(): Promise<void> {
  const database = await getDatabase();
  await database.runAsync(CLEAR_AUTOMATIC_PHOTO_FOOD_SYNC_REQUIRED_SQL);
}
