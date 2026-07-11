export const DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY = "off";
export const WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY = "windowed-v1";

export type PhotoAssetThumbnailPreheatStrategy =
  | typeof DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY
  | typeof WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY;

export const INITIAL_PHOTO_ASSET_THUMBNAIL_PREHEAT_ROW_COUNT = 24;
export const PHOTO_ASSET_THUMBNAIL_PREHEAT_AHEAD_ROW_COUNT = 3;
export const PHOTO_ASSET_THUMBNAIL_PREHEAT_BEHIND_ROW_COUNT = 1;
export const DEFAULT_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE = 24;
export const MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE = 64;

// Keep these bounds identical to PhotoAssetThumbnailTarget so an accepted JavaScript plan
// cannot be rejected after crossing the native boundary.
export const MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_DIMENSION = 8_192;
export const MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_PIXEL_COUNT = 8_388_608;

export interface PhotoAssetThumbnailPixelTarget {
  readonly pixelWidth: number;
  readonly pixelHeight: number;
}

export interface PhotoAssetThumbnailPreheatStrategyResolutionOptions {
  /** Exact strategy constant advertised by the installed native binary. */
  readonly nativeValue?: unknown;
  /** Whether the binary also exposes the native preheat method. */
  readonly nativeMethodAvailable?: boolean;
  /** Local kill switch. Omitted means enabled. */
  readonly enabled?: boolean;
}

/**
 * Resolve the native preheat strategy conservatively. Missing constants or methods indicate an
 * older binary, while malformed future values remain disabled until JavaScript understands them.
 */
export function resolvePhotoAssetThumbnailPreheatStrategy(
  options?: PhotoAssetThumbnailPreheatStrategyResolutionOptions | null,
): PhotoAssetThumbnailPreheatStrategy {
  if (
    options?.enabled !== false &&
    options?.nativeMethodAvailable === true &&
    options.nativeValue === WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY
  ) {
    return WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY;
  }
  return DISABLED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY;
}

export interface PhotoAssetThumbnailPointTarget {
  readonly pointWidth: number;
  readonly pointHeight: number;
  readonly scale: number;
}

/** Convert point dimensions to the same exact, upward-rounded pixel target used by native code. */
export function resolvePhotoAssetThumbnailPixelTarget(
  target: PhotoAssetThumbnailPointTarget,
): PhotoAssetThumbnailPixelTarget | null {
  if (
    !Number.isFinite(target.pointWidth) ||
    !Number.isFinite(target.pointHeight) ||
    !Number.isFinite(target.scale) ||
    target.pointWidth <= 0 ||
    target.pointHeight <= 0 ||
    target.scale <= 0
  ) {
    return null;
  }

  const pixelWidth = Math.ceil(target.pointWidth * target.scale);
  const pixelHeight = Math.ceil(target.pointHeight * target.scale);
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight) ||
    pixelWidth <= 0 ||
    pixelHeight <= 0 ||
    pixelWidth > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_DIMENSION ||
    pixelHeight > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_DIMENSION ||
    pixelWidth * pixelHeight > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_PIXEL_COUNT
  ) {
    return null;
  }

  return { pixelWidth, pixelHeight };
}

export interface PhotoAssetThumbnailPreheatPlanOptions extends PhotoAssetThumbnailPointTarget {
  readonly strategy: PhotoAssetThumbnailPreheatStrategy;
  /** Each nested array contains the ph:// URIs rendered by one list row. */
  readonly photoRows: readonly (readonly unknown[])[];
  /** Viewable row indices from the list callback. Missing/invalid entries use the initial plan. */
  readonly visibleRowIndices?: readonly unknown[] | null;
  /** Optional smaller cap; values cannot increase the hard native-bridge payload bound. */
  readonly maximumPayloadSize?: number;
}

export interface PhotoAssetThumbnailPreheatPlan {
  readonly strategy: typeof WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY;
  readonly selection: "initial" | "window";
  readonly rowIndices: readonly number[];
  readonly uris: readonly string[];
  readonly target: PhotoAssetThumbnailPixelTarget;
}

export interface PhotoAssetThumbnailPreheatBridgeRequest {
  readonly scopeID: string;
  readonly uris: readonly string[];
  readonly target: PhotoAssetThumbnailPixelTarget;
}

