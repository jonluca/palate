import React, { useEffect, useMemo, useState } from "react";
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

// Year Tab Component
function YearTab({
  label,
  isActive,
  onPress,
  delay = 0,
}: {
  label: string;
  isActive: boolean;
  onPress: () => void;
  delay?: number;
}) {
  return (
    <Animated.View entering={FadeIn.delay(delay).duration(300)}>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        }}
        className={`px-4 py-2 rounded-full mr-2 ${isActive ? "bg-amber-500" : "bg-white/10"}`}
      >
        <ThemedText variant={"subhead"} className={`font-semibold ${isActive ? "text-gray-900" : "text-white/70"}`}>
          {label}
        </ThemedText>
      </Pressable>
    </Animated.View>
  );
}

// Monthly Chart Component
function MonthlyVisitsChart({
  monthlyVisits,
  selectedYear,
}: {
  monthlyVisits: WrappedStats["monthlyVisits"];
  selectedYear: number | null;
}) {
  // For a specific year, show all 12 months for that year
  // For all-time, aggregate visits by month across all years
  const chartData = useMemo(() => {
    if (monthlyVisits.length === 0) {
      return [];
    }
    if (selectedYear) {
      // Fill in all 12 months for the selected year
      return MONTH_NAMES.map((name, index) => {
        const monthData = monthlyVisits.find((m) => m.month === index + 1 && m.year === selectedYear);
        return {
          month: name,
          visits: monthData?.visits ?? 0,
        };
      });
    } else {
      // For all-time, aggregate all visits by month (Jan-Dec totals across all years)
      const monthTotals = new Map<number, number>();
      for (const m of monthlyVisits) {
        monthTotals.set(m.month, (monthTotals.get(m.month) ?? 0) + m.visits);
      }

      return MONTH_NAMES.map((name, index) => ({
        month: name,
        visits: monthTotals.get(index + 1) ?? 0,
      }));
    }
  }, [monthlyVisits, selectedYear]);

  const maxVisits = Math.max(...chartData.map((d) => d.visits), 1);

  if (chartData.length === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeInDown.delay(300).duration(400)} className={"gap-4"}>
      <ThemedText variant={"title2"} className={"text-white font-bold"}>
        📈 Monthly Visits
      </ThemedText>
      <View className={"bg-white/5 rounded-2xl p-4"}>
        {/* Value labels row */}
        <View className={"flex-row justify-between gap-1 mb-1"}>
          {chartData.map((data, index) => (
            <View key={`label-${data.month}-${index}`} className={"flex-1 items-center"}>
              <ThemedText variant={"caption2"} className={"text-white/60 text-center"} style={{ fontSize: 9 }}>
                {data.visits > 0 ? data.visits : ""}
              </ThemedText>
            </View>
          ))}
        </View>
        {/* Bars container with fixed height */}
        <View className={"flex-row items-end justify-between gap-1"} style={{ height: 100 }}>
          {chartData.map((data, index) => {
            const heightPercent = data.visits > 0 ? (data.visits / maxVisits) * 100 : 0;
            const barHeight = Math.max(heightPercent, data.visits > 0 ? 8 : 2);

            return (
              <Animated.View
                key={`bar-${data.month}-${index}`}
                entering={FadeInUp.delay(400 + index * 30).duration(300)}
                className={"flex-1 items-center justify-end h-full"}
              >
                <View
                  className={"w-full rounded-t-sm"}
                  style={{
                    height: `${barHeight}%`,
                    minHeight: data.visits > 0 ? 6 : 2,
                    backgroundColor:
                      data.visits > 0
                        ? `rgba(251, 191, 36, ${0.4 + (data.visits / maxVisits) * 0.6})`
                        : "rgba(255, 255, 255, 0.1)",
                  }}
                />
              </Animated.View>
            );
          })}
        </View>
        {/* Month labels row */}
        <View className={"flex-row justify-between gap-1 mt-1"}>
          {chartData.map((data, index) => (
            <View key={`month-${data.month}-${index}`} className={"flex-1 items-center"}>
              <ThemedText variant={"caption2"} className={"text-white/40 text-center"} style={{ fontSize: 9 }}>
                {data.month}
              </ThemedText>
            </View>
          ))}
        </View>
      </View>
    </Animated.View>
  );
}

