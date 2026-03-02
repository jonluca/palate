import React from "react";
import { Pressable, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import { Image } from "expo-image";
import { IconSymbol, type IconSymbolName } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { cn } from "@/utils/cn";

export type RestaurantRowVariant = "main" | "compact" | "selection";
type RestaurantBadgeTone = "primary" | "success" | "michelin" | "neutral" | "warning";
export type RestaurantRowSource = "visited" | "michelin" | "mapkit" | "google";

export interface RestaurantRowBadge {
  label: string;
  icon?: IconSymbolName;
  tone?: RestaurantBadgeTone;
}

interface RestaurantRowCardProps extends Omit<PressableProps, "children" | "style"> {
  title: string;
  subtitle?: string | null;
  supportingText?: string | null;
  imageUri?: string | null;
  variant?: RestaurantRowVariant;
  badge?: RestaurantRowBadge | null;
  rightAccessory?: React.ReactNode;
  selected?: boolean;
  source?: RestaurantRowSource;
  className?: string;
  style?: StyleProp<ViewStyle>;
}

function getBadgeStyles(tone: RestaurantBadgeTone = "neutral") {
  switch (tone) {
    case "primary":
      return {
        wrapper: "bg-primary/12 border-primary/20",
        text: "text-primary",
        iconColor: "#0A84FF",
      };
    case "success":
      return {
        wrapper: "bg-green-500/12 border-green-500/20",
        text: "text-green-400",
        iconColor: "#4ADE80",
      };
    case "michelin":
      return {
        wrapper: "bg-amber-500/12 border-amber-500/20",
        text: "text-amber-300",
        iconColor: "#FBBF24",
      };
    case "warning":
      return {
        wrapper: "bg-orange-500/12 border-orange-500/20",
        text: "text-orange-300",
        iconColor: "#FB923C",
      };
    default:
      return {
        wrapper: "bg-white/6 border-white/8",
        text: "text-white/62",
        iconColor: "#A1A1AA",
      };
  }
}

function getPlaceholder(source: RestaurantRowSource = "michelin") {
  switch (source) {
    case "visited":
      return {
        icon: "fork.knife" as const,
        wrapper: "bg-primary/14",
        iconColor: "#0A84FF",
      };
    case "mapkit":
      return {
        icon: "map.fill" as const,
        wrapper: "bg-sky-500/14",
        iconColor: "#38BDF8",
      };
    case "google":
      return {
        icon: "globe" as const,
        wrapper: "bg-emerald-500/14",
        iconColor: "#34D399",
      };
    default:
      return {
        icon: "star.fill" as const,
        wrapper: "bg-amber-500/14",
        iconColor: "#FBBF24",
      };
  }
}

export function getRestaurantAwardBadge(award: string | null | undefined): RestaurantRowBadge | null {
  if (!award) {
    return null;
  }

  const lower = award.toLowerCase();
  if (lower.includes("3 star")) {
    return { label: "3 Michelin Stars", icon: "star.fill", tone: "michelin" };
  }
  if (lower.includes("2 star")) {
    return { label: "2 Michelin Stars", icon: "star.fill", tone: "michelin" };
  }
  if (lower.includes("1 star")) {
    return { label: "1 Michelin Star", icon: "star.fill", tone: "michelin" };
  }
  if (lower.includes("bib")) {
    return { label: "Bib Gourmand", icon: "fork.knife", tone: "warning" };
  }
  if (lower.includes("selected") || lower.includes("guide")) {
    return { label: "Michelin Guide", icon: "star.fill", tone: "michelin" };
  }
  if (lower.includes("green star")) {
    return { label: "Green Star", icon: "leaf.fill", tone: "success" };
  }
  return { label: award, icon: "star.fill", tone: "michelin" };
}

export function getRestaurantSourceBadge(source: RestaurantRowSource): RestaurantRowBadge | null {
  switch (source) {
    case "mapkit":
      return { label: "Apple Maps", icon: "map.fill", tone: "primary" };
    case "google":
      return { label: "Google Maps", icon: "globe", tone: "success" };
    case "visited":
      return { label: "Saved", icon: "checkmark.circle.fill", tone: "success" };
    case "michelin":
    default:
      return { label: "Michelin", icon: "star.fill", tone: "michelin" };
  }
}

export function formatRestaurantDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters).toLocaleString()}m`;
  }

  const km = meters / 1000;
  return `${km.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}km`;
}

export function RestaurantRowChevron() {
  return (
    <View className={"w-8 h-8 rounded-full bg-secondary/80 items-center justify-center"}>
      <IconSymbol name={"chevron.right"} size={13} color={"#8E8E93"} />
    </View>
  );
}

export function RestaurantRowCard({
  title,
  subtitle,
  supportingText,
  imageUri,
  variant = "compact",
  badge,
  rightAccessory,
  selected = false,
  source = "michelin",
  style,
  className,
  disabled,
  ...props
}: RestaurantRowCardProps) {
  const isMain = variant === "main";
  const isSelection = variant === "selection";
  const thumbSize = isMain ? 82 : variant === "compact" ? 68 : 60;
  const placeholder = getPlaceholder(source);
  const badgeStyles = badge ? getBadgeStyles(badge.tone) : null;

  return (
    <Pressable
      disabled={disabled}
      className={cn(
        "rounded-[24px] border overflow-hidden",
        isMain ? "bg-card border-border" : "bg-card/80 border-white/8",
        selected ? "border-primary/40 bg-primary/10" : null,
        className,
      )}
      style={[
        {
          borderCurve: "continuous",
          boxShadow: isMain ? "0 1px 0 rgba(255,255,255,0.05), 0 10px 24px rgba(0,0,0,0.28)" : undefined,
        },
        style,
      ]}
      {...props}
    >
      <View className={cn("flex-row gap-3", isMain ? "p-3" : "p-2.5")}>
        <View
          style={{ width: thumbSize, height: thumbSize }}
          className={"rounded-[20px] overflow-hidden bg-secondary/60 items-center justify-center"}
        >
          {imageUri ? (
            <Image
              source={{ uri: imageUri }}
              style={{ width: "100%", height: "100%" }}
              contentFit={"cover"}
              transition={200}
            />
          ) : (
            <View className={cn("w-full h-full items-center justify-center", placeholder.wrapper)}>
              <IconSymbol
                name={placeholder.icon}
                size={variant === "selection" ? 20 : 22}
                color={placeholder.iconColor}
              />
            </View>
          )}
        </View>

        <View className={"flex-1 min-w-0 justify-center gap-1.5 py-0.5"}>
          <View className={"flex-row items-start gap-3"}>
            <View className={"flex-1 gap-1"}>
              <ThemedText
                variant={isMain ? "heading" : "subhead"}
                className={"font-semibold"}
                numberOfLines={variant === "main" ? 2 : 1}
              >
                {title}
              </ThemedText>
              {subtitle ? (
                <ThemedText variant={isSelection ? "caption1" : "footnote"} color={"secondary"} numberOfLines={1}>
                  {subtitle}
                </ThemedText>
              ) : null}
            </View>
            {rightAccessory ? <View className={"items-end justify-center"}>{rightAccessory}</View> : null}
          </View>

          {badge ? (
            <View
              className={cn(
                "self-start flex-row items-center gap-1.5 px-2 py-1 rounded-full border",
                badgeStyles?.wrapper,
              )}
            >
              {badge.icon ? (
                <IconSymbol name={badge.icon} size={11} color={badgeStyles?.iconColor ?? "#A1A1AA"} />
              ) : null}
              <ThemedText variant={"caption2"} className={cn("font-medium", badgeStyles?.text)}>
                {badge.label}
              </ThemedText>
            </View>
          ) : null}

          {supportingText ? (
            <ThemedText variant={isSelection ? "caption2" : "caption1"} color={"tertiary"} numberOfLines={2}>
              {supportingText}
            </ThemedText>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}
