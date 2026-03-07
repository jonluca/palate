import React from "react";
import { TextInput, View, type TextInputProps } from "react-native";
import { ThemedText } from "@/components/themed-text";

type AuthTextFieldProps = TextInputProps & {
  label: string;
  hint?: string;
};

export function AuthTextField({ label, hint, ...props }: AuthTextFieldProps) {
  return (
    <View className={"gap-2"}>
      <View className={"flex-row items-center justify-between gap-3"}>
        <ThemedText variant={"subhead"} className={"font-semibold"}>
          {label}
        </ThemedText>
        {hint ? (
          <ThemedText variant={"caption1"} color={"tertiary"}>
            {hint}
          </ThemedText>
        ) : null}
      </View>
      <TextInput
        placeholderTextColor={"rgba(255,255,255,0.42)"}
        className={"rounded-2xl border border-white/10 bg-background px-4 py-3 text-[16px] text-foreground"}
        autoCorrect={false}
        {...props}
      />
    </View>
  );
}

