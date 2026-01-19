import React from "react";
import { View, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { useWrappedStats, type WrappedStats } from "@/hooks/queries";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "@react-navigation/native";

// Stat pill component
function StatPill({
  icon,
  value,
  label,
  color = "white",
}: {
  icon: string;
  value: string | number;
  label: string;
  color?: string;
}) {
  return (
    <View className={"bg-white/10 backdrop-blur-sm rounded-2xl px-4 py-3 items-center gap-1 flex-1 min-w-[90px]"}>
      <ThemedText variant={"title3"}>{icon}</ThemedText>
      <ThemedText variant={"title2"} className={"font-bold"} style={{ color }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </ThemedText>
      <ThemedText variant={"caption2"} className={"text-white/60 text-center"}>
        {label}
      </ThemedText>
    </View>
  );
}

// Michelin badge
function MichelinBadge({ count, stars }: { count: number; stars: number }) {
  if (count === 0) {
    return null;
  }

  return (
    <View className={"bg-amber-500/20 rounded-full px-3 py-1.5 flex-row items-center gap-1.5 overflow-hidden"}>
      <ThemedText variant={"caption1"}>{"⭐".repeat(stars)}</ThemedText>
      <ThemedText variant={"caption1"} className={"text-amber-400 font-bold"}>
        ×{count.toLocaleString()}
      </ThemedText>
    </View>
  );
}

// Skeleton element
function SkeletonBox({
  width,
  height,
  borderRadius = 8,
}: {
  width: number | `${number}%`;
  height: number;
  borderRadius?: number;
}) {
  return (
    <View
      style={{
        width,
        height,
        borderRadius,
        backgroundColor: "rgba(255, 255, 255, 0.15)",
      }}
    />
  );
}

// Loading skeleton for the wrapped card
function WrappedCardSkeleton() {
  return (
    <View className={"rounded-3xl overflow-hidden relative"} style={{ borderCurve: "continuous" }}>
      <LinearGradient
        colors={["#0f0f1a", "#1a1a2e", "#16213e"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        className={"rounded-3xl overflow-hidden relative"}
      >
        <View className={"p-5 gap-5"}>
          {/* Header skeleton */}
          <View className={"flex-row items-start justify-between"}>
            <View className={"gap-2 flex-1"}>
              <SkeletonBox width={140} height={12} borderRadius={6} />
              <SkeletonBox width={100} height={32} borderRadius={8} />
            </View>
            <SkeletonBox width={48} height={48} borderRadius={24} />
          </View>

          {/* Stats row skeleton */}
          <View className={"flex-row gap-3"}>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <SkeletonBox width={24} height={24} borderRadius={12} />
              <SkeletonBox width={40} height={20} borderRadius={6} />
              <SkeletonBox width={32} height={10} borderRadius={4} />
            </View>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <SkeletonBox width={24} height={24} borderRadius={12} />
              <SkeletonBox width={40} height={20} borderRadius={6} />
              <SkeletonBox width={32} height={10} borderRadius={4} />
            </View>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <SkeletonBox width={24} height={24} borderRadius={12} />
              <SkeletonBox width={40} height={20} borderRadius={6} />
              <SkeletonBox width={32} height={10} borderRadius={4} />
            </View>
          </View>

          {/* Bottom hint skeleton */}
          <View className={"items-center"}>
            <SkeletonBox width={180} height={10} borderRadius={5} />
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

// Inner card content
function WrappedCardContent({ stats }: { stats: WrappedStats }) {
  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/wrapped");
  };

  const hasMichelinVisits = stats.michelinStats.totalStarredVisits > 0;
  const hasTopRestaurant = stats.mostRevisitedRestaurant && stats.mostRevisitedRestaurant.visits > 1;

  return (
    <Pressable onPress={handlePress}>
      <View className={"rounded-3xl overflow-hidden relative"} style={{ borderCurve: "continuous" }}>
        {/* Glow Effect */}
        <View
          style={{
            position: "absolute",
            top: -50,
            left: -50,
            right: -50,
            bottom: -50,
            borderRadius: 40,
            opacity: 0.4,
          }}
        >
          <LinearGradient
            colors={["#f97316", "#ec4899", "#8b5cf6", "#3b82f6"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ flex: 1, borderRadius: 40 }}
          />
        </View>

        <LinearGradient
          colors={["#0f0f1a", "#1a1a2e", "#16213e"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          className={"rounded-3xl overflow-hidden relative"}
        >
          <View className={"p-5 gap-5"}>
            {/* Header */}
            <View className={"flex-row items-start justify-between"}>
              <View className={"gap-1 flex-1"}>
                <View className={"flex-row items-center gap-2 flex-wrap"}>
                  <ThemedText variant={"caption1"} className={"text-amber-400 uppercase tracking-widest font-bold"}>
                    ✨ Your Dining Journey
                  </ThemedText>
                  {hasMichelinVisits && (
                    <MichelinBadge
                      count={stats.michelinStats.totalAccumulatedStars}
                      stars={stats.michelinStats.threeStars > 0 ? 3 : stats.michelinStats.twoStars > 0 ? 2 : 1}
                    />
                  )}
                </View>
                <ThemedText variant={"largeTitle"} className={"text-white font-black"}>
                  Wrapped
                </ThemedText>
              </View>

              <View className={"w-12 h-12 rounded-full bg-white/10 items-center justify-center"}>
                <IconSymbol name={"chevron.right"} size={24} color={"white"} />
              </View>
            </View>

            {/* Quick Stats Row */}
            <View className={"flex-row gap-3"}>
              <StatPill icon={"🍽️"} value={stats.totalConfirmedVisits} label={"Visits"} color={"#f97316"} />
              <StatPill icon={"🏠"} value={stats.totalUniqueRestaurants} label={"Places"} color={"#22c55e"} />
              {stats.averageVisitsPerMonth > 0 && (
                <StatPill icon={"📅"} value={stats.averageVisitsPerMonth} label={"Monthly"} color={"#3b82f6"} />
              )}
            </View>

            {/* Top Restaurant Highlight */}
            {hasTopRestaurant && (
              <View className={"bg-white/5 rounded-xl p-3"}>
                <View className={"flex-row items-center gap-3"}>
                  <View className={"w-10 h-10 rounded-full bg-amber-500/20 items-center justify-center"}>
                    <ThemedText variant={"title3"}>👑</ThemedText>
                  </View>
                  <View className={"flex-1"}>
                    <ThemedText variant={"caption2"} className={"text-white/50"}>
                      Your Favorite
                    </ThemedText>
                    <ThemedText variant={"subhead"} className={"text-white font-semibold"} numberOfLines={1}>
                      {stats.mostRevisitedRestaurant?.name}
                    </ThemedText>
                  </View>
                  <View className={"bg-amber-500/20 px-2 py-1 rounded-lg"}>
                    <ThemedText variant={"caption1"} className={"text-amber-400 font-bold"}>
                      {stats.mostRevisitedRestaurant?.visits.toLocaleString()}× visits
                    </ThemedText>
                  </View>
                </View>
              </View>
            )}

            {/* Tap hint */}
            <ThemedText variant={"caption2"} className={"text-white/30 text-center"}>
              Tap to see your full dining story →
            </ThemedText>
          </View>
        </LinearGradient>
      </View>
    </Pressable>
  );
}

export function WrappedCard() {
  const isFocused = useIsFocused();
  const { data: stats, isLoading } = useWrappedStats(null, { enabled: isFocused });

  // Show loading skeleton while fetching
  if (isLoading) {
    return <WrappedCardSkeleton />;
  }

  // Don't show if no data or no confirmed visits
  if (!stats || stats.totalConfirmedVisits === 0) {
    return null;
  }

  return <WrappedCardContent stats={stats} />;
}
