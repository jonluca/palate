import React, { useCallback, useMemo, useState } from "react";
import { View, Pressable, useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import { Ionicons } from "@expo/vector-icons";
import { FlashList } from "@shopify/flash-list";
import { Image } from "expo-image";
import Animated, { FadeIn } from "react-native-reanimated";

interface PhotoData {
  id: string;
  uri: string;
}

interface PhotosSectionProps {
  photos: PhotoData[];
  onPhotoPress: (index: number) => void;
  onAddPhotos?: () => void;
  isAddingPhotos?: boolean;
  /** Maximum number of visible rows (can be fractional, e.g. 3.5). Default: 3.5 */
  maxRows?: number;
}

const NUM_COLUMNS = 3;
const GAP = 6;
const CONTAINER_PADDING = 8; // p-2 = 8px

function PhotoItem({
  photo,
  size,
  index,
  onPress,
}: {
  photo: PhotoData;
  size: number;
  index: number;
  onPress: () => void;
}) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <Animated.View entering={FadeIn.delay(Math.min(index * 30, 300)).duration(300)} style={{ marginBottom: GAP }}>
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

export function PhotosSection({
  photos,
  onPhotoPress,
  onAddPhotos,
  isAddingPhotos,
  maxRows = 3.5,
}: PhotosSectionProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    const nextWidth = Math.round(e.nativeEvent.layout.width);
    if (nextWidth > 0) {
      setContainerWidth((prev) => (prev === nextWidth ? prev : nextWidth));
    }
  }, []);

  // Calculate photo size based on container width
  const photoSize = useMemo(() => {
    const availableWidth = containerWidth ?? screenWidth - 32 - CONTAINER_PADDING * 2;
    const totalGaps = (NUM_COLUMNS - 1) * GAP;
    return Math.max(1, Math.floor((availableWidth - totalGaps) / NUM_COLUMNS));
  }, [containerWidth, screenWidth]);

  // Calculate the row height (photo + gap)
  const rowHeight = photoSize + GAP;

  // Calculate actual number of rows needed
  const actualRows = Math.ceil(photos.length / NUM_COLUMNS);

  // Calculate heights: max based on maxRows, actual based on content
  const maxHeight = Math.round(rowHeight * maxRows);
  const contentHeight = rowHeight * actualRows;

  // Use the smaller of the two - content shrinks if fewer photos, but caps at maxRows
  const containerHeight = Math.min(maxHeight, contentHeight);

  const renderPhoto = useCallback(
    ({ item, index }: { item: PhotoData; index: number }) => (
      <PhotoItem photo={item} size={photoSize} index={index} onPress={() => onPhotoPress(index)} />
    ),
    [photoSize, onPhotoPress],
  );

  const keyExtractor = useCallback((item: PhotoData) => item.id, []);

  return (
    <View className={"gap-3"}>
      <View className={"flex-row items-center justify-between px-1"}>
        <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
          Photos ({photos.length.toLocaleString()})
        </ThemedText>

        {onAddPhotos && (
          <Pressable
            onPress={onAddPhotos}
            disabled={isAddingPhotos}
            className={"flex-row items-center gap-1 px-2 py-1 rounded-full bg-primary/10 active:opacity-70"}
          >
            <Ionicons name={isAddingPhotos ? "hourglass-outline" : "add"} size={14} color={"#3b82f6"} />
            <ThemedText variant={"caption2"} className={"text-primary font-medium"}>
              {isAddingPhotos ? "Adding..." : "Add Photos"}
            </ThemedText>
          </Pressable>
        )}
      </View>

      <Card animated={false} className={"p-2"}>
        <View onLayout={handleLayout} style={{ height: containerHeight }}>
          <FlashList
            data={photos}
            renderItem={renderPhoto}
            keyExtractor={keyExtractor}
            numColumns={NUM_COLUMNS}
            showsVerticalScrollIndicator={actualRows > maxRows}
          />
        </View>
      </Card>
    </View>
  );
}
