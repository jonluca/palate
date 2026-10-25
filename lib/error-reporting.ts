import * as Sentry from "@sentry/react-native";
import Constants from "expo-constants";
import { createElement, type ComponentType } from "react";
import { errorCode, errorOperation, sanitizeErrorEvent, shouldReportError } from "./error-reporting-sanitizer";
import { HAS_NATIVE_RELEASE, MOBILE_RELEASE } from "./error-reporting-release";
import { ErrorFallback } from "./error-fallback";

let initialized = false;

export function initializeMobileErrorReporting(): void {
  if (initialized || !process.env.EXPO_PUBLIC_SENTRY_DSN) {
    return;
  }
  const environment = process.env.EXPO_PUBLIC_ERROR_REPORTING_ENVIRONMENT || "production";
  const verification = process.env.EXPO_PUBLIC_ERROR_REPORTING_DEBUG === "true" && environment === "verification";
  if ((__DEV__ || Constants.expoConfig?.extra?.errorReportingEnabled !== true) && !verification) {
    return;
  }
  initialized = true;
  const options: Parameters<typeof Sentry.init>[0] = {
    enabled: true,
    dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    environment,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    beforeSendTransaction: () => null,
    enableAutoBreadcrumbTracking: false,
    sendClientReports: false,
    enableLogs: false,
    enableAutoConsoleLogs: false,
    enableAutoSessionTracking: false,
    enableAutoPerformanceTracing: false,
    enableAppStartTracking: false,
    enableNativeFramesTracking: false,
    enableStallTracking: false,
    enableUserInteractionTracing: false,
    enableCaptureFailedRequests: false,
    attachScreenshot: false,
    attachViewHierarchy: false,
    reportAccessibilityIdentifier: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    integrations: (defaults) =>
      defaults.filter(
        (integration) =>
          !["Breadcrumbs", "HttpContext", "ExpoContext", "ExpoConstants", "ExpoUpdatesListener"].includes(
            integration.name,
          ),
      ),
    beforeBreadcrumb: () => null,
    beforeSend: sanitizeErrorEvent,
    initialScope: { tags: { surface: "mobile" }, user: { ip_address: "0.0.0.0" } },
  };
  if (HAS_NATIVE_RELEASE) {
    options.release = MOBILE_RELEASE;
  }
  Sentry.init(options);
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Thrown values enter this SDK boundary untrusted and are parsed before reporting.
export function captureMobileError(error: unknown, operation = "unhandled"): void {
  if (!initialized || !shouldReportError(error)) {
    return;
  }
  const code = errorCode(error);
  const operationTag = errorOperation(operation);
  const tags = code ? { operation: operationTag, error_code: code } : { operation: operationTag };
  Sentry.captureException(error, { tags });
}

export function withMobileErrorReporting<Props extends object>(component: ComponentType<Props>): ComponentType<Props> {
  return Sentry.withErrorBoundary(component, {
    fallback: ({ resetError }) => createElement(ErrorFallback, { resetError }),
  });
}
