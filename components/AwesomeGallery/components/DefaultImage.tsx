import { StyleSheet } from "react-native";
import { Image } from "expo-image";
import { withUniwind } from "uniwind";
import type { RenderItemInfo } from "../types";

const AppImage = withUniwind(Image);

export const DefaultImage = ({ item, setImageDimensions }: RenderItemInfo<string>) => {
  return (
    <AppImage
      onLoad={(e) => {
        const { height: h, width: w } = e.source;
        setImageDimensions({ height: h, width: w });
      }}
      source={item}
      contentFit={"contain"}
      style={StyleSheet.absoluteFillObject}
      cachePolicy={"memory-disk"}
      allowDownscaling={false}
      placeholderContentFit={"cover"}
    />
  );
};