export interface PhotoAssetThumbnailPreheatProducerState {
  /** `initial` is reserved for bootstrap or data changes with no retained valid visible rows. */
  readonly selection: "initial" | "window";
  /** Last nonempty viewability window. Empty only while the producer is in its initial state. */
  readonly visibleRowIndices: readonly number[];
}

export type PhotoAssetThumbnailPreheatProducerEvent =
  | { readonly type: "data-change" }
  | { readonly type: "refresh" }
  | { readonly type: "viewability"; readonly visibleRowIndices: readonly unknown[] };

export interface PhotoAssetThumbnailPreheatProducerTransition {
  readonly state: PhotoAssetThumbnailPreheatProducerState;
  /** `null` means retain the current native window without crossing the bridge. */
  readonly visibleRowIndicesToPlan: readonly number[] | null;
}

/** Create the bootstrap state. Its empty rows intentionally select the bounded initial plan. */
export function createPhotoAssetThumbnailPreheatProducerState(): PhotoAssetThumbnailPreheatProducerState {
  return { selection: "initial", visibleRowIndices: [] };
}

function normalizedProducerRowIndices(values: readonly unknown[], rowCount: number): number[] {
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    return [];
  }
  const indices = new Set<number>();
  for (const value of values) {
    if (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < rowCount) {
      indices.add(value as number);
    }
  }
  return [...indices].sort((left, right) => left - right);
}

function equalRowIndices(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Advance the list producer without confusing a transient empty viewability callback with a data
 * change. Empty callbacks retain the previous window and are bridge no-ops. Data changes clamp the
 * retained window to the new row count; row zero is selected only during bootstrap or when none of
 * the retained rows still exist.
 */
export function transitionPhotoAssetThumbnailPreheatProducer(
  state: PhotoAssetThumbnailPreheatProducerState,
  event: PhotoAssetThumbnailPreheatProducerEvent,
  rowCount: number,
): PhotoAssetThumbnailPreheatProducerTransition {
  if (event.type === "data-change") {
    if (state.selection === "window") {
      const retainedVisibleRowIndices = normalizedProducerRowIndices(state.visibleRowIndices, rowCount);
      if (retainedVisibleRowIndices.length > 0) {
        const nextState = equalRowIndices(state.visibleRowIndices, retainedVisibleRowIndices)
          ? state
          : { selection: "window" as const, visibleRowIndices: retainedVisibleRowIndices };
        return { state: nextState, visibleRowIndicesToPlan: retainedVisibleRowIndices };
      }
    }

    const nextState = createPhotoAssetThumbnailPreheatProducerState();
    return { state: nextState, visibleRowIndicesToPlan: nextState.visibleRowIndices };
  }

  if (event.type === "refresh") {
    return { state, visibleRowIndicesToPlan: state.visibleRowIndices };
  }

  const visibleRowIndices = normalizedProducerRowIndices(event.visibleRowIndices, rowCount);
  if (visibleRowIndices.length === 0) {
    return { state, visibleRowIndicesToPlan: null };
  }
  if (state.selection === "window" && equalRowIndices(state.visibleRowIndices, visibleRowIndices)) {
    return { state, visibleRowIndicesToPlan: null };
  }

  const nextState: PhotoAssetThumbnailPreheatProducerState = {
    selection: "window",
    visibleRowIndices,
  };
  return { state: nextState, visibleRowIndicesToPlan: nextState.visibleRowIndices };
}

function orderedVisibleRowIndices(values: readonly unknown[] | null | undefined, rowCount: number): number[] {
  if (!values || rowCount === 0) {
    return [];
  }

  const indices = new Set<number>();
  for (const value of values) {
    if (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) < rowCount) {
      indices.add(value as number);
    }
  }
  return [...indices].sort((left, right) => left - right);
}

