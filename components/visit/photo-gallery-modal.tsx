import React from "react";
import { View, Pressable, Modal } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BlurView } from "expo-blur";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Gallery } from "@/components/AwesomeGallery";
import type { FoodLabel } from "@/utils/db";

interface PhotoWithLabels {
  id: string;
  uri: string;
  foodLabels?: FoodLabel[] | null;
}

interface PhotoGalleryModalProps {
  visible: boolean;
  photos: PhotoWithLabels[];
  currentIndex: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export function PhotoGalleryModal({ visible, photos, currentIndex, onIndexChange, onClose }: PhotoGalleryModalProps) {
  const insets = useSafeAreaInsets();

  const currentPhoto = photos[currentIndex];
  const foodLabels = currentPhoto?.foodLabels as FoodLabel[] | undefined;

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
        {foodLabels && foodLabels.length > 0 && (
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
          data={photos.map((p) => p.uri)}
          initialIndex={currentIndex}
          onIndexChange={onIndexChange}
          onSwipeToClose={onClose}
        />
      </View>
    </Modal>
  );
}
