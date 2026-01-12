import React, { useEffect, useMemo } from "react";
import { View, ScrollView, Pressable, Dimensions } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  useSharedValue,
  useAnimatedStyle,
  withDelay,
  withTiming,
  withSequence,
  Easing,
} from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { IconSymbol } from "@/components/icon-symbol";
import { useWrappedStats, type WrappedStats } from "@/hooks/queries";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CONFETTI_COLORS = ["#f97316", "#eab308", "#22c55e", "#3b82f6", "#8b5cf6", "#ec4899"];

function formatDateShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Confetti particle
function ConfettiPiece({ index, color, startX }: { index: number; color: string; startX: number }) {
  const translateY = useSharedValue(-50);
  const translateX = useSharedValue(0);
  const rotate = useSharedValue(0);
  const opacity = useSharedValue(1);

  const randomDuration = 3000 + Math.random() * 2000;
  const randomDelay = index * 80;
  const randomSwing = (Math.random() - 0.5) * 100;

  useEffect(() => {
    translateY.value = withDelay(
      randomDelay,
      withTiming(SCREEN_HEIGHT + 50, { duration: randomDuration, easing: Easing.out(Easing.quad) }),
    );
    translateX.value = withDelay(
      randomDelay,
      withSequence(
        withTiming(randomSwing, { duration: randomDuration / 3 }),
        withTiming(-randomSwing / 2, { duration: randomDuration / 3 }),
        withTiming(randomSwing / 3, { duration: randomDuration / 3 }),
      ),
    );
    rotate.value = withDelay(
      randomDelay,
      withTiming(360 * (Math.random() > 0.5 ? 1 : -1) * 3, { duration: randomDuration }),
    );
    opacity.value = withDelay(randomDelay + randomDuration * 0.7, withTiming(0, { duration: randomDuration * 0.3 }));
  }, [translateY, translateX, rotate, opacity, randomDelay, randomDuration, randomSwing]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { translateX: translateX.value }, { rotate: `${rotate.value}deg` }],
    opacity: opacity.value,
  }));

  const size = 8 + Math.random() * 8;

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: startX,
          top: -50,
          width: size,
          height: size * (Math.random() > 0.5 ? 1 : 0.5),
          backgroundColor: color,
          borderRadius: Math.random() > 0.5 ? size / 2 : 2,
        },
        animatedStyle,
      ]}
    />
  );
}

// Confetti burst
function Confetti({ enabled }: { enabled: boolean }) {
  const pieces = useMemo(() => {
    if (!enabled) {
      return [];
    }
    return Array.from({ length: 50 }).map((_, i) => ({
      id: i,
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      startX: Math.random() * SCREEN_WIDTH,
    }));
  }, [enabled]);

  if (!enabled) {
    return null;
  }

  return (
    <View className={"absolute inset-0 z-50"} pointerEvents={"none"}>
      {pieces.map((piece) => (
        <ConfettiPiece key={piece.id} index={piece.id} color={piece.color} startX={piece.startX} />
      ))}
    </View>
  );
}

function StatPill({
  icon,
  value,
  label,
  delay = 0,
}: {
  icon: string;
  value: string | number;
  label: string;
  delay?: number;
}) {
  return (
    <Animated.View
      entering={FadeInUp.delay(delay).duration(400)}
      className={"bg-white/10 rounded-2xl px-5 py-4 items-center gap-2 flex-1"}
    >
      <ThemedText variant={"largeTitle"}>{icon}</ThemedText>
      <ThemedText variant={"largeTitle"} className={"text-white font-bold"}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </ThemedText>
      <ThemedText variant={"footnote"} className={"text-white/60 text-center"}>
        {label}
      </ThemedText>
    </Animated.View>
  );
}

