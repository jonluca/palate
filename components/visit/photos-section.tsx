import React from "react";
import { View } from "react-native";
import { ThemedText } from "@/components/themed-text";
import { Card, PhotoGrid } from "@/components/ui";

interface PhotoData {
  id: string;
  uri: string;
}

interface PhotosSectionProps {
  photos: PhotoData[];
  onPhotoPress: (index: number) => void;
}

export function PhotosSection({ photos, onPhotoPress }: PhotosSectionProps) {
  return (
    <View className={"gap-3"}>
      <ThemedText variant={"footnote"} color={"tertiary"} className={"uppercase font-semibold tracking-wide px-1"}>
        Photos ({photos.length.toLocaleString()})
      </ThemedText>

      <Card animated={false} className={"p-2"}>
        <PhotoGrid
          photos={photos}
          columns={3}
          gap={6}
          containerPadding={48}
          onPhotoPress={(_, index) => onPhotoPress(index)}
        />
      </Card>
    </View>
  );
}
