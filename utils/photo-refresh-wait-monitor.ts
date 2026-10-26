export const PHOTO_REFRESH_SLOW_WAIT_MS = 60_000;

/** Reports an unusually slow wait without ending or cancelling the operation. */
export function monitorPhotoRefreshWait<Result>(
  operation: Promise<Result>,
  options: {
    shouldReport: () => boolean;
    onSlowWait: () => void;
  },
): Promise<Result> {
  const timer = setTimeout(() => {
    try {
      if (options.shouldReport()) {
        options.onSlowWait();
      }
    } catch {
      // Diagnostic failures must not interrupt the operation being observed.
    }
  }, PHOTO_REFRESH_SLOW_WAIT_MS);

  return operation.finally(() => {
    clearTimeout(timer);
  });
}
