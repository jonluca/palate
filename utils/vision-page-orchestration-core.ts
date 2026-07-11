import type { OrderedPagePipelineStrategy } from "./ordered-page-pipeline-core.ts";

/** Native-selected JavaScript orchestration strategy for Vision result pages. */
export type VisionPageOrchestrationStrategy = OrderedPagePipelineStrategy;

/**
 * Resolves the strategy advertised by the installed native binary. Older
 * binaries and malformed constants stay serial until real-device evidence
 * supports enabling lookahead by default.
 */
export function resolveVisionPageOrchestrationStrategy(value: unknown): VisionPageOrchestrationStrategy {
  return value === "lookahead" ? "lookahead" : "serial";
}
