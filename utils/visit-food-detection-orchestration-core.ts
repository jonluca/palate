import {
  runBufferedResultPersistence,
  type BufferedResultPersistenceOptions,
} from "./food-detection-persistence-core.ts";
import {
  commitAdaptiveVisitFoodTransition,
  createAdaptiveVisitFoodState,
  getAdaptiveVisitFoodWave,
  resolveAdaptiveVisitFoodAttempts,
  resolveAdaptiveVisitFoodWave,
  type AdaptiveVisitFoodAttempt,
  type AdaptiveVisitFoodOutcome,
  type AdaptiveVisitFoodSample,
  type AdaptiveVisitFoodState,
} from "./visit-food-adaptive-scan-core.ts";

/** Number of one-sample-per-active-visit waves before the remaining bulk tail. */
export const RANK3_BULK_TAIL_ADAPTIVE_WAVE_COUNT = 3;

export interface VisitFoodDetectionBatchProgress {
  /** Samples consumed by the current batch execution. */
  readonly processedSamples: number;
  /** Successful food-positive samples in the current batch execution. */
  readonly foodFoundSamples: number;
  /** Native failures plus missing native results in the current batch execution. */
  readonly retryableFailures: number;
}

export interface VisitFoodDetectionOrchestrationProgress {
  /** Attempted samples across every completed batch and the current batch prefix. */
  readonly processedSamples: number;
  /** Food-positive samples across every completed batch and the current batch prefix. */
  readonly foodFoundSamples: number;
  /** Retryable failures across every completed batch and the current batch prefix. */
  readonly retryableFailures: number;
}

export interface VisitFoodDetectionBatchContext<PersistedResult> {
  /** Appends one bounded page of successful native rows to shared persistence. */
  readonly appendResults: (results: readonly PersistedResult[]) => Promise<void>;
  /** Reports ordered progress local to this batch execution. */
  readonly onProgress: (progress: VisitFoodDetectionBatchProgress) => void;
}

export interface VisitFoodDetectionBatchExecution {
  /** Returned native outcomes. Omitted requested photos are interpreted as missing. */
  readonly outcomes: readonly AdaptiveVisitFoodOutcome[];
}

export interface Rank3BulkTailVisitFoodDetectionOptions<PersistedResult> {
  readonly samples: readonly AdaptiveVisitFoodSample[];
  readonly processBatch: (
    samples: readonly AdaptiveVisitFoodSample[],
    context: VisitFoodDetectionBatchContext<PersistedResult>,
  ) => Promise<VisitFoodDetectionBatchExecution>;
  readonly persist: (results: readonly PersistedResult[]) => Promise<void>;
  readonly synchronize: () => Promise<void>;
  readonly onProgress?: (progress: VisitFoodDetectionOrchestrationProgress) => void;
  readonly persistenceFlushSize?: number;
  readonly maximumPageSize?: number;
}

export interface Rank3BulkTailVisitFoodDetectionSummary {
  readonly totalPlannedSamples: number;
  readonly attemptedSamples: number;
  readonly foodFoundSamples: number;
  readonly retryableFailures: number;
  readonly positiveVisitIds: readonly string[];
  readonly failedPhotoIds: readonly string[];
  readonly missingPhotoIds: readonly string[];
  readonly skippedAfterPositive: readonly AdaptiveVisitFoodSample[];
}

function assertBatchProgress(progress: VisitFoodDetectionBatchProgress, batchSize: number): void {
  if (
    progress === null ||
    typeof progress !== "object" ||
    !Number.isSafeInteger(progress.processedSamples) ||
    progress.processedSamples < 0 ||
    progress.processedSamples > batchSize ||
    !Number.isSafeInteger(progress.foodFoundSamples) ||
    progress.foodFoundSamples < 0 ||
    progress.foodFoundSamples > progress.processedSamples ||
    !Number.isSafeInteger(progress.retryableFailures) ||
    progress.retryableFailures < 0 ||
    progress.retryableFailures > progress.processedSamples
  ) {
    throw new TypeError("Visit food-detection batch reported invalid progress.");
  }
}

function selectBulkTail(
  state: AdaptiveVisitFoodState,
  originalSamples: readonly AdaptiveVisitFoodSample[],
): AdaptiveVisitFoodSample[] {
  const positiveVisitIds = new Set(state.positiveVisitIds);
  return originalSamples.filter(
    (sample) => sample.sampleRank > RANK3_BULK_TAIL_ADAPTIVE_WAVE_COUNT && !positiveVisitIds.has(sample.visitId),
  );
}

function summarizeAttempts(attempts: readonly AdaptiveVisitFoodAttempt[]): {
  readonly foodFoundSamples: number;
  readonly retryableFailures: number;
} {
  let foodFoundSamples = 0;
  let retryableFailures = 0;
  for (const attempt of attempts) {
    if (attempt.status === "food") {
      foodFoundSamples += 1;
    } else if (attempt.status === "failed" || attempt.status === "missing") {
      retryableFailures += 1;
    }
  }
  return { foodFoundSamples, retryableFailures };
}

