#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const compiledCard = ts.transpileModule(
  readFileSync(new URL("../components/scan/background-photo-update-bar.tsx", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;

let reduceMotion = false;
const state = {
  isBackgroundPhotoScanRunning: true,
  backgroundPhotoScanProgress: { stage: "checking", detail: "Checking for photo updates…", progress: null },
};
const modules = new Map([
  ["react", React],
  ["react/jsx-runtime", jsxRuntime],
  ["react-native", { View: "View", ActivityIndicator: "ActivityIndicator" }],
  [
    "react-native-reanimated",
    {
      default: { View: "Animated.View" },
      FadeIn: { duration: () => undefined },
      FadeOut: { duration: () => undefined },
      useReducedMotion: () => reduceMotion,
    },
  ],
  ["@/components/icon-symbol", { IconSymbol: "IconSymbol" }],
  ["@/components/themed-text", { ThemedText: "ThemedText" }],
  ["@/store", { useAppStore: (selector) => selector(state) }],
  ["@/utils/cn", { cn: (...classes) => classes.filter(Boolean).join(" ") }],
]);
const exports = {};
runInNewContext(compiledCard, {
  exports,
  require: (name) => {
    assert.ok(modules.has(name), `Missing module fixture: ${name}`);
    return modules.get(name);
  },
});

function elements(node) {
  if (!React.isValidElement(node)) {
    return [];
  }
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
}

function render(progress, stage = "deep-scanning") {
  state.backgroundPhotoScanProgress = { stage, detail: "Photo refresh progress", progress };
  const card = exports.BackgroundPhotoUpdateBar({});
  const children = elements(card);
  const track = children.find((element) => element.props.className?.includes("h-1.5"));
  assert.ok(track, "The progress track must keep the card's height stable through phase changes");
  for (const element of children) {
    const style = Object.assign({}, ...[element.props.style].flat().filter(Boolean));
    assert.equal(style.animationName, undefined, "Progress must not repeatedly fill and empty while work is unknown");
  }
  return { card, children, track };
}

for (reduceMotion of [false, true]) {
  for (const stage of ["checking", "reconciling"]) {
    const { card, children, track } = render(null, stage);
    assert.equal(card.props.accessibilityValue.now, undefined, "Unknown work must not announce a fake percentage");
    assert.equal(track.props.children, null, "Unknown work must leave the track empty instead of filling and emptying");
    assert.equal(
      children.some((element) => element.type === "ActivityIndicator"),
      !reduceMotion,
    );
    assert.equal(
      children.some((element) => element.type === "IconSymbol"),
      reduceMotion,
    );
  }

  for (const progress of [0, 0.03, 0.5, 0.96, 1]) {
    const { card, track } = render(progress);
    const fill = track.props.children;
    const style = Object.assign({}, ...fill.props.style.filter(Boolean));
    assert.equal(style.transform[0].scaleX, progress, "The fill must represent the reported overall progress");
    assert.ok(Number.isFinite(style.transform[0].scaleX));
    assert.equal(card.props.accessibilityValue.now, Math.round(progress * 100));
    assert.equal(style.transitionProperty, reduceMotion ? undefined : "transform");
    assert.equal(style.transitionDuration, reduceMotion ? undefined : 220);
  }
}

state.isBackgroundPhotoScanRunning = false;
assert.equal(exports.BackgroundPhotoUpdateBar({}), null, "Finished updates must hide the card");
state.isBackgroundPhotoScanRunning = true;
state.backgroundPhotoScanProgress = null;
assert.equal(exports.BackgroundPhotoUpdateBar({}), null, "Missing progress must not render a card");

console.log("Background photo progress UI tests passed");