function StatCard({
  icon,
  value,
  label,
  accentColor = "amber",
  delay = 0,
}: {
  icon: string;
  value: string | number;
  label: string;
  accentColor?: "amber" | "emerald" | "violet" | "rose";
  delay?: number;
}) {
  const accentStyles = {
    amber: {
      border: "border-amber-500/30",
      text: "text-amber-400",
      gradientColors: ["rgba(251, 191, 36, 0.35)", "rgba(251, 191, 36, 0.08)", "transparent"] as const,
    },
    emerald: {
      border: "border-emerald-500/30",
      text: "text-emerald-400",
      gradientColors: ["rgba(52, 211, 153, 0.35)", "rgba(52, 211, 153, 0.08)", "transparent"] as const,
    },
    violet: {
      border: "border-violet-500/30",
      text: "text-violet-400",
      gradientColors: ["rgba(167, 139, 250, 0.35)", "rgba(167, 139, 250, 0.08)", "transparent"] as const,
    },
    rose: {
      border: "border-rose-500/30",
      text: "text-rose-400",
      gradientColors: ["rgba(251, 113, 133, 0.35)", "rgba(251, 113, 133, 0.08)", "transparent"] as const,
    },
  };
  const accent = accentStyles[accentColor];

  return (
    <Animated.View
      entering={FadeInUp.delay(delay).duration(400)}
      className={`flex-1 rounded-2xl border ${accent.border} overflow-hidden bg-white/5`}
      style={{ minHeight: 120 }}
    >
      {/* Radial glow effect */}
      <LinearGradient
        colors={accent.gradientColors}
        locations={[0, 0.5, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={{
          position: "absolute",
          top: -20,
          left: -20,
          right: -20,
          height: 100,
          borderRadius: 60,
        }}
      />
      <View className={"flex-1 items-center justify-center p-4 gap-1"}>
        <ThemedText style={{ fontSize: 28 }}>{icon}</ThemedText>
        <ThemedText variant={"title1"} className={`font-bold ${accent.text}`}>
          {typeof value === "number" ? value.toLocaleString() : value}
        </ThemedText>
        <ThemedText variant={"caption1"} className={"text-white/50 text-center"}>
          {label}
        </ThemedText>
      </View>
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
              Total Stars
            </ThemedText>
          </View>
          <View className={"w-px h-12 bg-white/20"} />
          <View className={"items-center"}>
            <ThemedText variant={"largeTitle"} className={"text-amber-400 font-bold"}>
              {stats.distinctStars.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              Distinct Stars
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

function CuisineCloud({ cuisines }: { cuisines: WrappedStats["topCuisines"] }) {
  if (cuisines.length === 0) {
    return null;
  }

  const maxCount = Math.max(...cuisines.map((c) => c.count));

  return (
    <Animated.View entering={FadeInDown.delay(500).duration(400)} className={"gap-4"}>
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
              entering={FadeIn.delay(600 + index * 80).duration(300)}
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

function WrappedContent({ stats, selectedYear }: { stats: WrappedStats; selectedYear: number | null }) {
  const hasMichelinData = stats.michelinStats.totalStarredVisits > 0;
  const hasCuisineData = stats.topCuisines.length > 0;
  const hasMonthlyData = stats.monthlyVisits.length > 0;

  // Determine the 4th stat to show
  const fourthStat = useMemo(() => {
    if (stats.michelinStats.totalAccumulatedStars > 0) {
      return { icon: "⭐", value: stats.michelinStats.totalAccumulatedStars, label: "Michelin Stars" };
    }
    if (stats.topCuisines.length > 0) {
      return { icon: "🍜", value: stats.topCuisines.length, label: "Cuisines" };
    }
    if (stats.longestStreak && stats.longestStreak.days >= 2) {
      return { icon: "🔥", value: stats.longestStreak.days, label: "Day Streak" };
    }
    return { icon: "📸", value: "—", label: "Photos" };
  }, [stats]);

  return (
    <View className={"gap-8"}>
      {/* Hero Stats - 2x2 Grid */}
      <Animated.View entering={FadeIn.delay(100).duration(500)} className={"gap-3"}>
        <View className={"flex-row gap-3"}>
          <StatCard icon={"🍽️"} value={stats.totalConfirmedVisits} label={"Visits"} accentColor={"amber"} delay={100} />
          <StatCard
            icon={"🏠"}
            value={stats.totalUniqueRestaurants}
            label={"Restaurants"}
            accentColor={"emerald"}
            delay={150}
          />
        </View>
        <View className={"flex-row gap-3"}>
          <StatCard
            icon={"📅"}
            value={stats.averageVisitsPerMonth > 0 ? stats.averageVisitsPerMonth : "—"}
            label={"Per Month"}
            accentColor={"violet"}
            delay={200}
          />
          <StatCard
            icon={fourthStat.icon}
            value={fourthStat.value}
            label={fourthStat.label}
            accentColor={"rose"}
            delay={250}
          />
        </View>
      </Animated.View>

      {/* Monthly Chart */}
      {hasMonthlyData && <MonthlyVisitsChart monthlyVisits={stats.monthlyVisits} selectedYear={selectedYear} />}

      {/* Michelin Stars */}
      {hasMichelinData && <StarBreakdown stats={stats.michelinStats} />}

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
              delay={700}
            />
          )}

          {stats.busiestDayOfWeek && (
            <FunFactCard
              icon={"📆"}
              iconBg={"bg-blue-500/30"}
              title={"Favorite Day"}
              value={DAY_NAMES[stats.busiestDayOfWeek.day]}
              subtitle={`${stats.busiestDayOfWeek.visits.toLocaleString()} visits`}
              delay={800}
            />
          )}

          {stats.mostRevisitedRestaurant && (
            <FunFactCard
              icon={"💜"}
              iconBg={"bg-purple-500/30"}
              title={"Your Favorite Spot"}
              value={stats.mostRevisitedRestaurant.name}
              subtitle={`${stats.mostRevisitedRestaurant.visits.toLocaleString()} visits`}
              delay={900}
            />
          )}

          {stats.longestStreak && stats.longestStreak.days >= 2 && (
            <FunFactCard
              icon={"🔥"}
              iconBg={"bg-green-500/30"}
              title={"Longest Streak"}
              value={`${stats.longestStreak.days.toLocaleString()} consecutive days`}
              subtitle={`${formatDateShort(stats.longestStreak.startDate)} - ${formatDateShort(stats.longestStreak.endDate)}`}
              delay={1000}
            />
          )}

          {stats.firstVisitDate && (
            <FunFactCard
              icon={"🌟"}
              iconBg={"bg-amber-500/30"}
              title={selectedYear ? "First Visit This Year" : "Foodie Journey Started"}
              value={new Date(stats.firstVisitDate).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
                year: "numeric",
              })}
              delay={1100}
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
  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  // Fetch all-time stats to get available years
  const { data: allTimeStats, isLoading: isLoadingAllTime } = useWrappedStats(null);

  // Fetch stats for selected year (or all-time if null)
  const { data: stats, isLoading: isLoadingYearStats } = useWrappedStats(selectedYear);

  const isLoading = isLoadingAllTime || isLoadingYearStats;
  const availableYears = allTimeStats?.availableYears ?? [];

  const hasData = stats && stats.totalConfirmedVisits > 0;
  const showConfetti = Boolean(hasData && !isLoading);

  // Haptic feedback when wrapped loads
  useEffect(() => {
    if (showConfetti) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  }, [showConfetti]);

  const headerSubtitle = selectedYear
    ? `Your ${selectedYear} culinary journey`
    : "A look back at your culinary adventures";

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
          paddingTop: 16,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 20,
          flexGrow: 1,
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(500)} className={"gap-2 mb-4"}>
          <ThemedText variant={"caption1"} className={"text-amber-400 uppercase tracking-widest font-bold"}>
            ✨ Your Dining Years
          </ThemedText>
          <ThemedText variant={"largeTitle"} className={"text-white font-bold"}>
            Wrapped
          </ThemedText>
          <ThemedText variant={"body"} className={"text-white/60"}>
            {headerSubtitle}
          </ThemedText>
        </Animated.View>

        {/* Year Tabs */}
        {availableYears.length > 0 && (
          <Animated.View entering={FadeIn.delay(200).duration(400)} className={"mb-6"}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 8 }}
            >
              <YearTab
                label={"All Time"}
                isActive={selectedYear === null}
                onPress={() => setSelectedYear(null)}
                delay={100}
              />
              {availableYears.map((year, index) => (
                <YearTab
                  key={year}
                  label={String(year)}
                  isActive={selectedYear === year}
                  onPress={() => setSelectedYear(year)}
                  delay={150 + index * 50}
                />
              ))}
            </ScrollView>
          </Animated.View>
        )}

        {/* Content */}
        {isLoading ? (
          <View className={"flex-1 items-center justify-center"}>
            <ThemedText variant={"body"} className={"text-white/60"}>
              Loading your stats...
            </ThemedText>
          </View>
        ) : hasData ? (
          <WrappedContent stats={stats} selectedYear={selectedYear} />
        ) : (
          <EmptyState />
        )}
      </ScrollView>
    </View>
  );
}
