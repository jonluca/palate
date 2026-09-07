import type { PreferredAssetScanSession } from "./incremental-photo-scan-core";

/** A native snapshot has one importer; its lifecycle never belongs to a query cache. */
export interface PreparedPhotoScan {
  readonly pendingPhotoCount: number;
  readonly startedAt: number;
  claim(): PreferredAssetScanSession | null;
  complete(newlySkippedAssets: number): Promise<void>;
  dispose(): Promise<void>;
}

export function createPreparedPhotoScan(options: {
  pendingPhotoCount: number;
  startedAt: number;
  scan: PreferredAssetScanSession | null;
  checkpoint?: () => Promise<void>;
  release: () => Promise<void>;
}): PreparedPhotoScan {
  let state: "prepared" | "claimed" | "completed" | "disposed" = "prepared";
  let releasePromise: Promise<void> | undefined;

  return {
    pendingPhotoCount: options.pendingPhotoCount,
    startedAt: options.startedAt,
    claim() {
      if (state !== "prepared") {
        throw new Error(`Cannot claim a ${state} photo scan`);
      }
      state = "claimed";
      return options.scan;
    },
    async complete(newlySkippedAssets) {
      if (state !== "claimed" && !(state === "prepared" && options.pendingPhotoCount === 0)) {
        throw new Error(`Cannot complete a ${state} photo scan`);
      }
      if (!Number.isSafeInteger(newlySkippedAssets) || newlySkippedAssets < 0) {
        throw new Error("Invalid skipped-asset count for photo checkpoint");
      }
      state = "completed";
      // Do not move the watermark past an inaccessible asset. The next attempt
      // replays the same history, and INSERT OR IGNORE preserves completed rows.
      if (newlySkippedAssets === 0) {
        await options.checkpoint?.();
      }
    },
    dispose() {
      if (!releasePromise) {
        state = "disposed";
        releasePromise = Promise.resolve().then(options.release);
      }
      return releasePromise;
    },
  };
}