function selectRows(
  visibleRowIndices: readonly unknown[] | null | undefined,
  rowCount: number,
): Pick<PhotoAssetThumbnailPreheatPlan, "selection" | "rowIndices"> {
  const visible = orderedVisibleRowIndices(visibleRowIndices, rowCount);
  if (visible.length === 0) {
    return {
      selection: "initial",
      rowIndices: Array.from(
        { length: Math.min(rowCount, INITIAL_PHOTO_ASSET_THUMBNAIL_PREHEAT_ROW_COUNT) },
        (_, index) => index,
      ),
    };
  }

  const firstVisible = visible[0];
  const lastVisible = visible[visible.length - 1];
  const rowIndices = [...visible];
  for (let distance = 1; distance <= PHOTO_ASSET_THUMBNAIL_PREHEAT_AHEAD_ROW_COUNT; distance++) {
    const index = lastVisible + distance;
    if (index < rowCount) {
      rowIndices.push(index);
    }
  }
  for (let distance = 1; distance <= PHOTO_ASSET_THUMBNAIL_PREHEAT_BEHIND_ROW_COUNT; distance++) {
    const index = firstVisible - distance;
    if (index >= 0) {
      rowIndices.push(index);
    }
  }

  return { selection: "window", rowIndices };
}

function payloadSizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 0;
  }
  return Math.min(value, MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE);
}

function isPhotoAssetUri(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("ph://") && value.length > "ph://".length;
}

/**
 * Validate the public JavaScript/native boundary before Expo converts numbers to Swift `Int`.
 * The input is sliced before filtering so no caller can serialize more than the native hard cap.
 */
export function preparePhotoAssetThumbnailPreheatBridgeRequest(
  scopeID: unknown,
  uris: unknown,
  target: unknown,
): PhotoAssetThumbnailPreheatBridgeRequest | null {
  if (typeof scopeID !== "string" || scopeID.length === 0 || !Array.isArray(uris)) {
    return null;
  }
  if (typeof target !== "object" || target === null) {
    return null;
  }
  const pixelWidth = Reflect.get(target, "pixelWidth");
  const pixelHeight = Reflect.get(target, "pixelHeight");
  if (
    !Number.isSafeInteger(pixelWidth) ||
    !Number.isSafeInteger(pixelHeight) ||
    (pixelWidth as number) <= 0 ||
    (pixelHeight as number) <= 0 ||
    (pixelWidth as number) > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_DIMENSION ||
    (pixelHeight as number) > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_DIMENSION ||
    (pixelWidth as number) * (pixelHeight as number) > MAXIMUM_PHOTO_ASSET_THUMBNAIL_TARGET_PIXEL_COUNT
  ) {
    return null;
  }

  const boundedUris: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris.slice(0, MAXIMUM_PHOTO_ASSET_THUMBNAIL_PREHEAT_PAYLOAD_SIZE)) {
    if (!isPhotoAssetUri(uri) || seen.has(uri)) {
      continue;
    }
    seen.add(uri);
    boundedUris.push(uri);
  }

  return {
    scopeID,
    uris: boundedUris,
    target: {
      pixelWidth: pixelWidth as number,
      pixelHeight: pixelHeight as number,
    },
  };
}

/**
 * Build one bounded native bridge payload. URI order follows list priority and exact duplicates
 * retain only their first occurrence. Disabled strategies and invalid targets are safe no-ops.
 */
export function planPhotoAssetThumbnailPreheat(
  options: PhotoAssetThumbnailPreheatPlanOptions,
): PhotoAssetThumbnailPreheatPlan | null {
  if (options.strategy !== WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY) {
    return null;
  }

  const target = resolvePhotoAssetThumbnailPixelTarget(options);
  if (!target) {
    return null;
  }

  const selection = selectRows(options.visibleRowIndices, options.photoRows.length);
  const limit = payloadSizeLimit(options.maximumPayloadSize);
  const seen = new Set<string>();
  const uris: string[] = [];

  for (const rowIndex of selection.rowIndices) {
    for (const candidate of options.photoRows[rowIndex]) {
      if (uris.length >= limit) {
        break;
      }
      if (!isPhotoAssetUri(candidate) || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      uris.push(candidate);
    }
    if (uris.length >= limit) {
      break;
    }
  }

  return {
    strategy: WINDOWED_PHOTO_ASSET_THUMBNAIL_PREHEAT_STRATEGY,
    selection: selection.selection,
    rowIndices: selection.rowIndices,
    uris,
    target,
  };
}
