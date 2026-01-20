import React, { useCallback } from "react";
import { View, Pressable, Modal, useWindowDimensions, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Gallery, type RenderItemInfo } from "@/components/AwesomeGallery";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import type { FoodLabel } from "@/utils/db";

interface MediaWithLabels {
  id: string;
  uri: string;
  foodLabels?: FoodLabel[] | null;
  mediaType?: "photo" | "video";
}

interface PhotoGalleryModalProps {
  visible: boolean;
  photos: MediaWithLabels[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

function VideoItem({ item, setImageDimensions }: RenderItemInfo<MediaWithLabels>) {
  const { width, height } = useWindowDimensions();
  const player = useVideoPlayer(item.uri, (p) => {
    p.loop = true;
    p.play();
  });

  // Set dimensions based on screen size for videos
  React.useEffect(() => {
    setImageDimensions({ width, height: height * 0.6 });
  }, [width, height, setImageDimensions]);

  return (
    <View style={[StyleSheet.absoluteFillObject, { justifyContent: "center", alignItems: "center" }]}>
      <VideoView player={player} style={{ width, height: height * 0.8 }} contentFit={"contain"} nativeControls />
    </View>
  );
}

function ImageItem({ item, setImageDimensions }: RenderItemInfo<MediaWithLabels>) {
  return (
    <Image
      onLoad={(e) => {
        const { height: h, width: w } = e.source;
        setImageDimensions({ height: h, width: w });
      }}
      source={item.uri}
      contentFit={"contain"}
      style={StyleSheet.absoluteFillObject}
      cachePolicy={"memory-disk"}
      allowDownscaling={false}
      placeholderContentFit={"cover"}
    />
  );
}

export function PhotoGalleryModal({ visible, photos, currentIndex, onIndexChange, onClose }: PhotoGalleryModalProps) {
  const insets = useSafeAreaInsets();

  const currentPhoto = photos[currentIndex];
  const foodLabels = currentPhoto?.foodLabels as FoodLabel[] | undefined;
  const isVideo = currentPhoto?.mediaType === "video";

  const renderItem = useCallback((info: RenderItemInfo<MediaWithLabels>) => {
    if (info.item.mediaType === "video") {
      return <VideoItem {...info} />;
    }
    return <ImageItem {...info} />;
  }, []);

  // Only show food labels for photos, not videos
  const showFoodLabels = !isVideo && foodLabels && foodLabels.length > 0;

  return (
    <Modal visible={visible} transparent={true} animationType={"fade"} onRequestClose={onClose}>
      <View className={"flex-1 bg-black"}>
        {/* Close button */}
        <Pressable
          style={{
            position: "absolute",
            top: insets.top + 10,
            right: 20,
            zIndex: 10,
            padding: 10,
          }}
          onPress={onClose}
        >
          <IconSymbol name={"xmark.circle.fill"} size={30} color={"white"} />
        </Pressable>

        {/* Food labels for current image with blur effect */}
        {showFoodLabels && (
          <View
            style={{
              position: "absolute",
              top: insets.top + 60,
              left: 16,
              right: 16,
              zIndex: 10,
            }}
          >
            <BlurView
              intensity={40}
              tint={"dark"}
              style={{
                borderRadius: 12,
                overflow: "hidden",
              }}
            >
              <View style={{ padding: 12, gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <ThemedText variant={"caption1"} style={{ color: "white" }}>
                    🍽️
                  </ThemedText>
                  <ThemedText variant={"footnote"} style={{ color: "rgba(255,255,255,0.7)" }}>
                    Detected in this photo
                  </ThemedText>
                </View>
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
                  {foodLabels.map((label) => (
                    <View
                      key={label.label}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 4,
                        backgroundColor: "rgba(245, 158, 11, 0.3)",
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 12,
                      }}
                    >
                      <ThemedText variant={"caption1"} style={{ color: "#fbbf24", fontWeight: "600" }}>
                        {label.label}
                      </ThemedText>
                      <ThemedText variant={"caption2"} style={{ color: "rgba(251, 191, 36, 0.7)" }}>
                        {Math.round(label.confidence * 100).toLocaleString()}%
                      </ThemedText>
                    </View>
                  ))}
                </View>
              </View>
            </BlurView>
          </View>
        )}

        <Gallery
          data={photos}
          initialIndex={currentIndex}
          onIndexChange={onIndexChange}
          onSwipeToClose={onClose}
          renderItem={renderItem}
        />
      </View>
    </Modal>
  );
}
