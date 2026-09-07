#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { MutationObserver, QueryClient, QueryObserver } from "@tanstack/query-core";
import ts from "typescript";
import { getDeepScanSummary } from "../utils/deep-scan-summary.ts";

function compile(path) {
  return ts.transpileModule(readFileSync(new URL(path, import.meta.url), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
}

const compiledCard = compile("../components/settings/deep-scan-card.tsx");
const compiledHook = compile("../hooks/use-scan.ts");
const compiledScreen = compile("../app/(app)/rescan.tsx");
const jsx = (type, props) => ({ type, props });
const summaryModule = { getDeepScanSummary };
const react = {
  useCallback: (callback) => callback,
  useRef: (current) => ({ current }),
  useState: (initial) => [initial, () => undefined],
};

function load(compiled, modules) {
  const exports = {};
  runInNewContext(compiled, {
    exports,
    console: { error: () => undefined },
    require: (name) => {
      assert.ok(modules.has(name), `Missing module fixture: ${name}`);
      return modules.get(name);
    },
  });
  return exports;
}

function findElement(node, predicate) {
  if (!node) {
    return undefined;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (predicate(node)) {
    return node;
  }
  return findElement(node.props?.children, predicate);
}

function progress(overrides = {}) {
  return {
    totalPhotos: 1,
    processedPhotos: 1,
    foodPhotosFound: 1,
    retryableFailures: 0,
    isComplete: true,
    elapsedMs: 100,
    photosPerSecond: 10,
    etaMs: 0,
    ...overrides,
  };
}

function strategyModule(validation = false, nativeAvailable = true) {
  return {
    isBatchAssetInfoAvailable: () => nativeAvailable,
    getResolvedVisitFoodDetectionStrategy: () => "full-plan-v1",
    isVisionVisitFoodValidationModeEnabled: () => validation,
    allowsAutomaticDeepScanFollowup: (_strategy, isValidation) => !isValidation,
  };
}

function cardFixture(options = {}) {
  const effects = [];
  const stateSlots = [];
  const refSlots = [];
  let stateCursor = 0;
  let refCursor = 0;
  const cardReact = {
    ...react,
    useState: (initial) => {
      const index = stateCursor++;
      if (!(index in stateSlots)) {
        stateSlots[index] = initial;
      }
      return [
        stateSlots[index],
        (value) => {
          stateSlots[index] = value;
        },
      ];
    },
    useRef: (current) => {
      const index = refCursor++;
      return (refSlots[index] ??= { current });
    },
    useEffect: (effect) => effects.push(effect),
  };
  const calls = { requests: [], toasts: [], haptics: [], alerts: [], starts: 0, resets: 0, pendingReads: 0 };
  const state = {
    isScanning: options.busy ?? false,
    isBackgroundPhotoScanRunning: false,
    startScan: () => {
      if (state.isScanning || state.isBackgroundPhotoScanRunning) {
        return false;
      }
      calls.starts++;
      state.isScanning = true;
      return true;
    },
    resetScan: () => {
      calls.resets++;
      state.isScanning = false;
    },
  };
  const useAppStore = Object.assign((selector) => selector(state), { getState: () => state });
  const modules = new Map([
    ["react", cardReact],
    ["react/jsx-runtime", { jsx, jsxs: jsx }],
    [
      "react-native",
      {
        ActivityIndicator: "ActivityIndicator",
        View: "View",
        Alert: { alert: (...args) => calls.alerts.push(args) },
      },
    ],
    [
      "expo-haptics",
      {
        ImpactFeedbackStyle: { Medium: "medium" },
        NotificationFeedbackType: { Success: "success", Error: "error", Warning: "warning" },
        impactAsync: async () => undefined,
        notificationAsync: async (type) => calls.haptics.push(type),
      },
    ],
    [
      "@tanstack/react-query",
      { useQueryClient: () => options.queryClient ?? { invalidateQueries: async () => undefined } },
    ],
    ["@/components/themed-text", { ThemedText: "ThemedText" }],
    ["@/components/icon-symbol", { IconSymbol: "IconSymbol" }],
    ["@/components/ui", { Button: "Button", ButtonText: "ButtonText", Card: "Card" }],
    ["@/components/ui/toast", { useToast: () => ({ showToast: (toast) => calls.toasts.push(toast) }) }],
    [
      "@/hooks/queries",
      {
        queryKeys: { unanalyzedPhotoCount: ["unanalyzed"] },
        useUnanalyzedPhotoCount: () => ({
          data: options.readPendingCount?.() ?? options.pending ?? 1,
        }),
        useDeepScan:
          options.useDeepScan ??
          (() => ({
            isPending: false,
            mutateAsync: async (request) => {
              calls.requests.push(request);
              if (options.operation) {
                return options.operation();
              }
              return options.result ?? progress();
            },
          })),
      },
    ],
    ["@/services/scanner", { formatEta: () => "1s" }],
    [
      "@/utils/db",
      {
        getUnanalyzedPhotoIds: async () => {
          calls.pendingReads++;
          return options.pendingIds ?? [{ id: "pending-only" }];
        },
      },
    ],
    ["@/utils/deep-scan-summary", summaryModule],
    ["@/modules/batch-asset-info", strategyModule(options.validation, options.nativeAvailable)],
    ["@/store", { useAppStore }],
  ]);
  const { DeepScanCard } = load(compiledCard, modules);
  let tree;
  const render = () => {
    stateCursor = 0;
    refCursor = 0;
    tree = DeepScanCard({ autoStart: options.autoStart ?? false });
    return tree;
  };
  const getButton = () => findElement(tree, (element) => element.props?.accessibilityLabel === "Deep Scan All Photos");
  const confirm = async () => {
    const button = getButton();
    assert.ok(button, "Manual deep scan must be visible when eligible photos remain");
    button.props.onPress();
    const action = calls.alerts.at(-1)?.[2].find((item) => item.text === "Start Deep Scan");
    assert.ok(action);
    await action.onPress();
  };
  render();
  return {
    get tree() {
      return tree;
    },
    get button() {
      return getButton();
    },
    calls,
    effects,
    state,
    confirm,
    render,
  };
}

// Exercise the rendered production card and its actual confirmation callback.
{
  const fixture = cardFixture({ pending: 1 });
  await fixture.confirm();
  assert.equal(fixture.calls.requests.length, 1);
  assert.deepEqual(fixture.calls.requests, [[{ id: "pending-only" }]]);
  assert.equal(fixture.calls.pendingReads, 1, "Manual scans must select eligible pending IDs");
  assert.match(fixture.calls.alerts[0][1], /every remaining photo/);
  assert.equal(fixture.calls.toasts[0].message, "Found 1 food photo in 1 analyzed photo");
  assert.equal(fixture.calls.toasts[0].type, "success");
  assert.deepEqual(fixture.calls.haptics, ["success"]);
  assert.equal(fixture.calls.starts, 1);
  assert.equal(fixture.calls.resets, 1);
}

for (const autoStart of [false, true]) {
  const fixture = cardFixture({ pending: 0, autoStart });
  assert.equal(fixture.tree, null, "The card must hide when no eligible photos remain");
  for (const effect of fixture.effects) {
    effect();
  }
  await new Promise(setImmediate);
  assert.equal(fixture.calls.requests.length, 0);
  assert.equal(fixture.calls.pendingReads, 0);
}

{
  const fixture = cardFixture({ pending: 1, pendingIds: [] });
  await fixture.confirm();
  assert.equal(fixture.calls.requests.length, 0, "A stale pending count must not start an empty scan");
  assert.equal(fixture.calls.toasts[0].message, "No photos left to deep scan");
  assert.equal(fixture.calls.toasts[0].type, "info");
  assert.equal(fixture.calls.resets, 1);
}

for (const testCase of [
  {
    result: progress({ foodPhotosFound: 0, retryableFailures: 1 }),
    type: "error",
    haptic: "error",
    message: "Could not analyze 1 photo.",
  },
  {
    result: progress({ totalPhotos: 3, processedPhotos: 3, retryableFailures: 1 }),
    type: "info",
    haptic: "warning",
    message: "Found 1 food photo in 2 analyzed photos; 1 photo could not be analyzed",
  },
  {
    result: progress({ totalPhotos: 0, processedPhotos: 0, foodPhotosFound: 0 }),
    type: "info",
    haptic: "warning",
    message: "No photos available to deep scan.",
  },
]) {
  const fixture = cardFixture({ result: testCase.result });
  await fixture.confirm();
  assert.equal(fixture.calls.toasts[0].type, testCase.type);
  assert.equal(fixture.calls.toasts[0].message, testCase.message);
  assert.deepEqual(fixture.calls.haptics, [testCase.haptic]);
  assert.equal(fixture.state.isScanning, false);
}

{
  const fixture = cardFixture({ autoStart: true, pending: 1 });
  for (const effect of fixture.effects) {
    effect();
  }
  await new Promise(setImmediate);
  assert.equal(fixture.calls.pendingReads, 1);
  assert.deepEqual(fixture.calls.requests, [[{ id: "pending-only" }]]);
  assert.equal(fixture.calls.resets, 1);
}

{
  const fixture = cardFixture({ autoStart: true, pending: 1, validation: true });
  for (const effect of fixture.effects) {
    effect();
  }
  await new Promise(setImmediate);
  assert.equal(fixture.calls.requests.length, 0, "Validation must suppress automatic scanning");
  const manual = cardFixture({ pending: 1, validation: true });
  await manual.confirm();
  assert.deepEqual(manual.calls.requests, [[{ id: "pending-only" }]], "Validation must retain its explicit trigger");
}

{
  const fixture = cardFixture({ busy: true });
  assert.equal(fixture.button.props.disabled, true);
  fixture.button.props.onPress();
  assert.equal(fixture.calls.alerts.length, 0);
  assert.equal(fixture.calls.requests.length, 0);
}

{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = cardFixture({ operation: () => gate });
  fixture.button.props.onPress();
  const action = fixture.calls.alerts[0][2].find((item) => item.text === "Start Deep Scan");
  const operation = action.onPress();
  await action.onPress();
  assert.equal(fixture.calls.requests.length, 1, "Repeated confirmation must share the scan lock");
  release(progress());
  await operation;
  assert.equal(fixture.calls.resets, 1);
}

{
  const fixture = cardFixture({
    operation: async () => {
      throw new Error("Vision unavailable");
    },
  });
  await fixture.confirm();
  assert.equal(fixture.calls.toasts[0].type, "error");
  assert.deepEqual(fixture.calls.haptics, ["error"]);
  assert.equal(fixture.calls.resets, 1, "A failed mutation must release the scan lock");
}

function deferred() {
  return Promise.withResolvers();
}

// Load the production hook and invalidation helper without unrelated native imports.
// MutationObserver and QueryObserver below retain TanStack's real settlement behavior.
function loadDeepScanMutation(bindings) {
  const source = ts.createSourceFile(
    "queries.ts",
    readFileSync(new URL("../hooks/queries.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set(["PHOTO_ANALYSIS_MUTATION_SCOPE", "invalidateFoodDetectionQueries", "useDeepScan"]);
  const declarations = source.statements.filter((statement) => {
    if (ts.isFunctionDeclaration(statement)) {
      return statement.name && names.has(statement.name.text);
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && names.has(declaration.name.text),
      )
    );
  });
  assert.equal(declarations.length, names.size, "The mutation fixture must exercise the production declarations");
  const compiled = ts.transpileModule(declarations.map((statement) => statement.getText(source)).join("\n"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, ...bindings });
  return exports.useDeepScan;
}

function mutationFixture(mutationOptions) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const pendingKey = ["unanalyzed"];
  const scan = deferred();
  const refetch = deferred();
  const calls = { requests: [], refreshes: 0, invalidations: [] };
  const invalidateQueries = queryClient.invalidateQueries.bind(queryClient);
  queryClient.invalidateQueries = (filters) => {
    calls.invalidations.push(filters);
    return invalidateQueries(filters);
  };
  queryClient.setQueryData(pendingKey, 1);
  const queryObserver = new QueryObserver(queryClient, {
    queryKey: pendingKey,
    staleTime: Infinity,
    queryFn: () => {
      calls.refreshes++;
      return refetch.promise;
    },
  });
  const unsubscribe = queryObserver.subscribe(() => undefined);
  let observer;
  const productionUseDeepScan = loadDeepScanMutation({
    queryKeys: { unanalyzedPhotoCount: pendingKey, photosWithLabelsCount: ["labels"] },
    mutationKeys: { photoAnalysis: ["analysis"] },
    useQueryClient: () => queryClient,
    useRef: (current) => ({ current }),
    useEffect: (effect) => effect(),
    useMutation: (options) => {
      if (!observer) {
        observer = new MutationObserver(queryClient, options);
      } else {
        observer.setOptions(options);
      }
      return { ...observer.getCurrentResult(), mutateAsync: (request) => observer.mutate(request) };
    },
    deepScanAllPhotosForFood: async (options) => {
      calls.requests.push(options);
      options.onProgress?.(progress({ foodPhotosFound: 0, retryableFailures: 1, isComplete: false }));
      return scan.promise;
    },
    invalidateVisitStatusQueries: async () => undefined,
    invalidatePendingReviewQuery: async () => undefined,
  });
  return {
    queryClient,
    pendingKey,
    calls,
    scan,
    refetch,
    useDeepScan: (onProgress) => productionUseDeepScan(onProgress, mutationOptions),
    get isPending() {
      return observer?.getCurrentResult().isPending ?? false;
    },
    dispose: () => {
      unsubscribe();
      queryClient.clear();
    },
  };
}

for (const outcome of ["recovered", "exhausted", "service-error"]) {
  const mutation = mutationFixture();
  try {
    const fixture = cardFixture({
      readPendingCount: () => mutation.queryClient.getQueryData(mutation.pendingKey),
      queryClient: mutation.queryClient,
      useDeepScan: mutation.useDeepScan,
    });
    const operation = fixture.confirm();
    await new Promise(setImmediate);
    assert.equal(mutation.calls.requests.length, 1);
    assert.deepEqual(mutation.calls.requests[0].photos, [{ id: "pending-only" }]);
    assert.equal(mutation.isPending, true);
    fixture.render();
    assert.ok(fixture.tree, "The card must remain visible while failed photos retry in the same scan");
    assert.equal(fixture.button, undefined, "Retries must not expose a second manual scan button");
    assert.ok(findElement(fixture.tree, (element) => element.props?.accessibilityLabel === "Deep scan progress"));
    assert.equal(fixture.calls.toasts.length, 0, "An intermediate retry must not announce completion");
    mutation.queryClient.setQueryData(mutation.pendingKey, 0);
    fixture.render();
    assert.ok(fixture.tree, "A refreshed zero count must not hide an active scan");
    assert.equal(fixture.button, undefined);
    mutation.queryClient.setQueryData(mutation.pendingKey, 1);

    if (outcome === "service-error") {
      mutation.scan.reject(new Error("Failure persistence unavailable"));
    } else {
      mutation.scan.resolve(progress(outcome === "exhausted" ? { foodPhotosFound: 0, retryableFailures: 1 } : {}));
    }
    await new Promise(setImmediate);
    assert.equal(mutation.calls.refreshes, 1, "Settlement must refresh the active pending count");
    assert.equal(
      mutation.queryClient.getQueryData(mutation.pendingKey),
      1,
      "The pending count remains stale until refetch resolves",
    );
    assert.equal(mutation.isPending, true, "The production onSettled callback must await cache reconciliation");
    fixture.render();
    assert.equal(fixture.button, undefined, "A stale pending count must not restore the button during reconciliation");
    assert.equal(fixture.calls.resets, 0, "The scan lock must remain held until the refreshed count is available");
    assert.equal(fixture.calls.toasts.length, 0);

    mutation.refetch.resolve(0);
    await operation;
    fixture.render();
    assert.equal(mutation.isPending, false);
    assert.equal(fixture.tree, null, "The completed card must disappear once no eligible pending photos remain");
    assert.equal(fixture.calls.resets, 1);
    assert.equal(fixture.calls.toasts.length, 1);
    assert.equal(fixture.calls.toasts[0].type, outcome === "recovered" ? "success" : "error");
  } finally {
    mutation.dispose();
  }
}

{
  const mutation = mutationFixture();
  try {
    const fixture = cardFixture({
      pendingIds: [],
      readPendingCount: () => mutation.queryClient.getQueryData(mutation.pendingKey),
      queryClient: mutation.queryClient,
      useDeepScan: mutation.useDeepScan,
    });
    const operation = fixture.confirm();
    await new Promise(setImmediate);
    assert.equal(mutation.calls.refreshes, 1);
    assert.equal(mutation.calls.requests.length, 0, "Empty preflight must not invoke native classification");
    assert.equal(fixture.calls.resets, 0, "Empty preflight must refresh stale pending data before releasing its lock");
    fixture.render();
    assert.ok(fixture.tree);
    assert.equal(fixture.button, undefined, "Empty preflight must remain busy until its count refresh completes");
    mutation.refetch.resolve(0);
    await operation;
    fixture.render();
    assert.equal(fixture.tree, null);
    assert.equal(fixture.calls.resets, 1);
    assert.equal(fixture.calls.toasts[0].message, "No photos left to deep scan");
  } finally {
    mutation.dispose();
  }
}

{
  const mutation = mutationFixture({ invalidateQueriesOnSettled: false, synchronizeVisitFood: false });
  try {
    const hook = mutation.useDeepScan();
    const operation = hook.mutateAsync([{ id: "automatic-batch" }]);
    mutation.scan.resolve(progress());
    await operation;
    assert.equal(mutation.calls.requests[0].synchronizeVisitFood, false);
    assert.equal(mutation.calls.refreshes, 0, "Automatic batches must preserve caller-owned final reconciliation");
    assert.deepEqual(mutation.calls.invalidations, []);
    assert.equal(mutation.isPending, false);
  } finally {
    mutation.dispose();
  }
}

function hookFixture(options = {}) {
  const calls = {
    requests: [],
    complete: [],
    fail: [],
    progress: [],
    visualComplete: [],
    visualError: [],
    starts: 0,
    quick: 0,
  };
  const state = {
    isScanning: false,
    isBackgroundPhotoScanRunning: false,
    scanProgress: { phase: "idle" },
    startScan: () => {
      if (state.isScanning) {
        return false;
      }
      state.isScanning = true;
      calls.starts++;
      return true;
    },
    updateScanProgress: () => undefined,
    completeScan: (message) => {
      state.isScanning = false;
      calls.complete.push(message);
    },
    failScan: (message) => {
      state.isScanning = false;
      calls.fail.push(message);
    },
  };
  const queries = {
    usePermissions: () => ({ data: true }),
    usePhotoCount: () => ({ data: 3 }),
    useRequestPermission: () => ({ isPending: false, mutate: () => undefined }),
    useScanPhotos: () => ({
      isPending: false,
      mutateAsync: async () => {
        calls.quick++;
        return { photosProcessed: 3, visitsCreated: 1 };
      },
    }),
    useDeepScan: (onProgress) => ({
      isPending: false,
      mutateAsync: async (request) => {
        calls.requests.push(request);
        const result = options.result ?? progress();
        onProgress(result);
        return result;
      },
    }),
  };
  const modules = new Map([
    ["react", react],
    ["./queries", queries],
    [
      "./use-progress",
      {
        useScanProgress: () => ({
          sharedValues: {},
          onProgress: (value) => calls.progress.push(value),
          start: () => undefined,
          complete: (message) => calls.visualComplete.push(message),
          error: (message) => calls.visualError.push(message),
        }),
      },
    ],
    ["@/store/app-store", { useAppStore: () => state, useHasCompletedInitialScan: () => true }],
    ["@/services/scanner", { formatEta: () => "1s", getPhotoCount: async () => 3 }],
    ["@/services/analytics", { logScanStarted: () => undefined, logScanCompleted: () => undefined }],
    ["@/utils/db", { getUnanalyzedPhotoCount: async () => 1 }],
    ["@/utils/deep-scan-summary", summaryModule],
    ["@/modules/batch-asset-info", strategyModule(options.validation, options.nativeAvailable)],
  ]);
  const { useScan: renderUseScan } = load(compiledHook, modules);
  return { hook: renderUseScan({ autoDeepScanRemainingPhotoThreshold: 10_000 }), calls, state };
}

{
  const { hook, calls } = hookFixture();
  await hook.deepScan();
  assert.deepEqual(calls.requests, [undefined], "Explicit deep scans must retain pending scope");
  assert.deepEqual(calls.complete, ["Done. Found 1 food photo in 1 analyzed photo"]);
  assert.deepEqual(calls.visualComplete, calls.complete);
  assert.match(calls.visualComplete[0].toLowerCase(), /done/, "AnimatedProgressCard must recognize completion");
  assert.equal(calls.quick, 0);
}

{
  const { hook, calls, state } = hookFixture({ result: progress({ foodPhotosFound: 0, retryableFailures: 1 }) });
  await hook.deepScan();
  assert.deepEqual(calls.fail, ["Could not analyze 1 photo."]);
  assert.deepEqual(calls.visualError, calls.fail);
  assert.deepEqual(calls.visualComplete, []);
  assert.deepEqual(calls.complete, [], "A wholly failed scan must not complete as Done");
  assert.doesNotMatch(calls.progress[0].detail, /queued|will retry/);
  assert.equal(state.isScanning, false);
  await hook.deepScan();
  assert.equal(calls.requests.length, 2, "A failed scan must release its local active ref");
}

{
  const { hook, calls } = hookFixture({
    result: progress({ totalPhotos: 3, processedPhotos: 3, retryableFailures: 1 }),
  });
  await hook.deepScan();
  assert.deepEqual(calls.complete, ["Done. Found 1 food photo in 2 analyzed photos; 1 photo could not be analyzed"]);
  assert.deepEqual(calls.visualComplete, calls.complete);
}

{
  const { hook, calls } = hookFixture({ result: progress({ foodPhotosFound: 0, retryableFailures: 1 }) });
  await hook.scan();
  assert.equal(calls.quick, 1);
  assert.deepEqual(calls.requests, [undefined]);
  assert.deepEqual(calls.complete, ["Done. Could not analyze 1 photo."]);
  assert.deepEqual(calls.fail, [], "An optional failed deep scan must preserve a successful initial scan");
  assert.deepEqual(calls.visualComplete, calls.complete);
}

{
  const { hook, calls } = hookFixture({ nativeAvailable: false });
  await hook.scan();
  assert.equal(calls.quick, 1);
  assert.deepEqual(calls.requests, [], "Automatic follow-ups require native food detection");
  assert.deepEqual(calls.complete, ["Done!"]);
  assert.deepEqual(calls.fail, []);
}

for (const validation of [false, true]) {
  const { hook, calls } = hookFixture({ validation });
  await hook.scan();
  assert.equal(calls.quick, 1);
  assert.deepEqual(calls.requests, validation ? [] : [undefined], "Automatic follow-ups must retain pending scope");
}

// Render the production Rescan screen with both eligible and exhausted pending work.
for (const pending of [0, 1]) {
  const animation = { delay: () => ({ duration: () => undefined }) };
  const modules = new Map([
    ["react", { useLayoutEffect: () => undefined }],
    ["react/jsx-runtime", { jsx, jsxs: jsx }],
    ["react-native", { ScrollView: "ScrollView" }],
    ["expo-router", { router: {} }],
    ["react-native-reanimated", { default: { View: "AnimatedView" }, FadeIn: animation, FadeInDown: animation }],
    [
      "@/hooks",
      {
        useScan: () => ({ hasPermission: true, isComplete: false }),
        useUnanalyzedPhotoCount: () => ({ data: pending }),
      },
    ],
    ["@/components/scan", { ScanCard: "ScanCard", ScanHeader: "ScanHeader", PermissionCard: "PermissionCard" }],
    ["@/components/ui", { Button: "Button", ButtonText: "ButtonText" }],
    ["@/store", { useAppStore: {}, useResetScan: () => () => undefined }],
  ]);
  const { default: RescanScreen } = load(compiledScreen, modules);
  const card = findElement(RescanScreen(), (element) => element.type === "ScanCard");
  assert.equal(card.props.showDeepScan, pending > 0);
}

console.log("Deep scan UI regression tests passed.");
