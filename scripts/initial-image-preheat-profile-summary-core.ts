export interface InitialImagePreheatProfileArmSummary {
  readonly arm: "control" | "windowedPreheat";
  /** Time measured only inside the lead request session. */
  readonly medianLeadPhaseMilliseconds: number;
  /** Time measured only inside the target request session. */
  readonly medianTargetPhaseMilliseconds: number;
  /** Lead validation plus the metrics barrier before the target request is submitted. */
  readonly medianInterphaseMilliseconds: number;
  /** Continuous time from before preheat submission through target terminal completion. */
  readonly medianEndToEndMilliseconds: number;
  readonly measurementCount: number;
  readonly failureCount: number;
  readonly timedOutCount: number;
}

export interface InitialImagePreheatProfileCountSummary {
  readonly imageCount: number;
  readonly expectedPreheatedKeyCount: number;
  readonly control: InitialImagePreheatProfileArmSummary;
  readonly windowedPreheat: InitialImagePreheatProfileArmSummary;
  readonly targetSpeedup: number;
  readonly targetReductionPercent: number;
  readonly endToEndSpeedup: number;
  readonly endToEndReductionPercent: number;
  readonly candidateWonTargetMeasurements: number;
  readonly candidateWonEndToEndMeasurements: number;
  readonly scheduleValidationPassed: boolean;
  readonly correctnessValidationPassed: boolean;
  readonly targetPerformancePassed: boolean;
  readonly endToEndPerformancePassed: boolean;
  readonly validationPassed: boolean;
}

export interface InitialImagePreheatBounds {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly preheatEstimatedBytesPerPixel: number;
  readonly preheatMaximumPixelCount: number;
  readonly preheatMaximumEstimatedByteCount: number;
  readonly preheatMaximumKeyCount: number;
}

interface ProfileConfiguration extends InitialImagePreheatBounds {
  readonly imageCounts: readonly number[];
  readonly iterations: number;
}

interface PreheatMetrics {
  readonly updateCount: number;
  readonly startedKeyCount: number;
  readonly activeKeyCount: number;
  readonly pendingKeyCount: number;
  readonly cacheStartCallCount: number;
}

interface AssetFetchSchedulerMetrics {
  readonly supersededPreheatBatchCount: number;
  readonly supersededPreheatIdentifierCount: number;
  readonly visiblePromotionIdentifierCount: number;
  readonly removedQueuedVisibleIdentifierCount: number;
  readonly invalidatedInFlightBatchCount: number;
  readonly invalidatedInFlightIdentifierCount: number;
  readonly maximumQueuedPreheatIdentifierCount: number;
  readonly maximumQueuedVisibleIdentifierCount: number;
  readonly preheatBatchCount: number;
  readonly preheatBatchIdentifierCount: number;
  readonly visibleBatchCount: number;
  readonly visibleBatchIdentifierCount: number;
  readonly activeBatchPriority: "visible" | "preheat" | null;
  readonly queuedPreheatIdentifierCount: number;
  readonly queuedVisibleIdentifierCount: number;
  readonly isQuiescent: boolean;
}

interface StoreMetrics {
  readonly assetFetchBatchCount: number;
  readonly assetFetchIdentifierCount: number;
  readonly imageRequestCount: number;
  readonly assetFetchScheduler: AssetFetchSchedulerMetrics;
  readonly preheat: PreheatMetrics;
}

