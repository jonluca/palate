/** One deterministic photo candidate in a visit-level food-detection plan. */
export interface AdaptiveVisitFoodSample {
  readonly visitId: string;
  readonly photoId: string;
  readonly sampleRank: number;
}

/** One native Vision outcome returned for the current rank wave. */
export interface AdaptiveVisitFoodOutcome {
  readonly photoId: string;
  readonly status: "success" | "failure";
  /** Required for `success` and forbidden for `failure`. */
  readonly containsFood?: boolean;
}

export type AdaptiveVisitFoodAttemptStatus = "food" | "not-food" | "failed" | "missing";

/** Persistable interpretation of one attempted sample. */
export interface AdaptiveVisitFoodAttempt {
  readonly sample: AdaptiveVisitFoodSample;
  readonly status: AdaptiveVisitFoodAttemptStatus;
}

export interface AdaptiveVisitFoodPlanVisit {
  readonly visitId: string;
  readonly samples: readonly AdaptiveVisitFoodSample[];
}

/** Strict, immutable rank-wave input grouped in first-visit encounter order. */
export interface AdaptiveVisitFoodPlan {
  readonly visits: readonly AdaptiveVisitFoodPlanVisit[];
  readonly totalSamples: number;
  readonly maximumRank: number;
}

/**
 * Immutable committed state. Callers should persist a resolved transition's
 * attempts before adopting its `nextState` through
 * {@link commitAdaptiveVisitFoodTransition}.
 */
export interface AdaptiveVisitFoodState {
  readonly plan: AdaptiveVisitFoodPlan;
  readonly nextRank: number;
  readonly attempts: readonly AdaptiveVisitFoodAttempt[];
  readonly positiveVisitIds: readonly string[];
  readonly failedPhotoIds: readonly string[];
  readonly missingPhotoIds: readonly string[];
  readonly skippedAfterPositive: readonly AdaptiveVisitFoodSample[];
  readonly isComplete: boolean;
}

/** A side-effect-free candidate transition for one complete rank wave. */
export interface AdaptiveVisitFoodTransition {
  readonly previousState: AdaptiveVisitFoodState;
  readonly wave: readonly AdaptiveVisitFoodSample[];
  readonly attempts: readonly AdaptiveVisitFoodAttempt[];
  readonly nextState: AdaptiveVisitFoodState;
}

function assertIdentifier(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${description} must be a non-empty string.`);
  }
}

function assertSampleRank(value: unknown, description: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${description} must be a positive safe integer.`);
  }
}

/**
 * Validate and group a visit-major SQL sample plan. Ranks must start at one and
 * be contiguous inside every visit; photo identifiers are globally unique.
 */
export function createAdaptiveVisitFoodPlan(samples: readonly AdaptiveVisitFoodSample[]): AdaptiveVisitFoodPlan {
  if (!Array.isArray(samples)) {
    throw new TypeError("Adaptive visit food samples must be an array.");
  }

  const visitsById = new Map<string, Map<number, AdaptiveVisitFoodSample>>();
  const visitOrder: string[] = [];
  const photoIds = new Set<string>();

  for (const [index, sample] of samples.entries()) {
    if (sample === null || typeof sample !== "object") {
      throw new TypeError(`Adaptive visit food sample ${index} must be an object.`);
    }
    assertIdentifier(sample.visitId, `Adaptive visit food sample ${index} visitId`);
    assertIdentifier(sample.photoId, `Adaptive visit food sample ${index} photoId`);
    assertSampleRank(sample.sampleRank, `Adaptive visit food sample ${index} sampleRank`);

    if (photoIds.has(sample.photoId)) {
      throw new TypeError(`Adaptive visit food samples contain duplicate photoId ${JSON.stringify(sample.photoId)}.`);
    }
    photoIds.add(sample.photoId);

    let rankedSamples = visitsById.get(sample.visitId);
    if (!rankedSamples) {
      rankedSamples = new Map<number, AdaptiveVisitFoodSample>();
      visitsById.set(sample.visitId, rankedSamples);
      visitOrder.push(sample.visitId);
    }
    if (rankedSamples.has(sample.sampleRank)) {
      throw new TypeError(
        `Adaptive visit food samples contain duplicate rank ${sample.sampleRank} for visit ${JSON.stringify(sample.visitId)}.`,
      );
    }
    rankedSamples.set(sample.sampleRank, {
      visitId: sample.visitId,
      photoId: sample.photoId,
      sampleRank: sample.sampleRank,
    });
  }

  let maximumRank = 0;
  const visits = visitOrder.map((visitId): AdaptiveVisitFoodPlanVisit => {
    const rankedSamples = visitsById.get(visitId);
    if (!rankedSamples) {
      throw new Error("Adaptive visit food plan lost a validated visit.");
    }
    const orderedSamples = [...rankedSamples.values()].sort((left, right) => left.sampleRank - right.sampleRank);
    for (const [index, sample] of orderedSamples.entries()) {
      const expectedRank = index + 1;
      if (sample.sampleRank !== expectedRank) {
        throw new TypeError(
          `Adaptive visit food samples for visit ${JSON.stringify(visitId)} skip rank ${expectedRank}.`,
        );
      }
    }
    maximumRank = Math.max(maximumRank, orderedSamples.length);
    return { visitId, samples: orderedSamples };
  });

  return { visits, totalSamples: samples.length, maximumRank };
}

