import React from "react";
import { View, Pressable } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card, PhotoGrid } from "@/components/ui";
import { Ionicons } from "@expo/vector-icons";

interface PhotoData {
  id: string;
  uri: string;
}

interface PhotosSectionProps {
  photos: PhotoData[];
  onPhotoPress: (index: number) => void;
  onAddPhotos?: () => void;
  isAddingPhotos?: boolean;
}

export function PhotosSection({ photos, onPhotoPress, onAddPhotos, isAddingPhotos }: PhotosSectionProps) {
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
        <PhotoGrid
          photos={photos}
          gap={6}
          // Responsive columns based on available width.
          minPhotoSize={96}
          minColumns={2}
          maxColumns={4}
          onPhotoPress={(_, index) => onPhotoPress(index)}
        />
      </Card>
    </View>
  );
}