function StarBreakdown({ stats }: { stats: WrappedStats["michelinStats"] }) {
  const items = [
    { emoji: "⭐⭐⭐", label: "3 Stars", count: stats.threeStars },
    { emoji: "⭐⭐", label: "2 Stars", count: stats.twoStars },
    { emoji: "⭐", label: "1 Star", count: stats.oneStars },
    { emoji: "🍽️", label: "Bib Gourmand", count: stats.bibGourmand },
    { emoji: "🏆", label: "Selected", count: stats.selected },
  ].filter((item) => item.count > 0);

  if (items.length === 0) {
    return null;
  }

  const hasStars = stats.totalAccumulatedStars > 0;

  return (
    <Animated.View entering={FadeInDown.delay(200).duration(400)} className={"gap-4"}>
      <ThemedText variant={"title2"} className={"text-white font-bold"}>
        ⭐ Michelin Experiences
      </ThemedText>

      {/* Star Summary */}
      {hasStars && (
        <Animated.View
          entering={FadeIn.delay(250).duration(400)}
          className={
            "bg-gradient-to-r from-amber-500/20 to-yellow-500/20 bg-amber-500/15 rounded-2xl p-5 flex-row items-center justify-around"
          }
        >
          <View className={"items-center"}>
            <ThemedText variant={"largeTitle"} className={"text-amber-400 font-bold"}>
              {stats.totalAccumulatedStars.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              Total Stars Earned
            </ThemedText>
          </View>
          <View className={"w-px h-12 bg-white/20"} />
          <View className={"items-center"}>
            <ThemedText variant={"largeTitle"} className={"text-amber-400 font-bold"}>
              {stats.distinctStarredRestaurants.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              Starred Restaurants
            </ThemedText>
          </View>
        </Animated.View>
      )}

      {/* Breakdown by type */}
      <View className={"flex-row flex-wrap gap-3"}>
        {items.map((item, index) => (
          <Animated.View
            key={item.label}
            entering={FadeIn.delay(300 + index * 100).duration(300)}
            className={"bg-white/10 rounded-xl px-4 py-3 flex-row items-center gap-2"}
          >
            <ThemedText variant={"title3"}>{item.emoji}</ThemedText>
            <ThemedText variant={"subhead"} className={"text-white font-medium"}>
              {item.count.toLocaleString()} {item.count === 1 ? "visit" : "visits"}
            </ThemedText>
          </Animated.View>
        ))}
      </View>
    </Animated.View>
  );
}

function YearlyHighlight({ yearData, index }: { yearData: WrappedStats["yearlyStats"][0]; index: number }) {
  return (
    <Animated.View
      entering={FadeInDown.delay(400 + index * 100).duration(400)}
      className={"bg-white/10 rounded-2xl p-5 min-w-[220px]"}
    >
      <ThemedText variant={"largeTitle"} className={"text-white font-bold"}>
        {yearData.year}
      </ThemedText>
      <View className={"mt-4 gap-3"}>
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-10 h-10 rounded-full bg-white/20 items-center justify-center"}>
            <IconSymbol name={"fork.knife"} size={18} color={"white"} />
          </View>
          <View>
            <ThemedText variant={"title1"} className={"text-white font-bold"}>
              {yearData.totalVisits.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              visits
            </ThemedText>
          </View>
        </View>
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-10 h-10 rounded-full bg-white/20 items-center justify-center"}>
            <IconSymbol name={"building.2"} size={18} color={"white"} />
          </View>
          <View>
            <ThemedText variant={"title1"} className={"text-white font-bold"}>
              {yearData.uniqueRestaurants.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              restaurants
            </ThemedText>
          </View>
        </View>
        {yearData.topRestaurant && (
          <View className={"mt-2 pt-3 border-t border-white/10"}>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              Most Visited
            </ThemedText>
            <ThemedText variant={"body"} className={"text-white font-medium"} numberOfLines={1}>
              {yearData.topRestaurant.name}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-amber-300"}>
              {yearData.topRestaurant.visits.toLocaleString()} visits
            </ThemedText>
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function CuisineCloud({ cuisines }: { cuisines: WrappedStats["topCuisines"] }) {
  if (cuisines.length === 0) {
    return null;
  }

  const maxCount = Math.max(...cuisines.map((c) => c.count));

  return (
    <Animated.View entering={FadeInDown.delay(600).duration(400)} className={"gap-4"}>
      <ThemedText variant={"title2"} className={"text-white font-bold"}>
        🍜 Favorite Cuisines
      </ThemedText>
      <View className={"flex-row flex-wrap gap-3"}>
        {cuisines.map((cuisine, index) => {
          const intensity = cuisine.count / maxCount;
          const bgOpacity = 0.1 + intensity * 0.25;
          return (
            <Animated.View
              key={cuisine.cuisine}
              entering={FadeIn.delay(700 + index * 80).duration(300)}
              className={"rounded-full px-4 py-2"}
              style={{ backgroundColor: `rgba(255, 255, 255, ${bgOpacity})` }}
            >
              <ThemedText
                variant={intensity > 0.7 ? "body" : "subhead"}
                className={"text-white"}
                style={{ fontWeight: intensity > 0.5 ? "600" : "400" }}
              >
                {cuisine.cuisine}
                <ThemedText variant={"footnote"} className={"text-white/50"}>
                  {" "}
                  {cuisine.count.toLocaleString()}
                </ThemedText>
              </ThemedText>
            </Animated.View>
          );
        })}
      </View>
    </Animated.View>
  );
}

function FunFactCard({
  icon,
  iconBg,
  title,
  value,
  subtitle,
  delay,
}: {
  icon: string;
  iconBg: string;
  title: string;
  value: string;
  subtitle?: string;
  delay: number;
}) {
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(400)}
      className={"bg-white/10 rounded-2xl p-4 flex-row items-center gap-4"}
    >
      <View className={`w-12 h-12 rounded-full items-center justify-center ${iconBg}`}>
        <ThemedText variant={"title2"}>{icon}</ThemedText>
      </View>
      <View className={"flex-1"}>
        <ThemedText variant={"footnote"} className={"text-white/60"}>
          {title}
        </ThemedText>
        <ThemedText variant={"body"} className={"text-white font-semibold"} numberOfLines={1}>
          {value}
        </ThemedText>
        {subtitle && (
          <ThemedText variant={"footnote"} className={"text-amber-300"}>
            {subtitle}
          </ThemedText>
        )}
      </View>
    </Animated.View>
  );
}

function WrappedContent({ stats }: { stats: WrappedStats }) {
  const hasYearlyData = stats.yearlyStats.length > 0;
  const hasMichelinData = stats.michelinStats.totalStarredVisits > 0;
  const hasCuisineData = stats.topCuisines.length > 0;

  return (
    <View className={"gap-8"}>
      {/* Hero Stats */}
      <Animated.View entering={FadeIn.delay(100).duration(500)} className={"gap-4"}>
        <View className={"flex-row gap-4"}>
          <StatPill icon={"🍽️"} value={stats.totalConfirmedVisits} label={"Total Visits"} delay={100} />
          <StatPill icon={"🏠"} value={stats.totalUniqueRestaurants} label={"Restaurants"} delay={200} />
        </View>
        {stats.averageVisitsPerMonth > 0 && (
          <View className={"flex-row gap-4"}>
            <StatPill icon={"📅"} value={stats.averageVisitsPerMonth} label={"Per Month"} delay={300} />
            <View className={"flex-1"} />
          </View>
        )}
      </Animated.View>

      {/* Michelin Stars */}
      {hasMichelinData && <StarBreakdown stats={stats.michelinStats} />}

      {/* Yearly Breakdown */}
      {hasYearlyData && (
        <View className={"gap-4"}>
          <ThemedText variant={"title2"} className={"text-white font-bold"}>
            📊 Year by Year
          </ThemedText>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 16 }}>
            {stats.yearlyStats.map((yearData, index) => (
              <YearlyHighlight key={yearData.year} yearData={yearData} index={index} />
            ))}
          </ScrollView>
        </View>
      )}

      {/* Cuisine Breakdown */}
      {hasCuisineData && <CuisineCloud cuisines={stats.topCuisines} />}

      {/* Fun Facts */}
      <View className={"gap-4"}>
        <ThemedText variant={"title2"} className={"text-white font-bold"}>
          ✨ Fun Facts
        </ThemedText>
        <View className={"gap-3"}>
          {stats.busiestMonth && (
            <FunFactCard
              icon={"🔥"}
              iconBg={"bg-rose-500/30"}
              title={"Busiest Month"}
              value={`${MONTH_NAMES[stats.busiestMonth.month - 1]} ${stats.busiestMonth.year}`}
              subtitle={`${stats.busiestMonth.visits.toLocaleString()} visits`}
              delay={800}
            />
          )}

          {stats.busiestDayOfWeek && (
            <FunFactCard
              icon={"📆"}
              iconBg={"bg-blue-500/30"}
              title={"Favorite Day"}
              value={DAY_NAMES[stats.busiestDayOfWeek.day]}
              subtitle={`${stats.busiestDayOfWeek.visits.toLocaleString()} visits`}
              delay={900}
            />
          )}

          {stats.mostRevisitedRestaurant && (
            <FunFactCard
              icon={"💜"}
              iconBg={"bg-purple-500/30"}
              title={"Your Favorite Spot"}
              value={stats.mostRevisitedRestaurant.name}
              subtitle={`${stats.mostRevisitedRestaurant.visits.toLocaleString()} visits`}
              delay={1000}
            />
          )}

          {stats.longestStreak && stats.longestStreak.days >= 2 && (
            <FunFactCard
              icon={"🔥"}
              iconBg={"bg-green-500/30"}
              title={"Longest Streak"}
              value={`${stats.longestStreak.days.toLocaleString()} consecutive days`}
              subtitle={`${formatDateShort(stats.longestStreak.startDate)} - ${formatDateShort(stats.longestStreak.endDate)}`}
              delay={1100}
            />
          )}

          {stats.firstVisitDate && (
            <FunFactCard
              icon={"🌟"}
              iconBg={"bg-amber-500/30"}
              title={"Foodie Journey Started"}
              value={new Date(stats.firstVisitDate).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              delay={1200}
            />
          )}
        </View>
      </View>
    </View>
  );
}

function EmptyState() {
  return (
    <View className={"flex-1 items-center justify-center gap-6 px-8"}>
      <View className={"w-24 h-24 rounded-full bg-white/10 items-center justify-center"}>
        <ThemedText variant={"largeTitle"}>🍽️</ThemedText>
      </View>
      <View className={"gap-2 items-center"}>
        <ThemedText variant={"title2"} className={"text-white font-bold text-center"}>
          No Dining Data Yet
        </ThemedText>
        <ThemedText variant={"body"} className={"text-white/60 text-center"}>
          Start confirming restaurant visits to see your personalized dining wrapped!
        </ThemedText>
      </View>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.back();
        }}
        className={"bg-white/20 rounded-full px-6 py-3 mt-4"}
      >
        <ThemedText variant={"body"} className={"text-white font-semibold"}>
          Go Back
        </ThemedText>
      </Pressable>
    </View>
  );
}

export default function WrappedScreen() {
  const insets = useSafeAreaInsets();
  const { data: stats, isLoading } = useWrappedStats();

  const hasData = stats && stats.totalConfirmedVisits > 0;
  const showConfetti = Boolean(hasData && !isLoading);

  // Haptic feedback when wrapped loads
  useEffect(() => {
    if (showConfetti) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [showConfetti]);

  return (
    <View style={{ flex: 1 }}>
      <LinearGradient
        colors={["#0f0f23", "#1a1a2e", "#16213e", "#0f3460"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />

      {/* Confetti celebration */}
      <Confetti enabled={showConfetti} />

      {/* Decorative background elements */}
      <View className={"absolute top-0 right-0 w-64 h-64 opacity-5"}>
        <View className={"absolute top-20 right-8 w-40 h-40 rounded-full bg-amber-400"} />
        <View className={"absolute top-40 right-24 w-24 h-24 rounded-full bg-orange-500"} />
      </View>
      <View className={"absolute bottom-0 left-0 w-48 h-48 opacity-5"}>
        <View className={"absolute bottom-20 left-8 w-32 h-32 rounded-full bg-purple-500"} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 20,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(500)} className={"gap-2 mb-8"}>
          <ThemedText variant={"caption1"} className={"text-amber-400 uppercase tracking-widest font-bold"}>
            ✨ Your Dining Year
          </ThemedText>
          <ThemedText variant={"largeTitle"} className={"text-white font-bold"}>
            Wrapped
          </ThemedText>
          <ThemedText variant={"body"} className={"text-white/60"}>
            A look back at your culinary adventures
          </ThemedText>
        </Animated.View>

        {/* Content */}
        {isLoading ? (
          <View className={"flex-1 items-center justify-center"}>
            <ThemedText variant={"body"} className={"text-white/60"}>
              Loading your stats...
            </ThemedText>
          </View>
        ) : hasData ? (
          <WrappedContent stats={stats} />
        ) : (
          <EmptyState />
        )}
      </ScrollView>
    </View>
  );
}
