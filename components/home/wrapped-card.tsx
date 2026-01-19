import React, { useEffect } from "react";
import { View, Pressable, Dimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeIn,
  FadeInUp,
  FadeInRight,
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withDelay,
  Easing,
  interpolate,
} from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { useWrappedStats, type WrappedStats } from "@/hooks/queries";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { useIsFocused } from "@react-navigation/native";

const { width: SCREEN_WIDTH } = Dimensions.get("window");

// Floating particle animation
function FloatingParticle({ delay, size, x, y }: { delay: number; size: number; x: number; y: number }) {
  const translateY = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    translateY.value = withDelay(
      delay,
      withRepeat(
        withSequence(
          withTiming(-30, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0, { duration: 3000, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      ),
    );
    opacity.value = withDelay(delay, withTiming(1, { duration: 1000 }));
  }, [delay, translateY, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
    opacity: opacity.value * 0.6,
  }));

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: x,
          top: y,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: "white",
        },
        animatedStyle,
      ]}
    />
  );
}

// Enhanced stat pill with number animation
function StatPill({
  icon,
  value,
  label,
  delay = 0,
  color = "white",
}: {
  icon: string;
  value: string | number;
  label: string;
  delay?: number;
  color?: string;
}) {
  const scale = useSharedValue(0.8);
  const opacity = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(delay, withTiming(1, { duration: 400, easing: Easing.out(Easing.back(1.5)) }));
    opacity.value = withDelay(delay, withTiming(1, { duration: 300 }));
  }, [delay, scale, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={animatedStyle}
      className={"bg-white/10 backdrop-blur-sm rounded-2xl px-4 py-3 items-center gap-1 flex-1 min-w-[90px]"}
    >
      <ThemedText variant={"title3"}>{icon}</ThemedText>
      <ThemedText variant={"title2"} className={"font-bold"} style={{ color }}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </ThemedText>
      <ThemedText variant={"caption2"} className={"text-white/60 text-center"}>
        {label}
      </ThemedText>
    </Animated.View>
  );
}

// Michelin badge with shine effect
function MichelinBadge({ count, stars }: { count: number; stars: number }) {
  const shine = useSharedValue(0);

  useEffect(() => {
    if (count === 0) {
      return;
    }
    shine.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.linear }), -1, false);
  }, [shine, count]);

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

// Shimmer skeleton element
function ShimmerSkeleton({
  width,
  height,
  borderRadius = 8,
}: {
  width: number | `${number}%`;
  height: number;
  borderRadius?: number;
}) {
  const shimmerProgress = useSharedValue(0);

  useEffect(() => {
    shimmerProgress.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.linear }), -1, false);
  }, [shimmerProgress]);

  const animatedStyle = useAnimatedStyle(() => {
    const opacity = interpolate(shimmerProgress.value, [0, 0.5, 1], [0.15, 0.3, 0.15]);
    return { opacity };
  });

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius,
          backgroundColor: "white",
        },
        animatedStyle,
      ]}
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
              <ShimmerSkeleton width={140} height={12} borderRadius={6} />
              <ShimmerSkeleton width={100} height={32} borderRadius={8} />
            </View>
            <ShimmerSkeleton width={48} height={48} borderRadius={24} />
          </View>

          {/* Stats row skeleton */}
          <View className={"flex-row gap-3"}>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <ShimmerSkeleton width={24} height={24} borderRadius={12} />
              <ShimmerSkeleton width={40} height={20} borderRadius={6} />
              <ShimmerSkeleton width={32} height={10} borderRadius={4} />
            </View>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <ShimmerSkeleton width={24} height={24} borderRadius={12} />
              <ShimmerSkeleton width={40} height={20} borderRadius={6} />
              <ShimmerSkeleton width={32} height={10} borderRadius={4} />
            </View>
            <View className={"bg-white/10 rounded-2xl px-4 py-3 items-center gap-2 flex-1 min-w-[90px]"}>
              <ShimmerSkeleton width={24} height={24} borderRadius={12} />
              <ShimmerSkeleton width={40} height={20} borderRadius={6} />
              <ShimmerSkeleton width={32} height={10} borderRadius={4} />
            </View>
          </View>

          {/* Bottom hint skeleton */}
          <View className={"items-center"}>
            <ShimmerSkeleton width={180} height={10} borderRadius={5} />
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

