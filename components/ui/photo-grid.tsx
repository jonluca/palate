import { cn } from "@/utils/cn";
import { Image } from "expo-image";
import React, { useCallback, useMemo, useState, useEffect } from "react";
import { Dimensions, Pressable, View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Easing,
  FadeIn,
} from "react-native-reanimated";

const { width: screenWidth } = Dimensions.get("window");

interface PhotoGridProps {
  photos: Array<{ id: string; uri: string }>;
  columns?: number;
  gap?: number;
  containerPadding?: number;
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
  columns = 3,
  gap = 8,
  containerPadding = 32,
  onPhotoPress,
  maxPhotos,
  loading = false,
}: PhotoGridProps) {
  const photoSize = useMemo(() => {
    const totalGaps = (columns - 1) * gap;
    return (screenWidth - containerPadding - totalGaps) / columns;
  }, [columns, gap, containerPadding]);

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
      <View className={cn("flex-row flex-wrap")} style={{ gap }}>
        {Array.from({ length: skeletonCount }).map((_, index) => (
          <PhotoSkeleton key={index} size={photoSize} index={index} />
        ))}
      </View>
    );
  }

  return (
    <View className={cn("flex-row flex-wrap")} style={{ gap }}>
      {displayPhotos.map(renderPhoto)}
    </View>
  );
}
