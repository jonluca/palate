# Crash and error reporting

Production native builds report unexpected JavaScript errors, render failures, and native crashes to the `palate` project in the `jonluca-apps` organization at https://errors.watchtrader.net/.

The Sentry React Native SDK starts before the JavaScript bundle through its Expo native-init plugin. The JavaScript entry point initializes the sanitizer before Expo Router. Development builds leave reporting disabled. A new native build is required; existing installed binaries cannot acquire a native crash reporter through a JavaScript-only update.

## Build configuration

The EAS `production` environment supplies `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_ERROR_REPORTING_ENVIRONMENT`, `SENTRY_URL`, `SENTRY_ORG`, and `SENTRY_PROJECT`. `SENTRY_AUTH_TOKEN` is an EAS **secret**, used only while uploading private debug files. Production builds use `EAS_BUILD_PROFILE=production`. For an authorized local production archive, load the same variables securely and set that profile explicitly.

The Expo plugin uploads dSYMs and Hermes source maps during native builds; Metro adds debug IDs. Keep `sentry.options.json`, `sentry.properties`, `.sentryclirc`, the upload token, and debug artifacts out of Git and public assets. Do not disable uploads for a distributed production build. GlitchTip 6.2.6's artifact-assembly polling is incompatible with `sentry-cli --wait`/`--wait-for`; ordinary uploads work. Confirm processed artifacts in the GlitchTip release after the build.

## Privacy

Reporting is error-only: no session replay, screenshots, view hierarchy, performance traces, logs, automatic breadcrumbs, account identity, request payloads, or query parameters. The JavaScript sanitizer allowlists stack frames and release/device/runtime metadata and removes application messages that can contain user data. Native crash payloads bypass JavaScript callbacks, so this project's collector-side scrubbing additionally removes native exception reasons and installation/device identifiers. CrashData is declared in the iOS privacy manifest.

Handled errors may be sent with `captureMobileError(error, "fixed.operation_name")`; never use user input, URLs, filenames, content, or account identifiers as the operation. Expected authorization/validation/cancellation failures are excluded. Verify deliberate crashes in the separate verification project, never the production project.