// Inner card content (extracted to avoid hooks in conditional)
function WrappedCardContent({ stats }: { stats: WrappedStats }) {
  const cardScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0.3);

  useEffect(() => {
    glowOpacity.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.3, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );
  }, [glowOpacity]);

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    router.push("/wrapped");
  };

  const handlePressIn = () => {
    cardScale.value = withTiming(0.98, { duration: 100 });
  };

  const handlePressOut = () => {
    cardScale.value = withTiming(1, { duration: 200 });
  };

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ scale: cardScale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const hasMichelinVisits = stats.michelinStats.totalStarredVisits > 0;
  const hasTopRestaurant = stats.mostRevisitedRestaurant && stats.mostRevisitedRestaurant.visits > 1;

  return (
    <Animated.View entering={FadeIn.duration(600)} style={cardStyle}>
      <Pressable onPress={handlePress} onPressIn={handlePressIn} onPressOut={handlePressOut}>
        <View className={"rounded-3xl overflow-hidden relative"} style={{ borderCurve: "continuous" }}>
          {/* Animated Glow Effect */}
          <Animated.View
            style={[
              {
                position: "absolute",
                top: -50,
                left: -50,
                right: -50,
                bottom: -50,
                borderRadius: 40,
              },
              glowStyle,
            ]}
          >
            <LinearGradient
              colors={["#f97316", "#ec4899", "#8b5cf6", "#3b82f6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={{ flex: 1, borderRadius: 40 }}
            />
          </Animated.View>

          <LinearGradient
            colors={["#0f0f1a", "#1a1a2e", "#16213e"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            className={"rounded-3xl overflow-hidden relative"}
          >
            {/* Floating Particles */}
            <View className={"absolute inset-0"} pointerEvents={"none"}>
              <FloatingParticle delay={0} size={4} x={20} y={40} />
              <FloatingParticle delay={500} size={3} x={SCREEN_WIDTH * 0.3} y={20} />
              <FloatingParticle delay={1000} size={5} x={SCREEN_WIDTH * 0.6} y={60} />
              <FloatingParticle delay={1500} size={3} x={SCREEN_WIDTH * 0.8} y={30} />
              <FloatingParticle delay={800} size={4} x={SCREEN_WIDTH * 0.5} y={80} />
            </View>

            <View className={"p-5 gap-5"}>
              {/* Header */}
              <View className={"flex-row items-start justify-between"}>
                <Animated.View entering={FadeInUp.delay(100).duration(500)} className={"gap-1 flex-1"}>
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
                </Animated.View>

                <Animated.View
                  entering={FadeInRight.delay(300).duration(400)}
                  className={"w-12 h-12 rounded-full bg-white/10 items-center justify-center"}
                >
                  <IconSymbol name={"chevron.right"} size={24} color={"white"} />
                </Animated.View>
              </View>

              {/* Quick Stats Row */}
              <View className={"flex-row gap-3"}>
                <StatPill
                  icon={"🍽️"}
                  value={stats.totalConfirmedVisits}
                  label={"Visits"}
                  delay={200}
                  color={"#f97316"}
                />
                <StatPill
                  icon={"🏠"}
                  value={stats.totalUniqueRestaurants}
                  label={"Places"}
                  delay={300}
                  color={"#22c55e"}
                />
                {stats.averageVisitsPerMonth > 0 && (
                  <StatPill
                    icon={"📅"}
                    value={stats.averageVisitsPerMonth}
                    label={"Monthly"}
                    delay={400}
                    color={"#3b82f6"}
                  />
                )}
              </View>

              {/* Top Restaurant Highlight */}
              {hasTopRestaurant && (
                <Animated.View entering={FadeInUp.delay(500).duration(400)} className={"bg-white/5 rounded-xl p-3"}>
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
                </Animated.View>
              )}

              {/* Tap hint */}
              <Animated.View entering={FadeIn.delay(600).duration(400)}>
                <ThemedText variant={"caption2"} className={"text-white/30 text-center"}>
                  Tap to see your full dining story →
                </ThemedText>
              </Animated.View>
            </View>
          </LinearGradient>
        </View>
      </Pressable>
    </Animated.View>
  );
}

export function WrappedCard() {
  const isFocused = useIsFocused();
  const { data: stats, isLoading } = useWrappedStats(null, { enabled: isFocused });

  // Show loading skeleton while fetching
  if (isLoading) {
    return (
      <Animated.View entering={FadeIn.duration(300)}>
        <WrappedCardSkeleton />
      </Animated.View>
    );
  }

  // Don't show if no data or no confirmed visits
  if (!stats || stats.totalConfirmedVisits === 0) {
    return null;
  }

  return <WrappedCardContent stats={stats} />;
}