/**
 * Runs three adaptive rank waves followed by one stable visit-major bulk tail.
 * One shared persistence lifecycle owns every wave, and each adaptive transition
 * is committed only after its successful native rows pass an awaited checkpoint.
 */
export async function runRank3BulkTailVisitFoodDetection<PersistedResult>(
  options: Rank3BulkTailVisitFoodDetectionOptions<PersistedResult>,
): Promise<Rank3BulkTailVisitFoodDetectionSummary> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Rank3 bulk-tail visit food-detection options must be an object.");
  }
  if (typeof options.processBatch !== "function") {
    throw new TypeError("Rank3 bulk-tail batch processing must be a function.");
  }
  if (typeof options.persist !== "function") {
    throw new TypeError("Rank3 bulk-tail persistence must be a function.");
  }
  if (typeof options.synchronize !== "function") {
    throw new TypeError("Rank3 bulk-tail synchronization must be a function.");
  }
  if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
    throw new TypeError("Rank3 bulk-tail progress must be a function when provided.");
  }

  let state = createAdaptiveVisitFoodState(options.samples);
  let tailAttempts: readonly AdaptiveVisitFoodAttempt[] = [];
  let completedSamples = 0;
  let completedFoodFoundSamples = 0;
  let completedRetryableFailures = 0;

  const persistenceOptions: BufferedResultPersistenceOptions<PersistedResult, Rank3BulkTailVisitFoodDetectionSummary> =
    {
      persist: options.persist,
      synchronize: options.synchronize,
      persistenceFlushSize: options.persistenceFlushSize,
      maximumPageSize: options.maximumPageSize,
      process: async (appendResults, flushPendingResults) => {
        const processSamples = async (
          samples: readonly AdaptiveVisitFoodSample[],
        ): Promise<readonly AdaptiveVisitFoodOutcome[]> => {
          const execution = await options.processBatch(samples, {
            appendResults,
            onProgress: (progress) => {
              assertBatchProgress(progress, samples.length);
              // A terminal batch snapshot may include a sub-threshold remainder
              // that has only reached the shared buffer. Publish that boundary
              // from commitCompletedAttempts after the semantic checkpoint so
              // UI progress never advances beyond durable state or duplicates
              // the same completed-wave count.
              if (progress.processedSamples === samples.length) {
                return;
              }
              options.onProgress?.({
                processedSamples: completedSamples + progress.processedSamples,
                foodFoundSamples: completedFoodFoundSamples + progress.foodFoundSamples,
                retryableFailures: completedRetryableFailures + progress.retryableFailures,
              });
            },
          });
          if (execution === null || typeof execution !== "object") {
            throw new TypeError("Visit food-detection batch execution must return an object.");
          }
          return execution.outcomes;
        };

        const commitCompletedAttempts = (attempts: readonly AdaptiveVisitFoodAttempt[]): void => {
          const summary = summarizeAttempts(attempts);
          completedSamples += attempts.length;
          completedFoodFoundSamples += summary.foodFoundSamples;
          completedRetryableFailures += summary.retryableFailures;
          options.onProgress?.({
            processedSamples: completedSamples,
            foodFoundSamples: completedFoodFoundSamples,
            retryableFailures: completedRetryableFailures,
          });
        };

        while (!state.isComplete && state.nextRank <= RANK3_BULK_TAIL_ADAPTIVE_WAVE_COUNT) {
          const wave = getAdaptiveVisitFoodWave(state);
          const outcomes = await processSamples(wave);
          const transition = resolveAdaptiveVisitFoodWave(state, outcomes);
          await flushPendingResults();
          state = commitAdaptiveVisitFoodTransition(state, transition);
          commitCompletedAttempts(transition.attempts);
        }

        const tail = selectBulkTail(state, options.samples);
        if (tail.length > 0) {
          const outcomes = await processSamples(tail);
          tailAttempts = resolveAdaptiveVisitFoodAttempts(tail, outcomes);
          await flushPendingResults();
          commitCompletedAttempts(tailAttempts);
        }

        const allAttempts = [...state.attempts, ...tailAttempts];
        const positiveVisitIds = new Set(state.positiveVisitIds);
        const failedPhotoIds = [...state.failedPhotoIds];
        const missingPhotoIds = [...state.missingPhotoIds];
        for (const attempt of tailAttempts) {
          if (attempt.status === "food") {
            positiveVisitIds.add(attempt.sample.visitId);
          } else if (attempt.status === "failed") {
            failedPhotoIds.push(attempt.sample.photoId);
          } else if (attempt.status === "missing") {
            missingPhotoIds.push(attempt.sample.photoId);
          }
        }

        return {
          totalPlannedSamples: state.plan.totalSamples,
          attemptedSamples: allAttempts.length,
          foodFoundSamples: completedFoodFoundSamples,
          retryableFailures: completedRetryableFailures,
          positiveVisitIds: state.plan.visits
            .map(({ visitId }) => visitId)
            .filter((visitId) => positiveVisitIds.has(visitId)),
          failedPhotoIds,
          missingPhotoIds,
          skippedAfterPositive: state.skippedAfterPositive,
        };
      },
    };

  return runBufferedResultPersistence(persistenceOptions);
}
