import { cn } from "@/utils/cn";
import { Image } from "expo-image";
import React, { useCallback, useMemo, useState, useEffect } from "react";
import { Pressable, View, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Easing,
  FadeIn,
} from "react-native-reanimated";

interface PhotoGridProps {
  photos: Array<{ id: string; uri: string }>;
  /**
   * Fixed number of columns. If omitted, the grid can auto-compute columns when
   * `minPhotoSize` (or min/max columns) is provided.
   */
  columns?: number;
  gap?: number;
  /**
   * Used only as a fallback before the grid measures its actual width (or if layout
   * measurement fails). This represents total horizontal padding *outside* the grid.
   */
  containerPadding?: number;
  /**
   * If provided (and `columns` is not), the grid will pick a column count based on
   * available width so each photo is at least this size.
   */
  minPhotoSize?: number;
  minColumns?: number;
  maxColumns?: number;
  onPhotoPress?: (photo: { id: string; uri: string }, index: number) => void;
  maxPhotos?: number;
  loading?: boolean;
}

// Shimmer loading placeholder for photos
function PhotoSkeleton({ size, index }: { size: number; index: number }) {
  const shimmerProgress = useSharedValue(0);

  useEffect(() => {
    shimmerProgress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1, false);
  }, [shimmerProgress]);

  const animatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(shimmerProgress.value, [0, 0.5, 1], [0.3, 0.5, 0.3]);
    return { opacity };
  });

  return (
    <Animated.View
      entering={FadeIn.delay(index * 50).duration(200)}
      style={[{ width: size, height: size, borderRadius: 8 }, animatedStyle]}
      className={"bg-muted"}
    />
  );
}

function PhotoItem({
  photo,
  size,
  index,
  onPress,
}: {
  photo: { id: string; uri: string };
  size: number;
  index: number;
  onPress?: () => void;
}) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <Animated.View entering={FadeIn.delay(Math.min(index * 30, 300)).duration(300)}>
      <Pressable onPress={onPress}>
        <View
          className={"rounded-lg overflow-hidden bg-muted"}
          style={{ width: size, height: size, borderCurve: "continuous" }}
        >
          {isLoading && <View className={"absolute inset-0 bg-muted"} style={{ width: size, height: size }} />}
          <Image
            source={{ uri: photo.uri }}
            style={{ width: size, height: size }}
            contentFit={"cover"}
            transition={200}
            recyclingKey={photo.id}
            onLoad={() => setIsLoading(false)}
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}

export function PhotoGrid({
  photos,
  columns,
  gap = 8,
  containerPadding = 32,
  minPhotoSize,
  minColumns,
  maxColumns,
  onPhotoPress,
  maxPhotos,
  loading = false,
}: PhotoGridProps) {
  const window = useWindowDimensions();
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);

  const handleLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const nextWidth = Math.round(e.nativeEvent.layout.width);
      if (nextWidth > 0) {
        setMeasuredWidth((prev) => (prev === nextWidth ? prev : nextWidth));
      }
    },
    [setMeasuredWidth],
  );

  const availableWidth = useMemo(() => {
    if (measuredWidth && measuredWidth > 0) {
      return measuredWidth;
    }
    // Fallback: approximate using window width minus expected outer padding.
    return Math.max(1, Math.round(window.width - containerPadding));
  }, [measuredWidth, window.width, containerPadding]);

  const columnCount = useMemo(() => {
    if (columns !== undefined && Number.isFinite(columns) && columns > 0) {
      return Math.floor(columns);
    }

    const shouldAuto = minPhotoSize !== undefined || minColumns !== undefined || maxColumns !== undefined;

    // Preserve previous behavior unless auto-sizing is explicitly enabled.
    if (!shouldAuto) {
      return 3;
    }

    const minC = minColumns ?? 2;
    const maxC = maxColumns ?? 6;
    const minSize = minPhotoSize ?? 96;

    // Roughly: columns*(minSize) + (columns-1)*gap <= availableWidth
    // => columns <= (availableWidth + gap) / (minSize + gap)
    const raw = Math.floor((availableWidth + gap) / (minSize + gap));
    const clamped = Math.max(minC, Math.min(maxC, raw));
    return Math.max(1, clamped);
  }, [columns, minPhotoSize, minColumns, maxColumns, availableWidth, gap]);

  const photoSize = useMemo(() => {
    const totalGaps = (columnCount - 1) * gap;
    const raw = (availableWidth - totalGaps) / columnCount;
    // Flooring avoids accidental wrapping due to subpixel rounding.
    return Math.max(1, Math.floor(raw));
  }, [availableWidth, columnCount, gap]);

  const displayPhotos = useMemo(() => {
    if (maxPhotos && photos.length > maxPhotos) {
      return photos.slice(0, maxPhotos);
    }
    return photos;
  }, [photos, maxPhotos]);

  const renderPhoto = useCallback(
    (photo: { id: string; uri: string }, index: number) => (
      <PhotoItem
        key={photo.id}
        photo={photo}
        size={photoSize}
        index={index}
        onPress={onPhotoPress ? () => onPhotoPress(photo, index) : undefined}
      />
    ),
    [photoSize, onPhotoPress],
  );

  // Show loading skeletons
  if (loading) {
    const skeletonCount = maxPhotos ?? 9;
    return (
      <View onLayout={handleLayout} className={cn("flex-row flex-wrap")} style={{ gap }}>
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <PhotoSkeleton key={index} size={photoSize} index={index} />
        ))}
      </View>
    );
  }

  return (
    <View onLayout={handleLayout} className={cn("flex-row flex-wrap")} style={{ gap }}>
      {displayPhotos.map(renderPhoto)}
    </View>
  );
}
