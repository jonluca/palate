/* oxlint-disable anti-slop/no-runtime-typeof -- This local React double dispatches state value/updater arguments and reads the component tree produced by the TSX module under test. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual provider and banner. Deferred promises and queued native
// callbacks control ordering without duplicating their action-ownership logic.
let hooks;
const sameDeps = (a, b) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
const noop = () => {};
const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: { ...props, children },
  }),
  createContext: () => ({ Provider: "Context" }),
  useState(initial) {
    const owner = hooks;
    const index = owner.cursor++;
    if (!(index in owner.values)) {
      owner.values[index] = initial;
    }
    return [
      owner.values[index],
      (next) => {
        owner.values[index] = typeof next === "function" ? next(owner.values[index]) : next;
      },
    ];
  },
  useRef(initial) {
    return react.useState({ current: initial })[0];
  },
  useCallback(callback, deps) {
    const index = hooks.cursor++;
    const previous = hooks.values[index];
    if (!previous || !sameDeps(previous.deps, deps)) {
      hooks.values[index] = { callback, deps };
    }
    return hooks.values[index].callback;
  },
  useEffect(callback, deps) {
    const owner = hooks;
    const index = owner.cursor++;
    const previous = owner.values[index];
    if (previous && sameDeps(previous.deps, deps)) {
      return;
    }
    owner.effects.push(() => {
      previous?.cleanup?.();
      owner.values[index] = { deps, cleanup: callback() };
    });
  },
};
function renderer(component) {
  const owner = { values: [], effects: [], cursor: 0 };
  return (props = {}) => {
    owner.cursor = 0;
    owner.effects = [];
    hooks = owner;
    const tree = component(props);
    for (const effect of owner.effects) {
      effect();
    }
    return tree;
  };
}
function findBanner(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findBanner(child);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) {
    return null;
  }
  const element = node;
  return typeof element.type === "function" ? element : findBanner(element.props.children);
}
const timers = [];
const animationCompletions = [];
const gestureEndHandlers = [];
const toasts = [];
const showToast = (toast) => toasts.push(toast);
const makeGesture = () => {
  const gesture = {
    activeOffsetY: () => gesture,
    onUpdate: () => gesture,
    onEnd: (callback) => {
      gestureEndHandlers.push(callback);
      return gesture;
    },
  };
  return gesture;
};
const modules = {
  react,
  "react-native": { View: "View", Pressable: "Pressable", Platform: { select: () => 49 } },
  "expo-router": { useSegments: () => [] },
  "react-native-reanimated": {
    __esModule: true,
    default: { View: "AnimatedView" },
    useSharedValue: (value) => react.useRef({ value }).current,
    useAnimatedStyle: noop,
    withTiming: (value, _options, complete) => {
      if (complete) {
        animationCompletions.push(complete);
      }
      return value;
    },
    withSpring: noop,
    SlideInDown: { duration: noop },
    SlideOutDown: { duration: noop },
  },
  "react-native-worklets": { scheduleOnRN: (callback) => callback() },
  "react-native-gesture-handler": { Gesture: { Pan: makeGesture }, GestureDetector: "GestureDetector" },
  "react-native-safe-area-context": { useSafeAreaInsets: () => ({ bottom: 0 }) },
  "@/components/themed-text": { ThemedText: "ThemedText" },
  "@/components/icon-symbol": { IconSymbol: "IconSymbol" },
  "expo-haptics": { notificationAsync: noop, NotificationFeedbackType: { Success: "Success" } },
  "@/store": { useHideUndoBar: () => false },
  "./toast": { useToast: () => ({ showToast }) },
};
const source = readFileSync(new URL("../components/ui/undo-banner.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
});
const output = { exports: {} };
vm.runInNewContext(`(function(require, module, exports) { ${compiled.outputText} })`, {
  console: { error: noop },
  setTimeout: (callback) => timers.push(callback),
  clearTimeout: noop,
})(
  (name) => {
    assert.ok(name in modules, `Unexpected component dependency: ${name}`);
    return modules[name];
  },
  output,
  output.exports,
);
const renderProvider = renderer(output.exports.UndoProvider);
const context = () => renderProvider().props.value;
const banner = () => {
  const found = findBanner(renderProvider());
  assert.ok(found, "Expected a visible undo banner");
  return found;
};
const beginUndo = (element = banner()) => element.props.onUndo();
function deferredAction(visitId) {
  const result = Promise.withResolvers();
  let calls = 0;
  return {
    ...result,
    calls: () => calls,
    action: {
      type: "confirm",
      visitId,
      message: visitId,
      onUndo: () => {
        calls++;
        return result.promise;
      },
    },
  };
}
const completed = [];
context().setOnUndoComplete((visitId) => completed.push(visitId));
const first = deferredAction("first");
context().showUndo(first.action);
const firstBanner = banner();
const firstUndo = beginUndo(firstBanner);
const duplicateUndo = beginUndo(firstBanner);
assert.equal(first.calls(), 1, "Repeated presses before a rerender must execute an undo once");
const second = deferredAction("second");
context().showUndo(second.action);
const secondUndo = beginUndo();
assert.equal(second.calls(), 1, "An earlier pending undo must not block the current action");
first.resolve();
await Promise.all([firstUndo, duplicateUndo]);
assert.equal(context().currentAction?.visitId, "second", "Earlier success must preserve the newer banner");
await beginUndo(firstBanner);
assert.equal(first.calls(), 1, "A queued press from a completed action must not execute it again");
second.resolve();
await secondUndo;
assert.equal(context().currentAction, null, "Current action clears its own banner after completion");
assert.deepEqual(completed, ["first", "second"]);
const failing = deferredAction("failing");
context().showUndo(failing.action);
const failedUndo = beginUndo();
const newer = deferredAction("newer");
context().showUndo(newer.action);
failing.reject(new Error("Database unavailable"));
await failedUndo;
assert.equal(context().currentAction?.visitId, "newer", "Earlier failure must preserve the newer banner");
assert.equal(toasts.length, 1, "Undo failure should be reported without an unhandled rejection");
assert.deepEqual(completed, ["first", "second"], "Failed undo must not report completion");
const staleBanner = banner();
assert.equal(typeof staleBanner.type, "function");
renderer(staleBanner.type)(staleBanner.props);
const staleTimer = timers.at(-1);
gestureEndHandlers.at(-1)({ velocityY: 1000 });
const staleAnimation = animationCompletions.at(-1);
const latest = deferredAction("latest");
context().showUndo(latest.action);
staleTimer();
assert.equal(context().currentAction?.visitId, "latest", "A queued old timeout must not dismiss the current banner");
staleAnimation();
assert.equal(
  context().currentAction?.visitId,
  "latest",
  "A queued old swipe completion must not dismiss the current banner",
);
context().clearUndo();
assert.equal(context().currentAction, null, "Explicit clear still dismisses the current action");
console.log(
  "Undo banner regression checks passed: overlapping success/failure, duplicate presses, and stale timeout/swipe callbacks.",
);
