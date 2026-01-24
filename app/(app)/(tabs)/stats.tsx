import React, { useEffect, useMemo, useState } from "react";
import { View, ScrollView, Pressable } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { FadeIn, FadeInDown, FadeInUp } from "react-native-reanimated";
import { ThemedText } from "@/components/themed-text";
import { useWrappedStats, type WrappedStats } from "@/hooks/queries";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { logWrappedViewed } from "@/services/analytics";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SEASON_DEFS = [
  { key: "Winter", months: [12, 1, 2], emoji: "❄️", color: "bg-sky-400", text: "text-sky-300" },
  { key: "Spring", months: [3, 4, 5], emoji: "🌸", color: "bg-emerald-400", text: "text-emerald-300" },
  { key: "Summer", months: [6, 7, 8], emoji: "☀️", color: "bg-amber-400", text: "text-amber-300" },
  { key: "Fall", months: [9, 10, 11], emoji: "🍂", color: "bg-orange-400", text: "text-orange-300" },
];

function formatDateShort(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatNumber(value: number, decimals = 1): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const formatted = value.toFixed(decimals);
  return formatted.replace(/\.0$/, "");
}

function formatPercent(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return `${(value * 100).toFixed(decimals)}%`;
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
        className={`px-4 py-2 rounded-full mr-2 border ${
          isActive ? "bg-amber-400/90 border-amber-300/60" : "bg-white/5 border-white/10"
        }`}
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
      <SectionHeading title={"Monthly Visits"} icon={"📈"} accentClass={"bg-amber-400"} />
      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4"}>
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

function SeasonalitySection({ monthlyVisits }: { monthlyVisits: WrappedStats["monthlyVisits"] }) {
  if (monthlyVisits.length === 0) {
    return null;
  }

  const seasonTotals = SEASON_DEFS.map((season) => {
    const visits = monthlyVisits.reduce((sum, month) => {
      return season.months.includes(month.month) ? sum + month.visits : sum;
    }, 0);
    return { ...season, visits };
  });

  const totalVisits = seasonTotals.reduce((sum, season) => sum + season.visits, 0);
  if (totalVisits === 0) {
    return null;
  }

  const maxVisits = Math.max(...seasonTotals.map((season) => season.visits), 1);
  const topSeason = seasonTotals.reduce((max, season) => (season.visits > max.visits ? season : max), seasonTotals[0]);

  return (
    <Animated.View entering={FadeInDown.delay(360).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Seasonal Rhythm"} icon={"🍂"} accentClass={"bg-orange-400"} />
      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4 gap-4"}>
        <View className={"flex-row items-center justify-between"}>
          <ThemedText variant={"footnote"} className={"text-white/60"}>
            Peak season
          </ThemedText>
          <ThemedText variant={"subhead"} className={`font-semibold ${topSeason.text}`}>
            {topSeason.key} · {Math.round((topSeason.visits / totalVisits) * 100)}%
          </ThemedText>
        </View>
        <View className={"gap-3"}>
          {seasonTotals.map((season, index) => {
            const percent = Math.round((season.visits / totalVisits) * 100);
            const widthPercent = (season.visits / maxVisits) * 100;
            return (
              <Animated.View
                key={season.key}
                entering={FadeIn.delay(420 + index * 80).duration(300)}
                className={"gap-2"}
              >
                <View className={"flex-row items-center justify-between"}>
                  <View className={"flex-row items-center gap-2"}>
                    <View className={`w-8 h-8 rounded-full items-center justify-center ${season.color}/20`}>
                      <ThemedText variant={"footnote"}>{season.emoji}</ThemedText>
                    </View>
                    <ThemedText variant={"subhead"} className={"text-white font-medium"}>
                      {season.key}
                    </ThemedText>
                  </View>
                  <ThemedText variant={"footnote"} className={season.text}>
                    {percent}% · {season.visits.toLocaleString()}
                  </ThemedText>
                </View>
                <View className={"h-2 bg-white/10 rounded-full overflow-hidden"}>
                  <View className={`h-full ${season.color}`} style={{ width: `${widthPercent}%` }} />
                </View>
              </Animated.View>
            );
          })}
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
        <View className={"w-10 h-10 rounded-full bg-white/10 items-center justify-center border border-white/10"}>
          <ThemedText style={{ fontSize: 20 }}>{icon}</ThemedText>
        </View>
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

function InsightCard({
  icon,
  label,
  value,
  subtitle,
  iconBg,
  valueClass,
  delay = 0,
}: {
  icon: string;
  label: string;
  value: string;
  subtitle?: string;
  iconBg: string;
  valueClass?: string;
  delay?: number;
}) {
  return (
    <Animated.View
      entering={FadeInUp.delay(delay).duration(300)}
      className={"flex-1 bg-white/5 border border-white/10 rounded-2xl p-3 gap-2"}
    >
      <View className={"flex-row items-center gap-2"}>
        <View className={`w-8 h-8 rounded-full items-center justify-center ${iconBg}`}>
          <ThemedText variant={"footnote"}>{icon}</ThemedText>
        </View>
        <ThemedText variant={"caption2"} className={"text-white/60 flex-1"} numberOfLines={1}>
          {label}
        </ThemedText>
      </View>
      <ThemedText variant={"title3"} className={`font-semibold ${valueClass ?? "text-white"}`} numberOfLines={1}>
        {value}
      </ThemedText>
      {subtitle && (
        <ThemedText variant={"caption2"} className={"text-white/50"} numberOfLines={1}>
          {subtitle}
        </ThemedText>
      )}
    </Animated.View>
  );
}

function DeepDiveSection({ stats, selectedYear }: { stats: WrappedStats; selectedYear: number | null }) {
  const insights = useMemo(() => {
    const totalVisits = stats.totalConfirmedVisits;
    const uniqueRestaurants = stats.totalUniqueRestaurants;
    const starVisits = stats.michelinStats.threeStars + stats.michelinStats.twoStars + stats.michelinStats.oneStars;
    const activeMonths = stats.monthlyVisits.filter((m) => m.visits > 0).length;
    const restaurantsPerCity = stats.uniqueCities > 0 ? uniqueRestaurants / stats.uniqueCities : 0;
    const topSpotShare =
      stats.mostRevisitedRestaurant && totalVisits > 0 ? stats.mostRevisitedRestaurant.visits / totalVisits : 0;

    return [
      {
        key: "avg-visits",
        icon: "🍽️",
        label: "Avg visits per spot",
        value: formatNumber(uniqueRestaurants > 0 ? totalVisits / uniqueRestaurants : 0, 1),
        subtitle: `${uniqueRestaurants.toLocaleString()} restaurants`,
        iconBg: "bg-amber-500/30",
        valueClass: "text-amber-300",
        isVisible: totalVisits > 0 && uniqueRestaurants > 0,
      },
      {
        key: "revisit-rate",
        icon: "🔁",
        label: "Revisit rate",
        value: formatPercent(totalVisits > 0 ? stats.diningStyle.returningVisits / totalVisits : 0),
        subtitle: `${stats.diningStyle.returningVisits.toLocaleString()} visits to favorites`,
        iconBg: "bg-rose-500/30",
        valueClass: "text-rose-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "discovery-rate",
        icon: "🧭",
        label: "Discovery rate",
        value: formatPercent(totalVisits > 0 ? uniqueRestaurants / totalVisits : 0),
        subtitle: `${uniqueRestaurants.toLocaleString()} new spots`,
        iconBg: "bg-violet-500/30",
        valueClass: "text-violet-300",
        isVisible: totalVisits > 0 && uniqueRestaurants > 0,
      },
      {
        key: "michelin-share",
        icon: "⭐",
        label: "Michelin Guide share",
        value: formatPercent(totalVisits > 0 ? stats.michelinStats.totalStarredVisits / totalVisits : 0),
        subtitle: `${stats.michelinStats.totalStarredVisits.toLocaleString()} guide visits`,
        iconBg: "bg-amber-500/25",
        valueClass: "text-amber-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "avg-stars",
        icon: "✨",
        label: "Avg star rating",
        value: formatNumber(starVisits > 0 ? stats.michelinStats.totalAccumulatedStars / starVisits : 0, 1),
        subtitle: `${starVisits.toLocaleString()} starred visits`,
        iconBg: "bg-yellow-500/30",
        valueClass: "text-yellow-300",
        isVisible: starVisits > 0,
      },
      {
        key: "photos-per-visit",
        icon: "📸",
        label: "Photos per visit",
        value: formatNumber(totalVisits > 0 ? stats.photoStats.totalPhotos / totalVisits : 0, 1),
        subtitle: `${stats.photoStats.totalPhotos.toLocaleString()} photos`,
        iconBg: "bg-cyan-500/30",
        valueClass: "text-cyan-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "top-spot-share",
        icon: "💜",
        label: "Top spot share",
        value: formatPercent(topSpotShare),
        subtitle: stats.mostRevisitedRestaurant?.name,
        iconBg: "bg-purple-500/30",
        valueClass: "text-purple-300",
        isVisible: Boolean(stats.mostRevisitedRestaurant),
      },
      {
        key: "active-months",
        icon: "📆",
        label: "Active months",
        value: activeMonths.toLocaleString(),
        subtitle: selectedYear ? `months with dining in ${selectedYear}` : "months with dining",
        iconBg: "bg-blue-500/30",
        valueClass: "text-blue-300",
        isVisible: activeMonths > 0,
      },
      {
        key: "restaurants-per-city",
        icon: "🌆",
        label: "Restaurants per city",
        value: formatNumber(restaurantsPerCity, 1),
        subtitle: `${stats.uniqueCities.toLocaleString()} cities`,
        iconBg: "bg-emerald-500/30",
        valueClass: "text-emerald-300",
        isVisible: stats.uniqueCities > 0 && uniqueRestaurants > 0,
      },
    ].filter((item) => item.isVisible);
  }, [stats, selectedYear]);

  if (insights.length === 0) {
    return null;
  }

  const insightRows: Array<(typeof insights)[number][]> = [];
  for (let i = 0; i < insights.length; i += 2) {
    insightRows.push(insights.slice(i, i + 2));
  }

  return (
    <Animated.View entering={FadeInDown.delay(240).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Deep Dive"} icon={"🔎"} accentClass={"bg-amber-300"} />
      <View className={"gap-3"}>
        {insightRows.map((row, rowIndex) => (
          <View key={`insight-row-${rowIndex}`} className={"flex-row gap-3"}>
            {row.map((item, index) => (
              <InsightCard
                key={item.key}
                icon={item.icon}
                label={item.label}
                value={item.value}
                subtitle={item.subtitle}
                iconBg={item.iconBg}
                valueClass={item.valueClass}
                delay={280 + (rowIndex * 2 + index) * 40}
              />
            ))}
            {row.length === 1 && <View className={"flex-1"} />}
          </View>
        ))}
      </View>
    </Animated.View>
  );
}

function StarBreakdown({ stats }: { stats: WrappedStats["michelinStats"] }) {
  const items = [
    {
      emoji: "⭐⭐⭐",
      label: "3 Stars",
      visits: stats.threeStars,
      unique: stats.distinctThreeStars,
    },
    {
      emoji: "⭐⭐",
      label: "2 Stars",
      visits: stats.twoStars,
      unique: stats.distinctTwoStars,
    },
    {
      emoji: "⭐",
      label: "1 Star",
      visits: stats.oneStars,
      unique: stats.distinctOneStars,
    },
    {
      emoji: "🍽️",
      label: "Bib Gourmand",
      visits: stats.bibGourmand,
      unique: stats.distinctBibGourmand,
    },
    {
      emoji: "🏆",
      label: "Selected",
      visits: stats.selected,
      unique: stats.distinctSelected,
    },
  ].filter((item) => item.visits > 0);

  if (items.length === 0) {
    return null;
  }

  const hasStars = stats.totalAccumulatedStars > 0;

  return (
    <Animated.View entering={FadeInDown.delay(200).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Michelin Experiences"} icon={"⭐"} accentClass={"bg-amber-400"} />

      {/* Star Summary */}
      {hasStars && (
        <Animated.View entering={FadeIn.delay(250).duration(400)} className={"rounded-2xl overflow-hidden"}>
          <LinearGradient
            colors={["rgba(251, 191, 36, 0.28)", "rgba(250, 204, 21, 0.12)", "rgba(0,0,0,0)"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{ padding: 20 }}
          >
            <View className={"flex-row items-center justify-around"}>
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
            </View>
          </LinearGradient>
        </Animated.View>
      )}

      {/* Breakdown by type */}
      <View className={"gap-3"}>
        {items.map((item, index) => (
          <Animated.View
            key={item.label}
            entering={FadeIn.delay(300 + index * 100).duration(300)}
            className={"bg-white/10 border border-white/10 rounded-xl px-4 py-3 flex-row items-center justify-between"}
          >
            <View className={"flex-row items-center gap-3"}>
              <ThemedText variant={"title3"}>{item.emoji}</ThemedText>
              <ThemedText variant={"subhead"} className={"text-white font-medium"}>
                {item.label}
              </ThemedText>
            </View>
            <View className={"flex-row items-center gap-4"}>
              <View className={"items-end"}>
                <ThemedText variant={"subhead"} className={"text-amber-400 font-semibold"}>
                  {item.unique.toLocaleString()}
                </ThemedText>
                <ThemedText variant={"caption2"} className={"text-white/50"}>
                  {item.unique === 1 ? "restaurant" : "restaurants"}
                </ThemedText>
              </View>
              <View className={"w-px h-8 bg-white/20"} />
              <View className={"items-end"}>
                <ThemedText variant={"subhead"} className={"text-white font-semibold"}>
                  {item.visits.toLocaleString()}
                </ThemedText>
                <ThemedText variant={"caption2"} className={"text-white/50"}>
                  {item.visits === 1 ? "visit" : "visits"}
                </ThemedText>
              </View>
            </View>
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
      <SectionHeading title={"Favorite Cuisines"} icon={"🍜"} accentClass={"bg-rose-400"} />
      <View className={"flex-row flex-wrap gap-3"}>
        {cuisines.map((cuisine, index) => {
          const intensity = cuisine.count / maxCount;
          const bgOpacity = 0.1 + intensity * 0.25;
          return (
            <Animated.View
              key={cuisine.cuisine}
              entering={FadeIn.delay(600 + index * 80).duration(300)}
              className={"rounded-full px-4 py-2 border border-white/10"}
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
      className={"bg-white/10 border border-white/10 rounded-2xl p-4 flex-row items-center gap-4"}
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

// Location Breakdown Component - shows top cities/countries visited
function LocationBreakdown({ locations }: { locations: WrappedStats["topLocations"] }) {
  if (locations.length === 0) {
    return null;
  }

  // Group by country and count
  const countryMap = new Map<string, number>();
  for (const loc of locations) {
    if (loc.country) {
      countryMap.set(loc.country, (countryMap.get(loc.country) ?? 0) + loc.visits);
    }
  }
  const topCountries = Array.from(countryMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const maxVisits = Math.max(...locations.map((l) => l.visits), 1);

  return (
    <Animated.View entering={FadeInDown.delay(400).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Your Dining World"} icon={"🌍"} accentClass={"bg-emerald-400"} />

      {/* Country summary row */}
      {topCountries.length > 0 && (
        <View className={"flex-row flex-wrap gap-2 mb-2"}>
          {topCountries.map(([country, visits], index) => (
            <Animated.View
              key={country}
              entering={FadeIn.delay(450 + index * 60).duration(300)}
              className={
                "bg-emerald-500/20 border border-emerald-500/30 rounded-full px-3 py-1.5 flex-row items-center gap-1.5"
              }
            >
              <ThemedText variant={"footnote"} className={"text-emerald-300 font-medium"}>
                {country}
              </ThemedText>
              <View className={"bg-emerald-500/40 rounded-full px-1.5 py-0.5"}>
                <ThemedText variant={"caption2"} className={"text-emerald-200 font-semibold"}>
                  {visits}
                </ThemedText>
              </View>
            </Animated.View>
          ))}
        </View>
      )}

      {/* Top cities list */}
      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4 gap-3"}>
        {locations.slice(0, 5).map((loc, index) => {
          const widthPercent = (loc.visits / maxVisits) * 100;
          return (
            <Animated.View
              key={loc.location}
              entering={FadeIn.delay(500 + index * 80).duration(300)}
              className={"gap-1"}
            >
              <View className={"flex-row justify-between items-center"}>
                <ThemedText variant={"subhead"} className={"text-white font-medium"} numberOfLines={1}>
                  {loc.city}
                </ThemedText>
                <ThemedText variant={"footnote"} className={"text-white/60"}>
                  {loc.visits} {loc.visits === 1 ? "visit" : "visits"}
                </ThemedText>
              </View>
              <View className={"h-2 bg-white/10 rounded-full overflow-hidden"}>
                <View className={"h-full bg-emerald-400/70 rounded-full"} style={{ width: `${widthPercent}%` }} />
              </View>
            </Animated.View>
          );
        })}
      </View>
    </Animated.View>
  );
}

function YearlyHighlights({ yearlyStats }: { yearlyStats: WrappedStats["yearlyStats"] }) {
  if (yearlyStats.length === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeInDown.delay(380).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Yearly Highlights"} icon={"🗓️"} accentClass={"bg-blue-400"} />
      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4 gap-3"}>
        {yearlyStats.map((year, index) => (
          <Animated.View
            key={year.year}
            entering={FadeIn.delay(420 + index * 80).duration(300)}
            className={"flex-row items-center justify-between gap-3"}
          >
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"text-white font-semibold"}>
                {year.year}
              </ThemedText>
              {year.topRestaurant && (
                <ThemedText variant={"caption2"} className={"text-white/50"} numberOfLines={1}>
                  Top spot: {year.topRestaurant.name} · {year.topRestaurant.visits}{" "}
                  {year.topRestaurant.visits === 1 ? "visit" : "visits"}
                </ThemedText>
              )}
            </View>
            <View className={"items-end"}>
              <ThemedText variant={"subhead"} className={"text-amber-300 font-semibold"}>
                {year.totalVisits.toLocaleString()}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-white/50"}>
                {year.uniqueRestaurants.toLocaleString()} {year.uniqueRestaurants === 1 ? "restaurant" : "restaurants"}
              </ThemedText>
            </View>
          </Animated.View>
        ))}
      </View>
    </Animated.View>
  );
}

// Dining Time Chart - shows meal time distribution
function DiningTimeChart({ mealTimes }: { mealTimes: WrappedStats["mealTimeBreakdown"] }) {
  const total = mealTimes.breakfast + mealTimes.lunch + mealTimes.dinner + mealTimes.lateNight;
  if (total === 0) {
    return null;
  }

  const segments = [
    { label: "Breakfast", count: mealTimes.breakfast, emoji: "🌅", color: "bg-orange-400" },
    { label: "Lunch", count: mealTimes.lunch, emoji: "☀️", color: "bg-yellow-400" },
    { label: "Dinner", count: mealTimes.dinner, emoji: "🌙", color: "bg-indigo-400" },
    { label: "Late Night", count: mealTimes.lateNight, emoji: "🌃", color: "bg-purple-400" },
  ].filter((s) => s.count > 0);

  // Find the dominant meal time
  const dominant = segments.reduce((max, s) => (s.count > max.count ? s : max), segments[0]);

  return (
    <Animated.View entering={FadeInDown.delay(600).duration(400)} className={"gap-4"}>
      <SectionHeading title={"When You Dine"} icon={"🕐"} accentClass={"bg-indigo-400"} />

      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4 gap-4"}>
        {/* Horizontal bar showing distribution */}
        <View className={"flex-row h-4 rounded-full overflow-hidden"}>
          {segments.map((segment, index) => {
            const percent = (segment.count / total) * 100;
            return (
              <Animated.View
                key={segment.label}
                entering={FadeIn.delay(650 + index * 100).duration(300)}
                className={`${segment.color}`}
                style={{ width: `${percent}%` }}
              />
            );
          })}
        </View>

        {/* Legend */}
        <View className={"flex-row flex-wrap gap-3"}>
          {segments.map((segment, index) => {
            const percent = Math.round((segment.count / total) * 100);
            const isDominant = segment === dominant;
            return (
              <Animated.View
                key={segment.label}
                entering={FadeIn.delay(700 + index * 80).duration(300)}
                className={`flex-row items-center gap-2 px-3 py-2 rounded-xl ${isDominant ? "bg-white/20" : "bg-white/5"}`}
              >
                <ThemedText variant={"body"}>{segment.emoji}</ThemedText>
                <View>
                  <ThemedText
                    variant={"footnote"}
                    className={isDominant ? "text-white font-semibold" : "text-white/70"}
                  >
                    {segment.label}
                  </ThemedText>
                  <ThemedText variant={"caption2"} className={"text-white/50"}>
                    {percent}% ({segment.count})
                  </ThemedText>
                </View>
              </Animated.View>
            );
          })}
        </View>
      </View>
    </Animated.View>
  );
}

// Weekend vs Weekday Chart
function WeekendWeekdayChart({ weekendVsWeekday }: { weekendVsWeekday: WrappedStats["weekendVsWeekday"] }) {
  const total = weekendVsWeekday.weekend + weekendVsWeekday.weekday;
  if (total === 0) {
    return null;
  }

  const weekendPercent = Math.round((weekendVsWeekday.weekend / total) * 100);
  const weekdayPercent = 100 - weekendPercent;

  return (
    <Animated.View entering={FadeInDown.delay(700).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Weekend vs Weekday"} icon={"📅"} accentClass={"bg-sky-400"} />

      <View className={"bg-white/5 border border-white/10 rounded-2xl p-4"}>
        <View className={"flex-row items-center gap-4"}>
          {/* Weekday */}
          <View className={"flex-1 items-center gap-2"}>
            <View
              className={
                "w-16 h-16 rounded-full bg-blue-500/20 items-center justify-center border-2 border-blue-400/50"
              }
            >
              <ThemedText variant={"title2"} className={"text-blue-300 font-bold"}>
                {weekdayPercent}%
              </ThemedText>
            </View>
            <ThemedText variant={"footnote"} className={"text-white/70"}>
              Weekday
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-white/50"}>
              {weekendVsWeekday.weekday} visits
            </ThemedText>
          </View>

          {/* Divider */}
          <View className={"h-16 w-px bg-white/20"} />

          {/* Weekend */}
          <View className={"flex-1 items-center gap-2"}>
            <View
              className={
                "w-16 h-16 rounded-full bg-rose-500/20 items-center justify-center border-2 border-rose-400/50"
              }
            >
              <ThemedText variant={"title2"} className={"text-rose-300 font-bold"}>
                {weekendPercent}%
              </ThemedText>
            </View>
            <ThemedText variant={"footnote"} className={"text-white/70"}>
              Weekend
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-white/50"}>
              {weekendVsWeekday.weekend} visits
            </ThemedText>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// Photo Stats Section
function PhotoStatsSection({ photoStats }: { photoStats: WrappedStats["photoStats"] }) {
  if (photoStats.totalPhotos === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeInDown.delay(800).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Your Food Photography"} icon={"📸"} accentClass={"bg-cyan-400"} />

      <View className={"flex-row gap-3"}>
        {/* Total Photos */}
        <View className={"flex-1 bg-white/5 border border-white/10 rounded-2xl p-4 items-center gap-1"}>
          <ThemedText variant={"largeTitle"} className={"text-cyan-400 font-bold"}>
            {photoStats.totalPhotos.toLocaleString()}
          </ThemedText>
          <ThemedText variant={"footnote"} className={"text-white/60 text-center"}>
            Total Photos
          </ThemedText>
        </View>

        {/* Average Per Visit */}
        <View className={"flex-1 bg-white/5 border border-white/10 rounded-2xl p-4 items-center gap-1"}>
          <ThemedText variant={"largeTitle"} className={"text-pink-400 font-bold"}>
            {photoStats.averagePerVisit}
          </ThemedText>
          <ThemedText variant={"footnote"} className={"text-white/60 text-center"}>
            Avg Per Visit
          </ThemedText>
        </View>
      </View>

      {/* Most Photographed Visit */}
      {photoStats.mostPhotographedVisit && (
        <Animated.View
          entering={FadeIn.delay(900).duration(300)}
          className={"bg-white/10 border border-white/10 rounded-2xl p-4 flex-row items-center gap-3"}
        >
          <View className={"w-10 h-10 rounded-full bg-cyan-500/30 items-center justify-center"}>
            <ThemedText variant={"body"}>🏆</ThemedText>
          </View>
          <View className={"flex-1"}>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              Most Photographed
            </ThemedText>
            <ThemedText variant={"body"} className={"text-white font-semibold"} numberOfLines={1}>
              {photoStats.mostPhotographedVisit.restaurantName}
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-cyan-300"}>
              {photoStats.mostPhotographedVisit.photoCount} photos
            </ThemedText>
          </View>
        </Animated.View>
      )}
    </Animated.View>
  );
}

// Dining Style Card - Explorer vs Regular ratio
function DiningStyleCard({
  diningStyle,
  totalVisits,
}: {
  diningStyle: WrappedStats["diningStyle"];
  totalVisits: number;
}) {
  if (totalVisits === 0) {
    return null;
  }

  const explorerPercent = Math.round(diningStyle.explorerRatio * 100);
  const isExplorer = explorerPercent >= 60;
  const isLoyal = explorerPercent <= 40;

  let title = "Balanced Foodie";
  let emoji = "⚖️";
  let description = "You enjoy both discovering new places and returning to favorites";

  if (isExplorer) {
    title = "Adventurous Explorer";
    emoji = "🧭";
    description = "You love discovering new restaurants!";
  } else if (isLoyal) {
    title = "Loyal Regular";
    emoji = "💝";
    description = "You have your favorite spots and stick with them";
  }

  return (
    <Animated.View entering={FadeInDown.delay(900).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Your Dining Style"} icon={"🎯"} accentClass={"bg-violet-400"} />

      <View className={"bg-white/5 border border-white/10 rounded-2xl p-5 gap-4"}>
        {/* Title and emoji */}
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-14 h-14 rounded-full bg-violet-500/30 items-center justify-center"}>
            <ThemedText style={{ fontSize: 28 }}>{emoji}</ThemedText>
          </View>
          <View className={"flex-1"}>
            <ThemedText variant={"title3"} className={"text-violet-300 font-bold"}>
              {title}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-white/60"}>
              {description}
            </ThemedText>
          </View>
        </View>

        {/* Explorer bar */}
        <View className={"gap-2"}>
          <View className={"flex-row justify-between"}>
            <ThemedText variant={"caption1"} className={"text-white/70"}>
              New Places
            </ThemedText>
            <ThemedText variant={"caption1"} className={"text-white/70"}>
              Return Visits
            </ThemedText>
          </View>
          <View className={"h-3 bg-white/10 rounded-full overflow-hidden flex-row"}>
            <View className={"h-full bg-violet-400"} style={{ width: `${explorerPercent}%` }} />
            <View className={"h-full bg-rose-400"} style={{ width: `${100 - explorerPercent}%` }} />
          </View>
          <View className={"flex-row justify-between"}>
            <ThemedText variant={"caption2"} className={"text-violet-300"}>
              {diningStyle.newRestaurants} unique
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-rose-300"}>
              {diningStyle.returningVisits} revisits
            </ThemedText>
          </View>
        </View>
      </View>
    </Animated.View>
  );
}

// Green Star Section - Eco-conscious dining
function GreenStarSection({ greenStarVisits }: { greenStarVisits: number }) {
  if (greenStarVisits === 0) {
    return null;
  }

  return (
    <Animated.View entering={FadeInDown.delay(350).duration(400)}>
      <View className={"bg-green-500/15 border border-green-500/30 rounded-2xl p-4 flex-row items-center gap-4"}>
        <View className={"w-14 h-14 rounded-full bg-green-500/30 items-center justify-center"}>
          <ThemedText style={{ fontSize: 28 }}>🌿</ThemedText>
        </View>
        <View className={"flex-1"}>
          <ThemedText variant={"subhead"} className={"text-green-300 font-bold"}>
            Eco-Conscious Diner
          </ThemedText>
          <ThemedText variant={"footnote"} className={"text-white/70"}>
            You visited{" "}
            <ThemedText variant={"footnote"} className={"text-green-400 font-semibold"}>
              {greenStarVisits} Michelin Green Star
            </ThemedText>{" "}
            {greenStarVisits === 1 ? "restaurant" : "restaurants"}
          </ThemedText>
          <ThemedText variant={"caption2"} className={"text-white/50 mt-1"}>
            Supporting sustainable gastronomy
          </ThemedText>
        </View>
      </View>
    </Animated.View>
  );
}

const HOUR_LABELS = [
  "12 AM",
  "1 AM",
  "2 AM",
  "3 AM",
  "4 AM",
  "5 AM",
  "6 AM",
  "7 AM",
  "8 AM",
  "9 AM",
  "10 AM",
  "11 AM",
  "12 PM",
  "1 PM",
  "2 PM",
  "3 PM",
  "4 PM",
  "5 PM",
  "6 PM",
  "7 PM",
  "8 PM",
  "9 PM",
  "10 PM",
  "11 PM",
];

function SectionHeading({ title, icon, accentClass }: { title: string; icon: string; accentClass: string }) {
  return (
    <View className={"flex-row items-center gap-3"}>
      <View className={`w-1.5 h-5 rounded-full ${accentClass}`} />
      <View className={"flex-row items-center gap-2"}>
        <View className={"w-7 h-7 rounded-full bg-white/10 border border-white/10 items-center justify-center"}>
          <ThemedText variant={"footnote"}>{icon}</ThemedText>
        </View>
        <ThemedText variant={"title2"} className={"text-white font-bold"}>
          {title}
        </ThemedText>
      </View>
    </View>
  );
}

function WrappedContent({ stats, selectedYear }: { stats: WrappedStats; selectedYear: number | null }) {
  const hasMichelinData = stats.michelinStats.totalStarredVisits > 0;
  const hasCuisineData = stats.topCuisines.length > 0;
  const hasMonthlyData = stats.monthlyVisits.length > 0;
  const hasLocationData = stats.topLocations.length > 0;
  const hasPhotoData = stats.photoStats.totalPhotos > 0;
  const hasMealTimeData =
    stats.mealTimeBreakdown.breakfast +
      stats.mealTimeBreakdown.lunch +
      stats.mealTimeBreakdown.dinner +
      stats.mealTimeBreakdown.lateNight >
    0;
  const hasGreenStar = stats.michelinStats.greenStarVisits > 0;
  const hasYearlyData = stats.yearlyStats.length > 0;

  // Determine the 4th stat to show - now can include photo count or countries
  const fourthStat = useMemo(() => {
    if (stats.uniqueCountries > 1) {
      return { icon: "🌍", value: stats.uniqueCountries, label: "Countries" };
    }
    if (stats.michelinStats.totalAccumulatedStars > 0) {
      return { icon: "⭐", value: stats.michelinStats.totalAccumulatedStars, label: "Michelin Stars" };
    }
    if (stats.photoStats.totalPhotos > 0) {
      return { icon: "📸", value: stats.photoStats.totalPhotos, label: "Photos" };
    }
    if (stats.topCuisines.length > 0) {
      return { icon: "🍜", value: stats.topCuisines.length, label: "Cuisines" };
    }
    if (stats.longestStreak && stats.longestStreak.days >= 2) {
      return { icon: "🔥", value: stats.longestStreak.days, label: "Day Streak" };
    }
    return { icon: "📅", value: stats.averageVisitsPerMonth || "—", label: "Per Month" };
  }, [stats]);

  return (
    <View className={"gap-6"}>
      {/* Hero Stats - 2x2 Grid */}
      <Animated.View entering={FadeIn.delay(100).duration(500)} className={"gap-3"}>
        <View className={"flex-row gap-3"}>
          <StatCard icon={"📍"} value={stats.totalConfirmedVisits} label={"Visits"} accentColor={"amber"} delay={100} />
          <StatCard
            icon={"👨🏻‍🍳"}
            value={stats.totalUniqueRestaurants}
            label={"Restaurants"}
            accentColor={"emerald"}
            delay={150}
          />
        </View>
        <View className={"flex-row gap-3"}>
          <StatCard
            icon={"🏙️"}
            value={stats.uniqueCities > 0 ? stats.uniqueCities : "—"}
            label={"Cities"}
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

      {/* Green Star Badge - highlight eco-conscious dining early */}
      {hasGreenStar && <GreenStarSection greenStarVisits={stats.michelinStats.greenStarVisits} />}

      {/* Monthly Chart */}
      {hasMonthlyData && <MonthlyVisitsChart monthlyVisits={stats.monthlyVisits} selectedYear={selectedYear} />}

      {/* Michelin Stars */}
      {hasMichelinData && <StarBreakdown stats={stats.michelinStats} />}

      {/* Geographic Breakdown */}
      {hasLocationData && <LocationBreakdown locations={stats.topLocations} />}

      {/* Cuisine Breakdown */}
      {hasCuisineData && <CuisineCloud cuisines={stats.topCuisines} />}

      {/* Dining Time Patterns */}
      {hasMealTimeData && <DiningTimeChart mealTimes={stats.mealTimeBreakdown} />}

      {/* Weekend vs Weekday */}
      <WeekendWeekdayChart weekendVsWeekday={stats.weekendVsWeekday} />

      {/* Photo Stats */}
      {hasPhotoData && <PhotoStatsSection photoStats={stats.photoStats} />}

      {/* Seasonal Rhythm */}
      {hasMonthlyData && <SeasonalitySection monthlyVisits={stats.monthlyVisits} />}

      {/* Yearly Highlights (all-time only) */}
      {selectedYear === null && hasYearlyData && <YearlyHighlights yearlyStats={stats.yearlyStats} />}

      {/* Dining Style */}
      <DiningStyleCard diningStyle={stats.diningStyle} totalVisits={stats.totalConfirmedVisits} />

      {/* Fun Facts */}
      <View className={"gap-4"}>
        <SectionHeading title={"Fun Facts"} icon={"✨"} accentClass={"bg-amber-300"} />
        <View className={"gap-3"}>
          {stats.peakDiningHour && (
            <FunFactCard
              icon={"⏰"}
              iconBg={"bg-cyan-500/30"}
              title={"Peak Dining Hour"}
              value={HOUR_LABELS[stats.peakDiningHour.hour]}
              subtitle={`${stats.peakDiningHour.visits} visits at this time`}
              delay={700}
            />
          )}

          {stats.busiestMonth && (
            <FunFactCard
              icon={"🔥"}
              iconBg={"bg-rose-500/30"}
              title={"Busiest Month"}
              value={`${MONTH_NAMES[stats.busiestMonth.month - 1]} ${stats.busiestMonth.year}`}
              subtitle={`${stats.busiestMonth.visits.toLocaleString()} visits`}
              delay={750}
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

          {stats.topCuisines[0] && (
            <FunFactCard
              icon={"🍜"}
              iconBg={"bg-rose-500/30"}
              title={"Signature Cuisine"}
              value={stats.topCuisines[0].cuisine}
              subtitle={`${stats.topCuisines[0].count.toLocaleString()} visits`}
              delay={825}
            />
          )}

          {stats.topLocations[0] && (
            <FunFactCard
              icon={"📍"}
              iconBg={"bg-emerald-500/30"}
              title={"Top Dining City"}
              value={stats.topLocations[0].city}
              subtitle={`${stats.topLocations[0].visits.toLocaleString()} visits`}
              delay={850}
            />
          )}

          {stats.mostRevisitedRestaurant && (
            <FunFactCard
              icon={"💜"}
              iconBg={"bg-purple-500/30"}
              title={"Your Favorite Spot"}
              value={stats.mostRevisitedRestaurant.name}
              subtitle={`${stats.mostRevisitedRestaurant.visits.toLocaleString()} visits`}
              delay={875}
            />
          )}

          {stats.longestStreak && stats.longestStreak.days >= 2 && (
            <FunFactCard
              icon={"🔥"}
              iconBg={"bg-green-500/30"}
              title={"Longest Streak"}
              value={`${stats.longestStreak.days.toLocaleString()} consecutive days`}
              subtitle={`${formatDateShort(stats.longestStreak.startDate)} - ${formatDateShort(stats.longestStreak.endDate)}`}
              delay={900}
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
              delay={950}
            />
          )}
        </View>

        {/* Deep Dive Insights */}
        <DeepDiveSection stats={stats} selectedYear={selectedYear} />
      </View>
    </View>
  );
}

function EmptyState() {
  return (
    <View className={"flex-1 items-center justify-center gap-6 px-8"}>
      <View className={"w-24 h-24 rounded-full bg-white/10 border border-white/10 items-center justify-center"}>
        <ThemedText variant={"largeTitle"}>🍽️</ThemedText>
      </View>
      <View className={"gap-2 items-center"}>
        <ThemedText variant={"title2"} className={"text-white font-bold text-center"}>
          No Dining Data Yet
        </ThemedText>
        <ThemedText variant={"body"} className={"text-white/60 text-center"}>
          Start confirming restaurant visits to see your personalized dining stats!
        </ThemedText>
      </View>
      <Pressable
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push("/");
        }}
        className={"rounded-full px-6 py-3 mt-4 overflow-hidden border border-white/20 bg-white/20"}
      >
        <ThemedText variant={"body"} className={"text-white font-semibold"}>
          Go to Restaurants
        </ThemedText>
      </Pressable>
    </View>
  );
}

export default function StatsScreen() {
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

  // Track wrapped view
  useEffect(() => {
    if (hasData) {
      logWrappedViewed(selectedYear ?? new Date().getFullYear());
    }
  }, [hasData, selectedYear]);

  const headerSubtitle = selectedYear
    ? `Your ${selectedYear} culinary journey`
    : "A look back at your culinary adventures";

  return (
    <ScrollView
      className={"flex-1"}
      contentContainerStyle={{
        paddingTop: 0,
        paddingBottom: insets.bottom,
        paddingHorizontal: 16,
      }}
    >
      {/* Header */}
      <Animated.View entering={FadeInDown.duration(500)} className={"gap-3 mb-5"}>
        <View className={"flex-row items-start justify-between gap-3"}>
          <View className={"flex-1 gap-2"}>
            <ThemedText variant={"largeTitle"} className={"text-white font-bold"}>
              Stats
            </ThemedText>
            <ThemedText variant={"body"} className={"text-white/60"}>
              {headerSubtitle}
            </ThemedText>
          </View>
        </View>
      </Animated.View>
      {/* Year Tabs */}
      {availableYears.length > 0 && (
        <Animated.View entering={FadeIn.delay(200).duration(400)} className={"mb-6"}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingVertical: 6 }}>
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
  );
}
