/* oxlint-disable anti-slop/no-runtime-typeof -- The local React double dispatches state updater functions and reads rendered elements. */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

let hooks;
const noop = () => {};
const sameDeps = (a, b) => a?.length === b?.length && a.every((value, i) => Object.is(value, b[i]));
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
  forwardRef: (component) => component,
  useState(initial) {
    const owner = hooks;
    const index = owner.cursor++;
    if (!(index in owner.values)) {
      owner.values[index] = typeof initial === "function" ? initial() : initial;
    }
    return [
      owner.values[index],
      (value) => {
        owner.values[index] = typeof value === "function" ? value(owner.values[index]) : value;
      },
    ];
  },
  useRef(initial) {
    return react.useState({ current: initial })[0];
  },
  useCallback(callback) {
    return callback;
  },
  useImperativeHandle(ref, callback) {
    ref.current = callback();
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
  return (props, ref) => {
    owner.cursor = 0;
    owner.effects = [];
    hooks = owner;
    const tree = component(props, ref);
    for (const effect of owner.effects) {
      effect();
    }
    return tree;
  };
}
function elements(node) {
  if (Array.isArray(node)) {
    return node.flatMap(elements);
  }
  if (!node || typeof node !== "object" || !node.props) {
    return [];
  }
  return [node, ...elements(node.props.children)];
}
function find(tree, type) {
  return elements(tree).find((node) => node.type === type);
}
function button(tree, label) {
  const found = elements(tree).find(
    (node) => node.type === "Pressable" && elements(node).some((child) => child.props.children.includes(label)),
  );
  assert.ok(found, `Missing ${label} button`);
  return found;
}
const haptics = [];
const native = {
  View: "View",
  Pressable: "Pressable",
  TextInput: "TextInput",
  Keyboard: { dismiss: noop },
  StyleSheet: { create: (styles) => styles },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
};
const reanimated = {
  __esModule: true,
  default: { View: "AnimatedView" },
  FadeIn: { duration: noop },
  useSharedValue: (value) => react.useRef({ value }).current,
  useAnimatedStyle: (callback) => callback(),
  useAnimatedReaction: (read, effect) => react.useEffect(() => effect(read()), [read()]),
  withTiming: (value) => value,
};
function load(relativePath, overrides = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const modules = {
    react,
    "react-native": native,
    "react-native-reanimated": reanimated,
    "@/components/themed-text": { ThemedText: "ThemedText" },
    "@/components/icon-symbol": { IconSymbol: "IconSymbol" },
    "@/components/ui": { Card: "Card" },
    "expo-haptics": {
      impactAsync: noop,
      notificationAsync: (type) => haptics.push(type),
      ImpactFeedbackStyle: { Light: "Light" },
      NotificationFeedbackType: { Success: "Success" },
    },
    ...overrides,
  };
  const output = { exports: {} };
  vm.runInNewContext(`(function(require, module, exports) { ${compiled.outputText} })`)(
    (name) => {
      assert.ok(name in modules, `Unexpected dependency ${name}`);
      return modules[name];
    },
    output,
    output.exports,
  );
  return output.exports;
}

const { NotesCard } = load("../components/visit/notes-card.tsx");
const renderNotes = renderer(NotesCard);
let save = Promise.withResolvers();
const savedNotes = [];
const props = {
  notes: "Existing notes",
  onSave: (notes) => {
    savedNotes.push(notes);
    return save.promise;
  },
};
button(renderNotes(props), "Edit").props.onPress();
find(renderNotes(props), "TextInput").props.onChangeText("  Unsaved draft  ");
const initialSave = button(renderNotes(props), "Save");
const attempt = initialSave.props.onPress();
const duplicate = initialSave.props.onPress();
assert.ok(find(renderNotes(props), "TextInput"), "Keep the editor open while a save is pending");
assert.equal(savedNotes.length, 1, "A queued duplicate press must not submit the notes twice");
assert.equal(haptics.length, 0, "Do not report success before persistence completes");
save.reject(new Error("Database unavailable"));
await Promise.all([attempt, duplicate]);
assert.equal(find(renderNotes(props), "TextInput").props.value, "  Unsaved draft  ", "A failed save retains the draft");
assert.equal(haptics.length, 0, "A failed save must not play success feedback");
save = Promise.withResolvers();
const retry = button(renderNotes(props), "Save").props.onPress();
save.resolve();
await retry;
assert.equal(
  find(renderNotes({ ...props, notes: "Unsaved draft" }), "TextInput"),
  undefined,
  "Successful save closes editing",
);
assert.deepEqual(savedNotes, ["Unsaved draft", "Unsaved draft"]);
assert.deepEqual(haptics, ["Success"]);

const { Gallery } = load("../components/AwesomeGallery/index.tsx", {
  "react-native-gesture-handler": { GestureHandlerRootView: "GestureHandlerRootView" },
  "react-native-worklets": { scheduleOnRN: (callback, ...args) => callback(...args) },
  "./constants": { RTL: false, SPACE_BETWEEN_IMAGES: 20, DOUBLE_TAP_SCALE: 2, MAX_SCALE: 6, TIMING_CONFIG: {} },
  "./components": { DefaultImage: "DefaultImage", ResizableImage: "ResizableImage" },
});
for (const [initialIndex, expected] of [
  [NaN, 0],
  [-2, 0],
  [Infinity, 0],
  [1.5, 1],
  [999, 2],
]) {
  const render = renderer(Gallery);
  const ref = { current: null };
  const tree = render({ data: ["a", "b", "c"], initialIndex }, ref);
  const image = find(tree, "ResizableImage");
  assert.ok(image, `Invalid initial index ${initialIndex} must still render images`);
  assert.equal(image.props.currentIndex.value, expected, "Normalize the initial native index");
  assert.equal(Math.abs(image.props.translateX.value), expected * 420, "Keep native translation finite and in range");
  assert.doesNotThrow(() => ref.current.setIndex(-1), "Imperative navigation before item refs mount must be safe");
  assert.equal(image.props.currentIndex.value, 0);
}
const renderGallery = renderer(Gallery);
const galleryRef = { current: null };
renderGallery({ data: [], initialIndex: 1 }, galleryRef);
const populated = renderGallery({ data: ["a", "b"] }, galleryRef);
assert.equal(
  find(populated, "ResizableImage").props.currentIndex.value,
  0,
  "An empty gallery recovers when data arrives",
);
galleryRef.current.setIndex(1);
renderGallery({ data: ["a", "b"] }, galleryRef);
renderGallery({ data: [] }, galleryRef);
const restored = renderGallery({ data: ["a", "b"] }, galleryRef);
assert.equal(
  find(restored, "ResizableImage").props.currentIndex.value,
  0,
  "A gallery remains usable after its photos are removed and replaced",
);
console.log("Visit UI regressions passed: failed/duplicate note saves and invalid/empty gallery navigation.");
