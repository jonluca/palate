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
  onRemovePhotos?: (photoIds: string[]) => void;
  isRemovingPhotos?: boolean;
  isSharingPhotos?: boolean;
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
  onLongPress,
  isSelectionMode,
  isSelected,
}: {
  photo: PhotoData;
  size: number;
  index: number;
  onPress: () => void;
  onLongPress?: () => void;
  isSelectionMode?: boolean;
  isSelected?: boolean;
}) {
  const [isLoading, setIsLoading] = useState(true);

  return (
    <Animated.View entering={FadeIn.delay(Math.min(index * 30, 300)).duration(300)} style={{ marginBottom: GAP }}>
      <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={300}>
        <View
          className={"rounded-lg overflow-hidden bg-muted"}
          style={{ width: size, height: size, borderCurve: "continuous" }}
        >
          {isLoading && <View className={"absolute inset-0 bg-muted"} style={{ width: size, height: size }} />}
          <Image
            source={{ uri: photo.uri }}
            style={{ width: size, height: size, opacity: isSelectionMode && !isSelected ? 0.5 : 1 }}
            contentFit={"cover"}
            transition={200}
            recyclingKey={photo.id}
            onLoad={() => setIsLoading(false)}
          />
          {isSelectionMode && (
            <View
              className={`absolute top-1 right-1 w-5 h-5 rounded-full items-center justify-center ${
                isSelected ? "bg-red-500" : "bg-black/40 border border-white/60"
              }`}
            >
              {isSelected && <Ionicons name={"checkmark"} size={14} color={"white"} />}
            </View>
          )}
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
  onRemovePhotos,
  isRemovingPhotos,
  isSharingPhotos,
  maxRows = 3.5,
}: PhotosSectionProps) {
  const { width: screenWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedPhotoIds, setSelectedPhotoIds] = useState<Set<string>>(new Set());

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

  const handlePhotoPress = useCallback(
    (index: number, photoId: string) => {
      if (isSelectionMode) {
        setSelectedPhotoIds((prev) => {
          const next = new Set(prev);
          if (next.has(photoId)) {
            next.delete(photoId);
          } else {
            next.add(photoId);
          }
          return next;
        });
      } else {
        onPhotoPress(index);
      }
    },
    [isSelectionMode, onPhotoPress],
  );

  const handleLongPress = useCallback(
    (photoId: string) => {
      if (!onRemovePhotos) {
        return;
      }
      if (!isSelectionMode) {
        setIsSelectionMode(true);
        setSelectedPhotoIds(new Set([photoId]));
      }
    },
    [isSelectionMode, onRemovePhotos],
  );

  const handleCancelSelection = useCallback(() => {
    setIsSelectionMode(false);
    setSelectedPhotoIds(new Set());
  }, []);

  const handleRemoveSelected = useCallback(() => {
    if (onRemovePhotos && selectedPhotoIds.size > 0) {
      onRemovePhotos(Array.from(selectedPhotoIds));
      setIsSelectionMode(false);
      setSelectedPhotoIds(new Set());
    }
  }, [onRemovePhotos, selectedPhotoIds]);

  const renderPhoto = useCallback(
    ({ item, index }: { item: PhotoData; index: number }) => (
      <PhotoItem
        photo={item}
        size={photoSize}
        index={index}
        onPress={() => handlePhotoPress(index, item.id)}
        onLongPress={onRemovePhotos ? () => handleLongPress(item.id) : undefined}
        isSelectionMode={isSelectionMode}
        isSelected={selectedPhotoIds.has(item.id)}
      />
    ),
    [photoSize, handlePhotoPress, handleLongPress, isSelectionMode, selectedPhotoIds, onRemovePhotos],
  );

  const keyExtractor = useCallback((item: PhotoData) => item.id, []);

  return (
    <View className={"gap-3"}>
      <View className={"flex-row items-center justify-between px-1"}>
        <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide"}>
          Photos ({photos.length.toLocaleString()})
        </ThemedText>

        <View className={"flex-row items-center gap-2"}>
          {isSelectionMode ? (
            <>
              <Pressable
                onPress={handleCancelSelection}
                className={"flex-row items-center gap-1 px-2 py-1 rounded-full bg-muted active:opacity-70"}
              >
                <Ionicons name={"close"} size={14} color={"#9ca3af"} />
                <ThemedText variant={"caption2"} color={"secondary"} className={"font-medium"}>
                  Cancel
                </ThemedText>
              </Pressable>
              <Pressable
                onPress={handleRemoveSelected}
                disabled={selectedPhotoIds.size === 0 || isRemovingPhotos}
                className={`flex-row items-center gap-1 px-2 py-1 rounded-full active:opacity-70 ${
                  selectedPhotoIds.size > 0 ? "bg-red-500/10" : "bg-muted"
                }`}
              >
                <Ionicons
                  name={isRemovingPhotos ? "hourglass-outline" : "trash-outline"}
                  size={14}
                  color={selectedPhotoIds.size > 0 ? "#ef4444" : "#9ca3af"}
                />
                <ThemedText
                  variant={"caption2"}
                  className={"font-medium"}
                  style={{ color: selectedPhotoIds.size > 0 ? "#ef4444" : "#9ca3af" }}
                >
                  {isRemovingPhotos ? "Removing..." : `Remove (${selectedPhotoIds.size})`}
                </ThemedText>
              </Pressable>
            </>
          ) : (
            <>
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
            </>
          )}
        </View>
      </View>

      {photos.length > 0 && (
        <Card animated={false} className={"p-2"}>
          <View onLayout={handleLayout} style={{ height: containerHeight }}>
            <FlashList
              data={photos}
              renderItem={renderPhoto}
              keyExtractor={keyExtractor}
              numColumns={NUM_COLUMNS}
              showsVerticalScrollIndicator={actualRows > maxRows}
              extraData={{ isSelectionMode, selectedPhotoIds }}
            />
          </View>
        </Card>
      )}

      {isSelectionMode && photos.length > 0 && (
        <ThemedText variant={"caption2"} color={"tertiary"} className={"text-center"}>
          Tap photos to select, then remove them from this visit
        </ThemedText>
      )}
    </View>
  );
}