interface Measurement {
  readonly arm: "control" | "windowedPreheat";
  readonly imageCount: number;
  readonly iteration: number;
  readonly samplePosition: "earlier" | "later";
  readonly executedFirst: boolean;
  readonly lead: {
    readonly elapsedMilliseconds: number;
    readonly failureCount: number;
    readonly timedOutCount: number;
    readonly requestedCount: number;
    readonly finalCount: number;
  };
  readonly target: {
    readonly allTerminalMilliseconds: number;
    readonly failureCount: number;
    readonly timedOutCount: number;
    readonly requestedCount: number;
    readonly finalCount: number;
    readonly unexpectedEventCount: number;
    readonly duplicateTerminalEventCount: number;
    readonly invalidDimensionCount: number;
  };
  readonly continuousTiming: {
    readonly elapsedThroughTargetTerminalMilliseconds: number;
    readonly phaseMarkers: {
      readonly preheatSubmittedMilliseconds: number | null;
      readonly leadRequestStartedMilliseconds: number;
      readonly leadTerminalMilliseconds: number;
      readonly leadValidationCompletedMilliseconds: number;
      readonly metricsAfterLeadCapturedMilliseconds: number;
      readonly targetRequestStartedMilliseconds: number;
      readonly targetTerminalMilliseconds: number;
      readonly targetValidationCompletedMilliseconds: number;
      readonly metricsAfterTargetCapturedMilliseconds: number;
    };
  };
  readonly metricsAfterLead: StoreMetrics;
  readonly metricsAfterTarget: StoreMetrics;
}

export interface InitialImagePreheatProfileSummary {
  readonly sourceSchemaVersion: number;
  readonly sourceBenchmarkSchemaVersion: number;
  readonly authorizationStatus: string;
  readonly sampledIdentifierCount: number;
  readonly disjointLeadAndTargetWindows: boolean;
  readonly counts: readonly InitialImagePreheatProfileCountSummary[];
  readonly validationPassed: boolean;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (parsed < 0) {
    throw new TypeError(`${label} must be non-negative`);
  }
  return parsed;
}

function integer(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed === 0) {
    throw new TypeError(`${label} must be positive`);
  }
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new RangeError("Cannot calculate a median from an empty sample");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function parsePreheatMetrics(value: unknown, label: string): PreheatMetrics {
  const metrics = object(value, label);
  return {
    updateCount: integer(metrics.updateCount, `${label}.updateCount`),
    startedKeyCount: integer(metrics.startedKeyCount, `${label}.startedKeyCount`),
    activeKeyCount: integer(metrics.activeKeyCount, `${label}.activeKeyCount`),
    pendingKeyCount: integer(metrics.pendingKeyCount, `${label}.pendingKeyCount`),
    cacheStartCallCount: integer(metrics.cacheStartCallCount, `${label}.cacheStartCallCount`),
  };
}

function parseAssetFetchSchedulerMetrics(value: unknown, label: string): AssetFetchSchedulerMetrics {
  const metrics = object(value, label);
  const rawPriority = metrics.activeBatchPriority;
  if (rawPriority !== undefined && rawPriority !== null && rawPriority !== "visible" && rawPriority !== "preheat") {
    throw new TypeError(`${label}.activeBatchPriority is invalid`);
  }
  return {
    supersededPreheatBatchCount: integer(metrics.supersededPreheatBatchCount, `${label}.supersededPreheatBatchCount`),
    supersededPreheatIdentifierCount: integer(
      metrics.supersededPreheatIdentifierCount,
      `${label}.supersededPreheatIdentifierCount`,
    ),
    visiblePromotionIdentifierCount: integer(
      metrics.visiblePromotionIdentifierCount,
      `${label}.visiblePromotionIdentifierCount`,
    ),
    removedQueuedVisibleIdentifierCount: integer(
      metrics.removedQueuedVisibleIdentifierCount,
      `${label}.removedQueuedVisibleIdentifierCount`,
    ),
    invalidatedInFlightBatchCount: integer(
      metrics.invalidatedInFlightBatchCount,
      `${label}.invalidatedInFlightBatchCount`,
    ),
    invalidatedInFlightIdentifierCount: integer(
      metrics.invalidatedInFlightIdentifierCount,
      `${label}.invalidatedInFlightIdentifierCount`,
    ),
    maximumQueuedPreheatIdentifierCount: integer(
      metrics.maximumQueuedPreheatIdentifierCount,
      `${label}.maximumQueuedPreheatIdentifierCount`,
    ),
    maximumQueuedVisibleIdentifierCount: integer(
      metrics.maximumQueuedVisibleIdentifierCount,
      `${label}.maximumQueuedVisibleIdentifierCount`,
    ),
    preheatBatchCount: integer(metrics.preheatBatchCount, `${label}.preheatBatchCount`),
    preheatBatchIdentifierCount: integer(metrics.preheatBatchIdentifierCount, `${label}.preheatBatchIdentifierCount`),
    visibleBatchCount: integer(metrics.visibleBatchCount, `${label}.visibleBatchCount`),
    visibleBatchIdentifierCount: integer(metrics.visibleBatchIdentifierCount, `${label}.visibleBatchIdentifierCount`),
    activeBatchPriority: rawPriority === undefined || rawPriority === null ? null : rawPriority,
    queuedPreheatIdentifierCount: integer(
      metrics.queuedPreheatIdentifierCount,
      `${label}.queuedPreheatIdentifierCount`,
    ),
    queuedVisibleIdentifierCount: integer(
      metrics.queuedVisibleIdentifierCount,
      `${label}.queuedVisibleIdentifierCount`,
    ),
    isQuiescent: boolean(metrics.isQuiescent, `${label}.isQuiescent`),
  };
}

