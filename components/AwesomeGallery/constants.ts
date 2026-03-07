import { I18nManager } from "react-native";
import { ReduceMotion } from "react-native-reanimated";

export const RTL = I18nManager.isRTL;

export const DOUBLE_TAP_SCALE = 3;
export const MAX_SCALE = 24;
export const SPACE_BETWEEN_IMAGES = 40;

export const TIMING_CONFIG = {
  duration: 250,
  reduceMotion: ReduceMotion.Never,
};
