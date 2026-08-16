import type { FoodLabel } from "./types.ts";
import { isJsonNumber, isJsonObject, isJsonString, parseJsonValue, type JsonValue } from "../runtime-json.ts";

function isFoodLabel(value: JsonValue): value is JsonValue & FoodLabel {
  return (
    isJsonObject(value) &&
    isJsonString(value.label) &&
    isJsonNumber(value.confidence) &&
    Number.isFinite(value.confidence)
  );
}

export function parseFoodLabelArrayJson(serialized: string): FoodLabel[] | null {
  try {
    const decoded = parseJsonValue(serialized);
    return Array.isArray(decoded) && decoded.every(isFoodLabel) ? decoded : null;
  } catch {
    return null;
  }
}

export function parseFoodLabelArraysJson(serialized: string): FoodLabel[][] | null {
  try {
    const decoded = parseJsonValue(serialized);
    if (!Array.isArray(decoded)) {
      return null;
    }
    const labelArrays: FoodLabel[][] = [];
    for (const labels of decoded) {
      if (!Array.isArray(labels) || !labels.every(isFoodLabel)) {
        return null;
      }
      labelArrays.push(labels);
    }
    return labelArrays;
  } catch {
    return null;
  }
}