function buildWave(
  plan: AdaptiveVisitFoodPlan,
  rank: number,
  positiveVisitIds: ReadonlySet<string>,
): AdaptiveVisitFoodSample[] {
  const wave: AdaptiveVisitFoodSample[] = [];
  for (const visit of plan.visits) {
    if (positiveVisitIds.has(visit.visitId)) {
      continue;
    }
    const sample = visit.samples[rank - 1];
    if (sample) {
      wave.push(sample);
    }
  }
  return wave;
}

export function createAdaptiveVisitFoodState(
  samplesOrPlan: readonly AdaptiveVisitFoodSample[] | AdaptiveVisitFoodPlan,
): AdaptiveVisitFoodState {
  const plan = Array.isArray(samplesOrPlan)
    ? createAdaptiveVisitFoodPlan(samplesOrPlan)
    : (samplesOrPlan as AdaptiveVisitFoodPlan);
  return {
    plan,
    nextRank: 1,
    attempts: [],
    positiveVisitIds: [],
    failedPhotoIds: [],
    missingPhotoIds: [],
    skippedAfterPositive: [],
    isComplete: plan.totalSamples === 0,
  };
}

/** Return the next one-sample-per-active-visit wave without changing state. */
export function getAdaptiveVisitFoodWave(state: AdaptiveVisitFoodState): readonly AdaptiveVisitFoodSample[] {
  if (state.isComplete) {
    return [];
  }
  return buildWave(state.plan, state.nextRank, new Set(state.positiveVisitIds));
}

function indexOutcomes(
  wave: readonly AdaptiveVisitFoodSample[],
  outcomes: readonly AdaptiveVisitFoodOutcome[],
): ReadonlyMap<string, AdaptiveVisitFoodOutcome> {
  if (!Array.isArray(outcomes)) {
    throw new TypeError("Adaptive visit food outcomes must be an array.");
  }
  const wavePhotoIds = new Set(wave.map(({ photoId }) => photoId));
  const outcomesByPhotoId = new Map<string, AdaptiveVisitFoodOutcome>();

  for (const [index, outcome] of outcomes.entries()) {
    if (outcome === null || typeof outcome !== "object") {
      throw new TypeError(`Adaptive visit food outcome ${index} must be an object.`);
    }
    assertIdentifier(outcome.photoId, `Adaptive visit food outcome ${index} photoId`);
    if (!wavePhotoIds.has(outcome.photoId)) {
      throw new TypeError(
        `Adaptive visit food outcome ${index} references photo ${JSON.stringify(outcome.photoId)} outside the current wave.`,
      );
    }
    if (outcomesByPhotoId.has(outcome.photoId)) {
      throw new TypeError(`Adaptive visit food outcomes contain duplicate photoId ${JSON.stringify(outcome.photoId)}.`);
    }
    if (outcome.status === "success") {
      if (typeof outcome.containsFood !== "boolean") {
        throw new TypeError(`Successful adaptive visit food outcome ${index} must include containsFood.`);
      }
    } else if (outcome.status === "failure") {
      if (outcome.containsFood !== undefined) {
        throw new TypeError(`Failed adaptive visit food outcome ${index} cannot include containsFood.`);
      }
    } else {
      throw new TypeError(`Adaptive visit food outcome ${index} has an invalid status.`);
    }
    outcomesByPhotoId.set(outcome.photoId, outcome);
  }
  return outcomesByPhotoId;
}

