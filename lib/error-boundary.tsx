import type { ErrorBoundaryProps } from "expo-router";
import { useEffect } from "react";
import { captureMobileError } from "./error-reporting";
import { ErrorFallback } from "./error-fallback";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    captureMobileError(error, "route.render");
  }, [error]);

  return <ErrorFallback resetError={() => void retry()} />;
}
