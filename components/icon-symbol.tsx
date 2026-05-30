// Fallback for using MaterialIcons on Android and web.

import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import type { SymbolType, SymbolViewProps, SymbolWeight } from "expo-symbols";
import type { ComponentProps } from "react";
import type { OpaqueColorValue, StyleProp, TextStyle } from "react-native";

type MaterialIconName = ComponentProps<typeof MaterialIcons>["name"];
export type IconSymbolName = SymbolViewProps["name"];

/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
const MAPPING: Record<string, MaterialIconName> = {
  "arrow.triangle.2.circlepath": "sync",
  "building.2.fill": "location-city",
  calendar: "calendar-today",
  "camera.fill": "photo-camera",
  "camera.macro": "local-florist",
  "chart.bar.fill": "bar-chart",
  "checkmark.seal.fill": "verified",
  "clock.fill": "schedule",
  "flame.fill": "local-fire-department",
  "globe.americas.fill": "public",
  "heart.fill": "favorite",
  "house.fill": "home",
  "leaf.fill": "eco",
  magnifyingglass: "search",
  "paperplane.fill": "send",
  "chevron.left.forwardslash.chevron.right": "code",
  "chevron.right": "chevron-right",
  map: "map",
  "map.fill": "map",
  mappin: "location-on",
  "moon.fill": "dark-mode",
  "moon.stars.fill": "nights-stay",
  "safari.fill": "explore",
  "scale.3d": "balance",
  scope: "my-location",
  snowflake: "ac-unit",
  sparkles: "auto-awesome",
  "sunrise.fill": "wb-sunny",
  "sun.max.fill": "light-mode",
  "trophy.fill": "emoji-events",
  "camera.filters": "palette",
  "circle.righthalf.filled": "brightness-6",
  "fork.knife": "restaurant",
  "fork.knife.circle.fill": "restaurant",
  "star.fill": "star",
  "xmark.circle.fill": "close",
  photo: "image",
};

const FALLBACK_ICON_NAME: MaterialIconName = "help-outline";

/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;

  /** iOS-only */
  type?: SymbolType;
  animationSpec?: SymbolViewProps["animationSpec"];
  backgroundColor?: string;
}) {
  const symbolName = typeof name === "string" ? name : (name.android ?? name.web ?? name.ios);
  const materialName = symbolName ? (MAPPING[symbolName] ?? FALLBACK_ICON_NAME) : FALLBACK_ICON_NAME;

  return <MaterialIcons color={color} size={size} name={materialName} style={style} />;
}
