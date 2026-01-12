import React, { useState, useCallback } from "react";
import { View, TextInput, Pressable, Keyboard } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { IconSymbol } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { Card } from "@/components/ui";
import * as Haptics from "expo-haptics";

interface NotesCardProps {
  notes: string | null;
  onSave: (notes: string | null) => void;
  isSaving?: boolean;
}

export function NotesCard({ notes, onSave, isSaving = false }: NotesCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedNotes, setEditedNotes] = useState(notes ?? "");

  const handleEdit = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setEditedNotes(notes ?? "");
    setIsEditing(true);
  }, [notes]);

  const handleCancel = useCallback(() => {
    Keyboard.dismiss();
    setIsEditing(false);
    setEditedNotes(notes ?? "");
  }, [notes]);

  const handleSave = useCallback(() => {
    Keyboard.dismiss();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const trimmedNotes = editedNotes.trim();
    onSave(trimmedNotes || null);
    setIsEditing(false);
  }, [editedNotes, onSave]);

  const hasNotes = notes && notes.trim().length > 0;
  const hasChanges = editedNotes.trim() !== (notes ?? "").trim();

  if (isEditing) {
    return (
      <Card delay={85}>
        <View className={"p-4 gap-3"}>
          <View className={"flex-row items-center gap-2"}>
            <View className={"w-7 h-7 rounded-full bg-amber-500/20 items-center justify-center"}>
              <IconSymbol name={"note.text"} size={16} color={"#f59e0b"} />
            </View>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Notes
            </ThemedText>
          </View>

          <TextInput
            value={editedNotes}
            onChangeText={setEditedNotes}
            placeholder={"Add notes about this visit..."}
            placeholderTextColor={"#6b7280"}
            multiline
            autoFocus
            className={"bg-black/20 rounded-lg p-3 text-white min-h-[100px] text-base"}
            style={{ textAlignVertical: "top" }}
          />

          <View className={"flex-row gap-2"}>
            <Pressable
              onPress={handleCancel}
              className={"flex-1 py-2.5 rounded-lg bg-white/10 items-center justify-center"}
            >
              <ThemedText variant={"subhead"} color={"secondary"}>
                Cancel
              </ThemedText>
            </Pressable>
            <Pressable
              onPress={handleSave}
              disabled={isSaving || !hasChanges}
              className={`flex-1 py-2.5 rounded-lg items-center justify-center ${
                hasChanges ? "bg-amber-500" : "bg-amber-500/50"
              }`}
            >
              <ThemedText
                variant={"subhead"}
                className={`font-semibold ${hasChanges ? "text-black" : "text-black/50"}`}
              >
                {isSaving ? "Saving..." : "Save"}
              </ThemedText>
            </Pressable>
          </View>
        </View>
      </Card>
    );
  }

  return (
    <Card delay={85}>
      <Pressable onPress={handleEdit} className={"p-4 gap-2"}>
        <View className={"flex-row items-center justify-between"}>
          <View className={"flex-row items-center gap-2"}>
            <View className={"w-7 h-7 rounded-full bg-amber-500/20 items-center justify-center"}>
              <IconSymbol name={"note.text"} size={16} color={"#f59e0b"} />
            </View>
            <ThemedText variant={"footnote"} color={"secondary"}>
              Notes
            </ThemedText>
          </View>
          <View className={"flex-row items-center gap-1"}>
            <IconSymbol name={"pencil"} size={14} color={"#6b7280"} />
            <ThemedText variant={"caption1"} color={"tertiary"}>
              {hasNotes ? "Edit" : "Add"}
            </ThemedText>
          </View>
        </View>

        {hasNotes ? (
          <Animated.View entering={FadeIn.duration(200)}>
            <ThemedText variant={"body"} className={"leading-relaxed"}>
              {notes}
            </ThemedText>
          </Animated.View>
        ) : (
          <ThemedText variant={"body"} color={"tertiary"} className={"italic"}>
            Tap to add notes about this visit...
          </ThemedText>
        )}
      </Pressable>
    </Card>
  );
}
