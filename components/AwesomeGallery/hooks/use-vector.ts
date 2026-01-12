import { useSharedValue } from "react-native-reanimated";
import type { Vector } from "../types";

export const useVector = (x1 = 0, y1?: number): Vector => {
  const x = useSharedValue(x1);
  const y = useSharedValue(y1 ?? x1);
  return { x, y };
};