/** Interpret native outcomes for an ordered set of validated planned samples. */
export function resolveAdaptiveVisitFoodAttempts(
  samples: readonly AdaptiveVisitFoodSample[],
  outcomes: readonly AdaptiveVisitFoodOutcome[],
): readonly AdaptiveVisitFoodAttempt[] {
  const outcomesByPhotoId = indexOutcomes(samples, outcomes);
  return samples.map((sample): AdaptiveVisitFoodAttempt => {
    const outcome = outcomesByPhotoId.get(sample.photoId);
    if (!outcome) {
      return { sample, status: "missing" };
    }
    if (outcome.status === "failure") {
      return { sample, status: "failed" };
    }
    return { sample, status: outcome.containsFood ? "food" : "not-food" };
  });
}

/**
 * Resolve one wave without mutating or committing the prior state. An omitted
 * result is a retryable `missing` attempt; a returned native failure is
 * `failed`. Both advance the visit to its next planned sample.
 */
export function resolveAdaptiveVisitFoodWave(
  state: AdaptiveVisitFoodState,
  outcomes: readonly AdaptiveVisitFoodOutcome[],
): AdaptiveVisitFoodTransition {
  if (state.isComplete) {
    throw new Error("Cannot resolve a completed adaptive visit food scan.");
  }
  const wave = getAdaptiveVisitFoodWave(state);
  if (wave.length === 0) {
    throw new Error("Adaptive visit food state is incomplete but has no next wave.");
  }
  const positiveVisitIds = new Set(state.positiveVisitIds);
  const failedPhotoIds = [...state.failedPhotoIds];
  const missingPhotoIds = [...state.missingPhotoIds];
  const skippedAfterPositive = [...state.skippedAfterPositive];
  const attempts = resolveAdaptiveVisitFoodAttempts(wave, outcomes);
  const visitsById = new Map(state.plan.visits.map((visit) => [visit.visitId, visit]));

  for (const attempt of attempts) {
    if (attempt.status === "missing") {
      missingPhotoIds.push(attempt.sample.photoId);
    } else if (attempt.status === "failed") {
      failedPhotoIds.push(attempt.sample.photoId);
    } else if (attempt.status === "food") {
      positiveVisitIds.add(attempt.sample.visitId);
      const visit = visitsById.get(attempt.sample.visitId);
      if (!visit) {
        throw new Error("Adaptive visit food wave references an unknown validated visit.");
      }
      skippedAfterPositive.push(...visit.samples.slice(attempt.sample.sampleRank));
    }
  }

  const nextRank = state.nextRank + 1;
  const nextWave = buildWave(state.plan, nextRank, positiveVisitIds);
  const nextState: AdaptiveVisitFoodState = {
    plan: state.plan,
    nextRank,
    attempts: [...state.attempts, ...attempts],
    positiveVisitIds: state.plan.visits
      .map(({ visitId }) => visitId)
      .filter((visitId) => positiveVisitIds.has(visitId)),
    failedPhotoIds,
    missingPhotoIds,
    skippedAfterPositive,
    isComplete: nextWave.length === 0,
  };

  return { previousState: state, wave, attempts, nextState };
}

/** Adopt a resolved transition only after its attempts have persisted. */
export function commitAdaptiveVisitFoodTransition(
  state: AdaptiveVisitFoodState,
  transition: AdaptiveVisitFoodTransition,
): AdaptiveVisitFoodState {
  if (transition.previousState !== state) {
    throw new Error("Adaptive visit food transition does not belong to the supplied committed state.");
  }
  return transition.nextState;
}