function parseStoreMetrics(value: unknown, label: string): StoreMetrics {
  const metrics = object(value, label);
  return {
    assetFetchBatchCount: integer(metrics.assetFetchBatchCount, `${label}.assetFetchBatchCount`),
    assetFetchIdentifierCount: integer(metrics.assetFetchIdentifierCount, `${label}.assetFetchIdentifierCount`),
    imageRequestCount: integer(metrics.imageRequestCount, `${label}.imageRequestCount`),
    assetFetchScheduler: parseAssetFetchSchedulerMetrics(metrics.assetFetchScheduler, `${label}.assetFetchScheduler`),
    preheat: parsePreheatMetrics(metrics.preheat, `${label}.preheat`),
  };
}

function parseMeasurement(value: unknown, index: number): Measurement {
  const label = `measurements[${index}]`;
  const measurement = object(value, label);
  const arm = measurement.arm;
  if (arm !== "control" && arm !== "windowedPreheat") {
    throw new TypeError(`${label}.arm is invalid`);
  }
  const samplePosition = measurement.samplePosition;
  if (samplePosition !== "earlier" && samplePosition !== "later") {
    throw new TypeError(`${label}.samplePosition is invalid`);
  }
  const lead = object(measurement.lead, `${label}.lead`);
  const target = object(measurement.target, `${label}.target`);
  const continuousTiming = object(measurement.continuousTiming, `${label}.continuousTiming`);
  const phaseMarkers = object(continuousTiming.phaseMarkers, `${label}.continuousTiming.phaseMarkers`);
  const metricsAfterLead = object(measurement.metricsAfterLead, `${label}.metricsAfterLead`);
  const metricsAfterTarget = object(measurement.metricsAfterTarget, `${label}.metricsAfterTarget`);
  const rawPreheatMarker = phaseMarkers.preheatSubmittedMilliseconds;

  return {
    arm,
    imageCount: positiveInteger(measurement.imageCount, `${label}.imageCount`),
    iteration: positiveInteger(measurement.iteration, `${label}.iteration`),
    samplePosition,
    executedFirst: boolean(measurement.executedFirst, `${label}.executedFirst`),
    lead: {
      elapsedMilliseconds: nonNegativeNumber(lead.elapsedMilliseconds, `${label}.lead.elapsedMilliseconds`),
      failureCount: integer(lead.failureCount, `${label}.lead.failureCount`),
      timedOutCount: integer(lead.timedOutCount, `${label}.lead.timedOutCount`),
      requestedCount: integer(lead.requestedCount, `${label}.lead.requestedCount`),
      finalCount: integer(lead.finalCount, `${label}.lead.finalCount`),
    },
    target: {
      allTerminalMilliseconds: nonNegativeNumber(
        target.allTerminalMilliseconds,
        `${label}.target.allTerminalMilliseconds`,
      ),
      failureCount: integer(target.failureCount, `${label}.target.failureCount`),
      timedOutCount: integer(target.timedOutCount, `${label}.target.timedOutCount`),
      requestedCount: integer(target.requestedCount, `${label}.target.requestedCount`),
      finalCount: integer(target.finalCount, `${label}.target.finalCount`),
      unexpectedEventCount: integer(target.unexpectedEventCount, `${label}.target.unexpectedEventCount`),
      duplicateTerminalEventCount: integer(
        target.duplicateTerminalEventCount,
        `${label}.target.duplicateTerminalEventCount`,
      ),
      invalidDimensionCount: integer(target.invalidDimensionCount, `${label}.target.invalidDimensionCount`),
    },
    continuousTiming: {
      elapsedThroughTargetTerminalMilliseconds: nonNegativeNumber(
        continuousTiming.elapsedThroughTargetTerminalMilliseconds,
        `${label}.continuousTiming.elapsedThroughTargetTerminalMilliseconds`,
      ),
      phaseMarkers: {
        preheatSubmittedMilliseconds:
          rawPreheatMarker === undefined || rawPreheatMarker === null
            ? null
            : nonNegativeNumber(
                rawPreheatMarker,
                `${label}.continuousTiming.phaseMarkers.preheatSubmittedMilliseconds`,
              ),
        leadRequestStartedMilliseconds: nonNegativeNumber(
          phaseMarkers.leadRequestStartedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.leadRequestStartedMilliseconds`,
        ),
        leadTerminalMilliseconds: nonNegativeNumber(
          phaseMarkers.leadTerminalMilliseconds,
          `${label}.continuousTiming.phaseMarkers.leadTerminalMilliseconds`,
        ),
        leadValidationCompletedMilliseconds: nonNegativeNumber(
          phaseMarkers.leadValidationCompletedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.leadValidationCompletedMilliseconds`,
        ),
        metricsAfterLeadCapturedMilliseconds: nonNegativeNumber(
          phaseMarkers.metricsAfterLeadCapturedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.metricsAfterLeadCapturedMilliseconds`,
        ),
        targetRequestStartedMilliseconds: nonNegativeNumber(
          phaseMarkers.targetRequestStartedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.targetRequestStartedMilliseconds`,
        ),
        targetTerminalMilliseconds: nonNegativeNumber(
          phaseMarkers.targetTerminalMilliseconds,
          `${label}.continuousTiming.phaseMarkers.targetTerminalMilliseconds`,
        ),
        targetValidationCompletedMilliseconds: nonNegativeNumber(
          phaseMarkers.targetValidationCompletedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.targetValidationCompletedMilliseconds`,
        ),
        metricsAfterTargetCapturedMilliseconds: nonNegativeNumber(
          phaseMarkers.metricsAfterTargetCapturedMilliseconds,
          `${label}.continuousTiming.phaseMarkers.metricsAfterTargetCapturedMilliseconds`,
        ),
      },
    },
    metricsAfterLead: parseStoreMetrics(metricsAfterLead, `${label}.metricsAfterLead`),
    metricsAfterTarget: parseStoreMetrics(metricsAfterTarget, `${label}.metricsAfterTarget`),
  };
}

function scheduleIsValid(
  controlMeasurements: readonly Measurement[],
  candidateMeasurements: readonly Measurement[],
  expectedIterations: number,
): boolean {
  if (expectedIterations % 4 !== 0) {
    return false;
  }

  const controlByIteration = new Map<number, Measurement>();
  for (const measurement of controlMeasurements) {
    if (measurement.iteration > expectedIterations || controlByIteration.has(measurement.iteration)) {
      return false;
    }
    controlByIteration.set(measurement.iteration, measurement);
  }

  const candidateByIteration = new Map<number, Measurement>();
  for (const measurement of candidateMeasurements) {
    if (measurement.iteration > expectedIterations || candidateByIteration.has(measurement.iteration)) {
      return false;
    }
    candidateByIteration.set(measurement.iteration, measurement);
  }

  if (controlByIteration.size !== expectedIterations || candidateByIteration.size !== expectedIterations) {
    return false;
  }

  const candidateCombinationCounts = new Map<string, number>();
  for (let iteration = 1; iteration <= expectedIterations; iteration++) {
    const control = controlByIteration.get(iteration);
    const candidate = candidateByIteration.get(iteration);
    if (
      !control ||
      !candidate ||
      control.samplePosition === candidate.samplePosition ||
      control.executedFirst === candidate.executedFirst
    ) {
      return false;
    }
    const combination = `${candidate.samplePosition}:${candidate.executedFirst ? "first" : "second"}`;
    candidateCombinationCounts.set(combination, (candidateCombinationCounts.get(combination) ?? 0) + 1);
  }

  const expectedCombinationCount = expectedIterations / 4;
  return ["earlier:first", "earlier:second", "later:first", "later:second"].every(
    (combination) => candidateCombinationCounts.get(combination) === expectedCombinationCount,
  );
}

function parseProfileConfiguration(value: unknown): ProfileConfiguration {
  const configuration = object(value, "initialImagePreheat.configuration");
  if (!Array.isArray(configuration.imageCounts) || configuration.imageCounts.length === 0) {
    throw new TypeError("initialImagePreheat.configuration.imageCounts must be a non-empty array");
  }
  return {
    imageCounts: configuration.imageCounts.map((value, index) =>
      positiveInteger(value, `initialImagePreheat.configuration.imageCounts[${index}]`),
    ),
    iterations: positiveInteger(configuration.iterations, "initialImagePreheat.configuration.iterations"),
    pixelWidth: positiveInteger(configuration.pixelWidth, "initialImagePreheat.configuration.pixelWidth"),
    pixelHeight: positiveInteger(configuration.pixelHeight, "initialImagePreheat.configuration.pixelHeight"),
    preheatEstimatedBytesPerPixel: positiveInteger(
      configuration.preheatEstimatedBytesPerPixel,
      "initialImagePreheat.configuration.preheatEstimatedBytesPerPixel",
    ),
    preheatMaximumPixelCount: integer(
      configuration.preheatMaximumPixelCount,
      "initialImagePreheat.configuration.preheatMaximumPixelCount",
    ),
    preheatMaximumEstimatedByteCount: integer(
      configuration.preheatMaximumEstimatedByteCount,
      "initialImagePreheat.configuration.preheatMaximumEstimatedByteCount",
    ),
    preheatMaximumKeyCount: integer(
      configuration.preheatMaximumKeyCount,
      "initialImagePreheat.configuration.preheatMaximumKeyCount",
    ),
  };
}

export function expectedInitialImagePreheatActiveKeyCount(
  imageCountValue: number,
  bounds: InitialImagePreheatBounds,
): number {
  const imageCount = integer(imageCountValue, "imageCount");
  const pixelWidth = positiveInteger(bounds.pixelWidth, "pixelWidth");
  const pixelHeight = positiveInteger(bounds.pixelHeight, "pixelHeight");
  const bytesPerPixel = positiveInteger(bounds.preheatEstimatedBytesPerPixel, "preheatEstimatedBytesPerPixel");
  const maximumPixelCount = integer(bounds.preheatMaximumPixelCount, "preheatMaximumPixelCount");
  const maximumEstimatedByteCount = integer(
    bounds.preheatMaximumEstimatedByteCount,
    "preheatMaximumEstimatedByteCount",
  );
  const maximumKeyCount = integer(bounds.preheatMaximumKeyCount, "preheatMaximumKeyCount");
  const pixelsPerKey = BigInt(pixelWidth) * BigInt(pixelHeight);
  const bytesPerKey = pixelsPerKey * BigInt(bytesPerPixel);
  const capacity = [
    BigInt(imageCount),
    BigInt(maximumKeyCount),
    BigInt(maximumPixelCount) / pixelsPerKey,
    BigInt(maximumEstimatedByteCount) / bytesPerKey,
  ].reduce((minimum, value) => (value < minimum ? value : minimum));
  return Number(capacity);
}

function armSummary(
  arm: Measurement["arm"],
  measurements: readonly Measurement[],
): InitialImagePreheatProfileArmSummary {
  const matching = measurements.filter((measurement) => measurement.arm === arm);
  return {
    arm,
    measurementCount: matching.length,
    medianLeadPhaseMilliseconds: median(matching.map((measurement) => measurement.lead.elapsedMilliseconds)),
    medianTargetPhaseMilliseconds: median(matching.map((measurement) => measurement.target.allTerminalMilliseconds)),
    medianInterphaseMilliseconds: median(
      matching.map(
        (measurement) =>
          measurement.continuousTiming.phaseMarkers.targetRequestStartedMilliseconds -
          measurement.continuousTiming.phaseMarkers.leadTerminalMilliseconds,
      ),
    ),
    medianEndToEndMilliseconds: median(
      matching.map((measurement) => measurement.continuousTiming.elapsedThroughTargetTerminalMilliseconds),
    ),
    failureCount: matching.reduce(
      (total, measurement) => total + measurement.lead.failureCount + measurement.target.failureCount,
      0,
    ),
    timedOutCount: matching.reduce(
      (total, measurement) => total + measurement.lead.timedOutCount + measurement.target.timedOutCount,
      0,
    ),
  };
}

function preheatMetricsAreZero(metrics: PreheatMetrics): boolean {
  return (
    metrics.updateCount === 0 &&
    metrics.startedKeyCount === 0 &&
    metrics.activeKeyCount === 0 &&
    metrics.pendingKeyCount === 0 &&
    metrics.cacheStartCallCount === 0
  );
}

function assetFetchSchedulerAttestationIsValid(metrics: StoreMetrics): boolean {
  const scheduler = metrics.assetFetchScheduler;
  const derivedQuiescence =
    scheduler.activeBatchPriority === null &&
    scheduler.queuedPreheatIdentifierCount === 0 &&
    scheduler.queuedVisibleIdentifierCount === 0;
  return (
    scheduler.isQuiescent &&
    scheduler.isQuiescent === derivedQuiescence &&
    metrics.assetFetchBatchCount === scheduler.preheatBatchCount + scheduler.visibleBatchCount &&
    metrics.assetFetchIdentifierCount === scheduler.preheatBatchIdentifierCount + scheduler.visibleBatchIdentifierCount
  );
}

function timingIsValid(measurement: Measurement): boolean {
  const timing = measurement.continuousTiming;
  const markers = timing.phaseMarkers;
  const orderedMarkers = [
    markers.leadRequestStartedMilliseconds,
    markers.leadTerminalMilliseconds,
    markers.leadValidationCompletedMilliseconds,
    markers.metricsAfterLeadCapturedMilliseconds,
    markers.targetRequestStartedMilliseconds,
    markers.targetTerminalMilliseconds,
    markers.targetValidationCompletedMilliseconds,
    markers.metricsAfterTargetCapturedMilliseconds,
  ];
  const ordered = orderedMarkers.every((marker, index) => index === 0 || marker >= orderedMarkers[index - 1]);
  const preheatMarkerIsValid =
    measurement.arm === "windowedPreheat"
      ? markers.preheatSubmittedMilliseconds !== null &&
        markers.preheatSubmittedMilliseconds <= markers.leadRequestStartedMilliseconds
      : markers.preheatSubmittedMilliseconds === null;
  const toleranceMilliseconds = 0.001;
  const leadSessionIsContained =
    markers.leadTerminalMilliseconds - markers.leadRequestStartedMilliseconds + toleranceMilliseconds >=
    measurement.lead.elapsedMilliseconds;
  const targetSessionIsContained =
    markers.targetTerminalMilliseconds - markers.targetRequestStartedMilliseconds + toleranceMilliseconds >=
    measurement.target.allTerminalMilliseconds;
  return (
    ordered &&
    preheatMarkerIsValid &&
    timing.elapsedThroughTargetTerminalMilliseconds === markers.targetTerminalMilliseconds &&
    leadSessionIsContained &&
    targetSessionIsContained
  );
}

export function summarizeInitialImagePreheatProfile(value: unknown): InitialImagePreheatProfileSummary {
  const report = object(value, "report");
  if (report.status !== "ok" || report.authorizationStatus !== "authorized") {
    throw new Error("Profile must be successful and authorized for the real Photos library");
  }
  const reportConfiguration = object(report.configuration, "configuration");
  if (reportConfiguration.mode !== "initial-image-preheat") {
    throw new Error("Profile mode must be initial-image-preheat");
  }
  const profile = object(report.initialImagePreheat, "initialImagePreheat");
  const benchmarkSchemaVersion = integer(profile.schemaVersion, "initialImagePreheat.schemaVersion");
  if (benchmarkSchemaVersion !== 2) {
    throw new Error("Initial-image preheat benchmark schema 2 is required for continuous timing");
  }
  const profileConfiguration = parseProfileConfiguration(profile.configuration);
  if (!Array.isArray(profile.measurements)) {
    throw new TypeError("initialImagePreheat.measurements must be an array");
  }
  const measurements = profile.measurements.map(parseMeasurement);
  const configuredImageCounts = [...new Set(profileConfiguration.imageCounts)].sort((left, right) => left - right);
  const configuredImageCountSet = new Set(configuredImageCounts);
  const onlyConfiguredCounts = measurements.every((measurement) => configuredImageCountSet.has(measurement.imageCount));
  const counts = configuredImageCounts.map((imageCount): InitialImagePreheatProfileCountSummary => {
    const matching = measurements.filter((measurement) => measurement.imageCount === imageCount);
    const controlMeasurements = matching.filter((measurement) => measurement.arm === "control");
    const candidateMeasurements = matching.filter((measurement) => measurement.arm === "windowedPreheat");
    const control = armSummary("control", matching);
    const windowedPreheat = armSummary("windowedPreheat", matching);
    const targetSpeedup = control.medianTargetPhaseMilliseconds / windowedPreheat.medianTargetPhaseMilliseconds;
    const endToEndSpeedup = control.medianEndToEndMilliseconds / windowedPreheat.medianEndToEndMilliseconds;
    const controlByIteration = new Map(controlMeasurements.map((measurement) => [measurement.iteration, measurement]));
    const candidateWonTargetMeasurements = candidateMeasurements.filter((candidate) => {
      const controlMeasurement = controlByIteration.get(candidate.iteration);
      return (
        controlMeasurement &&
        candidate.target.allTerminalMilliseconds < controlMeasurement.target.allTerminalMilliseconds
      );
    }).length;
    const candidateWonEndToEndMeasurements = candidateMeasurements.filter((candidate) => {
      const controlMeasurement = controlByIteration.get(candidate.iteration);
      return (
        controlMeasurement &&
        candidate.continuousTiming.elapsedThroughTargetTerminalMilliseconds <
          controlMeasurement.continuousTiming.elapsedThroughTargetTerminalMilliseconds
      );
    }).length;
    const expectedPreheatedKeyCount = expectedInitialImagePreheatActiveKeyCount(imageCount, profileConfiguration);
    const expectedCacheStartCallCount = expectedPreheatedKeyCount === 0 ? 0 : 1;
    const measurementValidation = matching.every((measurement) => {
      const complete =
        measurement.lead.requestedCount === imageCount &&
        measurement.lead.finalCount === imageCount &&
        measurement.target.requestedCount === imageCount &&
        measurement.target.finalCount === imageCount &&
        measurement.lead.failureCount === 0 &&
        measurement.target.failureCount === 0 &&
        measurement.lead.timedOutCount === 0 &&
        measurement.target.timedOutCount === 0 &&
        measurement.target.unexpectedEventCount === 0 &&
        measurement.target.duplicateTerminalEventCount === 0 &&
        measurement.target.invalidDimensionCount === 0 &&
        assetFetchSchedulerAttestationIsValid(measurement.metricsAfterLead) &&
        assetFetchSchedulerAttestationIsValid(measurement.metricsAfterTarget) &&
        timingIsValid(measurement);
      if (measurement.arm === "control") {
        return (
          complete &&
          preheatMetricsAreZero(measurement.metricsAfterLead.preheat) &&
          preheatMetricsAreZero(measurement.metricsAfterTarget.preheat)
        );
      }
      const metricsAreExpected = (metrics: PreheatMetrics) =>
        metrics.updateCount === 1 &&
        metrics.startedKeyCount === expectedPreheatedKeyCount &&
        metrics.activeKeyCount === expectedPreheatedKeyCount &&
        metrics.pendingKeyCount === 0 &&
        metrics.cacheStartCallCount === expectedCacheStartCallCount;
      return (
        complete &&
        metricsAreExpected(measurement.metricsAfterLead.preheat) &&
        metricsAreExpected(measurement.metricsAfterTarget.preheat)
      );
    });
    const iterationCountsAreExpected =
      control.measurementCount === profileConfiguration.iterations &&
      windowedPreheat.measurementCount === profileConfiguration.iterations;
    const scheduleValidationPassed = scheduleIsValid(
      controlMeasurements,
      candidateMeasurements,
      profileConfiguration.iterations,
    );
    const correctnessValidationPassed = iterationCountsAreExpected && scheduleValidationPassed && measurementValidation;
    const targetPerformancePassed =
      candidateMeasurements.length > 0 && candidateWonTargetMeasurements === candidateMeasurements.length;
    const endToEndPerformancePassed = Number.isFinite(endToEndSpeedup) && endToEndSpeedup > 1;
    return {
      imageCount,
      expectedPreheatedKeyCount,
      control,
      windowedPreheat,
      targetSpeedup,
      targetReductionPercent: (1 - 1 / targetSpeedup) * 100,
      endToEndSpeedup,
      endToEndReductionPercent: (1 - 1 / endToEndSpeedup) * 100,
      candidateWonTargetMeasurements,
      candidateWonEndToEndMeasurements,
      scheduleValidationPassed,
      correctnessValidationPassed,
      targetPerformancePassed,
      endToEndPerformancePassed,
      validationPassed: correctnessValidationPassed && targetPerformancePassed && endToEndPerformancePassed,
    };
  });

  const disjointLeadAndTargetWindows = profile.disjointLeadAndTargetWindows === true;
  const validationPassed =
    disjointLeadAndTargetWindows &&
    onlyConfiguredCounts &&
    counts.length > 0 &&
    counts.every((count) => count.validationPassed);
  return {
    sourceSchemaVersion: integer(report.schemaVersion, "schemaVersion"),
    sourceBenchmarkSchemaVersion: benchmarkSchemaVersion,
    authorizationStatus: report.authorizationStatus,
    sampledIdentifierCount: integer(profile.sampledIdentifierCount, "initialImagePreheat.sampledIdentifierCount"),
    disjointLeadAndTargetWindows,
    counts,
    validationPassed,
  };
}
