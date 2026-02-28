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
  "house.fill": "home",
  "paperplane.fill": "send",
  "chevron.left.forwardslash.chevron.right": "code",
  "chevron.right": "chevron-right",
  map: "map",
  "moon.fill": "dark-mode",
  "sun.max.fill": "light-mode",
  "camera.filters": "palette",
  "circle.righthalf.filled": "brightness-6",
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
  const symbolName = typeof name === "string" ? name : name.android ?? name.web ?? name.ios;
  const materialName = symbolName ? MAPPING[symbolName] ?? FALLBACK_ICON_NAME : FALLBACK_ICON_NAME;

  return <MaterialIcons color={color} size={size} name={materialName} style={style} />;
}
