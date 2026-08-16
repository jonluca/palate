import type { OrderedPagePipelineStrategy } from "./ordered-page-pipeline-core.ts";

/** Native-selected JavaScript orchestration strategy for Vision result pages. */
export type VisionPageOrchestrationStrategy = OrderedPagePipelineStrategy;

export type NativeVisionPageOrchestrationSetting =
  | string
  | number
  | boolean
  | Readonly<Record<string, never>>
  | null
  | undefined;

/**
 * Resolves the strategy advertised by the installed native binary. Older
 * binaries and malformed constants stay serial until real-device evidence
 * supports enabling lookahead by default.
 */
export function resolveVisionPageOrchestrationStrategy(
  value: NativeVisionPageOrchestrationSetting,
): VisionPageOrchestrationStrategy {
  return value === "lookahead" ? "lookahead" : "serial";
}
