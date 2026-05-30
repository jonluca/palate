import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  ScrollView,
  Pressable,
  Platform,
  Modal,
  Alert,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { AppleMaps, GoogleMaps } from "expo-maps";
import Animated, { FadeIn, FadeInDown, FadeInUp } from "react-native-reanimated";
import { Host, Picker } from "@expo/ui";
import SegmentedControl from "@expo/ui/community/segmented-control";
import { IconSymbol, type IconSymbolName } from "@/components/icon-symbol";
import { ThemedText } from "@/components/themed-text";
import { NativeStatsButton } from "@/components/stats/native-stats-button";
import {
  useMichelinStatsBucketRestaurants,
  useWrappedStats,
  type MichelinStatsBucket,
  type WrappedStats,
} from "@/hooks/queries";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import { makeImageFromView, ImageFormat } from "@shopify/react-native-skia";
import { logWrappedViewed } from "@/services/analytics";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SEASON_DEFS = [
  { key: "Winter", months: [12, 1, 2], symbol: "snowflake", color: "bg-sky-400", text: "text-sky-300" },
  { key: "Spring", months: [3, 4, 5], symbol: "camera.macro", color: "bg-emerald-400", text: "text-emerald-300" },
  { key: "Summer", months: [6, 7, 8], symbol: "sun.max.fill", color: "bg-amber-400", text: "text-amber-300" },
  { key: "Fall", months: [9, 10, 11], symbol: "leaf.fill", color: "bg-orange-400", text: "text-orange-300" },
];

interface MichelinBreakdownItem {
  bucket: MichelinStatsBucket;
  symbol: IconSymbolName;
  label: string;
  visits: number;
  unique: number;
}

const MICHELIN_BREAKDOWN_META: Array<Pick<MichelinBreakdownItem, "bucket" | "symbol" | "label">> = [
  { bucket: "three-stars", symbol: "star.fill", label: "3 Stars" },
  { bucket: "two-stars", symbol: "star.fill", label: "2 Stars" },
  { bucket: "one-star", symbol: "star.fill", label: "1 Star" },
  { bucket: "bib-gourmand", symbol: "fork.knife", label: "Bib Gourmand" },
  { bucket: "selected", symbol: "checkmark.seal.fill", label: "Selected" },
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

function getFourthStat(stats: WrappedStats) {
  if (stats.uniqueCountries > 1) {
    return { icon: "globe.americas.fill" as const, value: stats.uniqueCountries, label: "Countries" };
  }
  if (stats.michelinStats.totalAccumulatedStars > 0) {
    return { icon: "star.fill" as const, value: stats.michelinStats.totalAccumulatedStars, label: "Michelin Stars" };
  }
  if (stats.photoStats.totalPhotos > 0) {
    return { icon: "camera.fill" as const, value: stats.photoStats.totalPhotos, label: "Photos" };
  }
  if (stats.topCuisines.length > 0) {
    return { icon: "fork.knife" as const, value: stats.topCuisines.length, label: "Cuisines" };
  }
  if (stats.longestStreak && stats.longestStreak.days >= 2) {
    return { icon: "flame.fill" as const, value: stats.longestStreak.days, label: "Day Streak" };
  }
  return { icon: "calendar" as const, value: stats.averageVisitsPerMonth || "—", label: "Per Month" };
}

function getMapZoomForSpan(span: number): number {
  if (span > 100) {
    return 1.5;
  }
  if (span > 60) {
    return 2.2;
  }
  if (span > 30) {
    return 3;
  }
  if (span > 15) {
    return 4;
  }
  if (span > 8) {
    return 5;
  }
  if (span > 4) {
    return 6;
  }
  if (span > 2) {
    return 7;
  }
  if (span > 1) {
    return 8;
  }
  if (span > 0.5) {
    return 9;
  }
  if (span > 0.2) {
    return 10;
  }
  return 11.5;
}

function getMapCameraPosition(points: WrappedStats["mapPoints"]) {
  if (points.length === 0) {
    return undefined;
  }

  const totalWeight = points.reduce((sum, point) => sum + Math.max(point.visits, 1), 0);
  const centerLat =
    totalWeight > 0
      ? points.reduce((sum, point) => sum + point.latitude * Math.max(point.visits, 1), 0) / totalWeight
      : points.reduce((sum, point) => sum + point.latitude, 0) / points.length;
  const centerLon =
    totalWeight > 0
      ? points.reduce((sum, point) => sum + point.longitude * Math.max(point.visits, 1), 0) / totalWeight
      : points.reduce((sum, point) => sum + point.longitude, 0) / points.length;

  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const latSpan = Math.max(...latitudes) - Math.min(...latitudes);
  const lonSpan = Math.max(...longitudes) - Math.min(...longitudes);
  const span = Math.max(latSpan, lonSpan);
  const zoom = points.length === 1 ? 12 : getMapZoomForSpan(span);

  return {
    coordinates: {
      latitude: centerLat,
      longitude: centerLon,
    },
    zoom,
  };
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
      <SectionHeading title={"Monthly Visits"} icon={"chart.bar.fill"} accentClass={"bg-amber-400"} />
      <View className={"border-y border-white/15 py-4"}>
        {/* Value labels row */}
        <View className={"flex-row justify-between gap-1 mb-1"}>
          {chartData.map((data) => (
            <View key={`label-${data.month}`} className={"flex-1 items-center"}>
              <ThemedText variant={"caption2"} className={"text-muted-foreground text-center"}>
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
                key={`bar-${data.month}`}
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
          {chartData.map((data) => (
            <View key={`month-${data.month}`} className={"flex-1 items-center"}>
              <ThemedText variant={"caption2"} className={"text-muted-foreground/60 text-center"}>
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
      <SectionHeading title={"Seasonal Rhythm"} icon={"leaf.fill"} accentClass={"bg-orange-400"} />
      <View className={"border-y border-white/15 py-4 gap-4"}>
        <View className={"flex-row items-center justify-between"}>
          <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
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
                      <IconSymbol name={season.symbol as IconSymbolName} size={14} color={"#e5e7eb"} />
                    </View>
                    <ThemedText variant={"subhead"} className={"text-foreground font-medium"}>
                      {season.key}
                    </ThemedText>
                  </View>
                  <ThemedText variant={"footnote"} className={season.text}>
                    {percent}% · {season.visits.toLocaleString()}
                  </ThemedText>
                </View>
                <View className={"h-2 bg-secondary/70 rounded-full overflow-hidden"}>
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
  icon: IconSymbolName;
  value: string | number;
  label: string;
  accentColor?: "amber" | "emerald" | "violet" | "rose";
  delay?: number;
}) {
  const accentStyles = {
    amber: {
      cardBorder: "rgba(251, 191, 36, 0.14)",
      topTint: "rgba(251, 191, 36, 0.08)",
      halo: "rgba(251, 191, 36, 0.14)",
      iconBg: "rgba(251, 191, 36, 0.12)",
      iconBorder: "rgba(251, 191, 36, 0.2)",
      chipBg: "rgba(251, 191, 36, 0.1)",
      chipBorder: "rgba(251, 191, 36, 0.16)",
      accentText: "rgb(245, 158, 11)",
      dot: "rgb(245, 158, 11)",
      iconShadow: "rgba(245, 158, 11, 0.12)",
    },
    emerald: {
      cardBorder: "rgba(52, 211, 153, 0.14)",
      topTint: "rgba(52, 211, 153, 0.08)",
      halo: "rgba(52, 211, 153, 0.14)",
      iconBg: "rgba(52, 211, 153, 0.12)",
      iconBorder: "rgba(52, 211, 153, 0.2)",
      chipBg: "rgba(52, 211, 153, 0.1)",
      chipBorder: "rgba(52, 211, 153, 0.16)",
      accentText: "rgb(16, 185, 129)",
      dot: "rgb(16, 185, 129)",
      iconShadow: "rgba(16, 185, 129, 0.12)",
    },
    violet: {
      cardBorder: "rgba(167, 139, 250, 0.14)",
      topTint: "rgba(167, 139, 250, 0.08)",
      halo: "rgba(167, 139, 250, 0.14)",
      iconBg: "rgba(167, 139, 250, 0.12)",
      iconBorder: "rgba(167, 139, 250, 0.2)",
      chipBg: "rgba(167, 139, 250, 0.1)",
      chipBorder: "rgba(167, 139, 250, 0.16)",
      accentText: "rgb(139, 92, 246)",
      dot: "rgb(139, 92, 246)",
      iconShadow: "rgba(139, 92, 246, 0.12)",
    },
    rose: {
      cardBorder: "rgba(251, 113, 133, 0.14)",
      topTint: "rgba(251, 113, 133, 0.08)",
      halo: "rgba(251, 113, 133, 0.14)",
      iconBg: "rgba(251, 113, 133, 0.12)",
      iconBorder: "rgba(251, 113, 133, 0.2)",
      chipBg: "rgba(251, 113, 133, 0.1)",
      chipBorder: "rgba(251, 113, 133, 0.16)",
      accentText: "rgb(244, 63, 94)",
      dot: "rgb(244, 63, 94)",
      iconShadow: "rgba(244, 63, 94, 0.12)",
    },
  };
  const accent = accentStyles[accentColor];

  return (
    <Animated.View
      entering={FadeInUp.delay(delay).duration(400)}
      className={"flex-1 rounded-2xl border overflow-hidden bg-card"}
      style={{
        minHeight: 118,
        borderCurve: "continuous",
        borderColor: accent.cardBorder,
      }}
    >
      <View className={"flex-1 justify-between p-4"}>
        <View className={"flex-row items-center justify-between gap-2"}>
          <View
            className={"w-10 h-10 items-center justify-center border"}
            style={{
              borderRadius: 14,
              borderCurve: "continuous",
              backgroundColor: accent.iconBg,
              borderColor: accent.iconBorder,
            }}
          >
            <IconSymbol name={icon} size={18} color={accent.accentText} />
          </View>
          <View
            className={"flex-row items-center gap-1.5 px-2.5 py-1 border"}
            style={{
              maxWidth: "74%",
              borderRadius: 999,
              borderCurve: "continuous",
              backgroundColor: accent.chipBg,
              borderColor: accent.chipBorder,
            }}
          >
            <View className={"w-1.5 h-1.5 rounded-full"} style={{ backgroundColor: accent.dot }} />
            <ThemedText
              variant={"caption2"}
              className={"font-semibold"}
              numberOfLines={1}
              style={{ color: accent.accentText }}
            >
              {label}
            </ThemedText>
          </View>
        </View>
        <ThemedText
          variant={"title1"}
          className={"font-semibold text-foreground"}
          numberOfLines={1}
          style={{ fontVariant: ["tabular-nums"], letterSpacing: -0.3 }}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </ThemedText>
      </View>
    </Animated.View>
  );
}

function EditorialStat({
  index,
  value,
  label,
  accentClass,
}: {
  index: string;
  value: string | number;
  label: string;
  accentClass: string;
}) {
  return (
    <View className={"flex-1 min-h-24 py-3 justify-between gap-3"}>
      <ThemedText variant={"caption2"} className={`font-semibold tracking-widest ${accentClass}`}>
        {index}
      </ThemedText>
      <View className={"gap-0.5"}>
        <ThemedText
          variant={"title1"}
          className={"font-semibold text-foreground"}
          numberOfLines={1}
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {typeof value === "number" ? value.toLocaleString() : value}
        </ThemedText>
        <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-muted-foreground"}>
          {label}
        </ThemedText>
      </View>
    </View>
  );
}

function EditorialOverview({ stats }: { stats: WrappedStats }) {
  const fourthStat = getFourthStat(stats);

  return (
    <Animated.View entering={FadeInDown.delay(120).duration(420)} className={"gap-3"}>
      <View className={"flex-row items-end justify-between gap-4"}>
        <View className={"gap-1"}>
          <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-amber-300"}>
            Palate Index
          </ThemedText>
          <ThemedText variant={"title3"} className={"font-semibold text-foreground"}>
            Your dining record, distilled.
          </ThemedText>
        </View>
        <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-muted-foreground"}>
          04 signals
        </ThemedText>
      </View>
      <View className={"border-y border-white/15"}>
        <View className={"flex-row gap-4 border-b border-white/10"}>
          <EditorialStat
            index={"01"}
            value={stats.totalConfirmedVisits}
            label={"Visits"}
            accentClass={"text-amber-300"}
          />
          <View className={"w-px bg-white/10"} />
          <EditorialStat
            index={"02"}
            value={stats.totalUniqueRestaurants}
            label={"Restaurants"}
            accentClass={"text-emerald-300"}
          />
        </View>
        <View className={"flex-row gap-4"}>
          <EditorialStat
            index={"03"}
            value={stats.uniqueCities > 0 ? stats.uniqueCities : "—"}
            label={"Cities"}
            accentClass={"text-cyan-300"}
          />
          <View className={"w-px bg-white/10"} />
          <EditorialStat index={"04"} value={fourthStat.value} label={fourthStat.label} accentClass={"text-rose-300"} />
        </View>
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
  icon: IconSymbolName;
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
      className={"flex-1 border-t border-white/15 py-3 gap-2"}
    >
      <View className={"flex-row items-center gap-2"}>
        <View className={`w-8 h-8 rounded-full items-center justify-center ${iconBg}`}>
          <IconSymbol name={icon} size={14} color={"#e5e7eb"} />
        </View>
        <ThemedText variant={"caption2"} className={"text-muted-foreground flex-1"} numberOfLines={1}>
          {label}
        </ThemedText>
      </View>
      <ThemedText variant={"title3"} className={`font-semibold ${valueClass ?? "text-foreground"}`} numberOfLines={1}>
        {value}
      </ThemedText>
      {subtitle && (
        <ThemedText variant={"caption2"} className={"text-muted-foreground/80"} numberOfLines={1}>
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

    const visibleInsights = [
      {
        key: "avg-visits",
        icon: "fork.knife" as const,
        label: "Avg visits per spot",
        value: formatNumber(uniqueRestaurants > 0 ? totalVisits / uniqueRestaurants : 0, 1),
        subtitle: `${uniqueRestaurants.toLocaleString()} restaurants`,
        iconBg: "bg-amber-500/30",
        valueClass: "text-amber-300",
        isVisible: totalVisits > 0 && uniqueRestaurants > 0,
      },
      {
        key: "revisit-rate",
        icon: "arrow.triangle.2.circlepath" as const,
        label: "Revisit rate",
        value: formatPercent(totalVisits > 0 ? stats.diningStyle.returningVisits / totalVisits : 0),
        subtitle: `${stats.diningStyle.returningVisits.toLocaleString()} visits to favorites`,
        iconBg: "bg-rose-500/30",
        valueClass: "text-rose-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "discovery-rate",
        icon: "safari.fill" as const,
        label: "Discovery rate",
        value: formatPercent(totalVisits > 0 ? uniqueRestaurants / totalVisits : 0),
        subtitle: `${uniqueRestaurants.toLocaleString()} new spots`,
        iconBg: "bg-violet-500/30",
        valueClass: "text-violet-300",
        isVisible: totalVisits > 0 && uniqueRestaurants > 0,
      },
      {
        key: "michelin-share",
        icon: "star.fill" as const,
        label: "Michelin Guide share",
        value: formatPercent(totalVisits > 0 ? stats.michelinStats.totalStarredVisits / totalVisits : 0),
        subtitle: `${stats.michelinStats.totalStarredVisits.toLocaleString()} guide visits`,
        iconBg: "bg-amber-500/25",
        valueClass: "text-amber-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "avg-stars",
        icon: "sparkles" as const,
        label: "Avg star rating",
        value: formatNumber(starVisits > 0 ? stats.michelinStats.totalAccumulatedStars / starVisits : 0, 1),
        subtitle: `${starVisits.toLocaleString()} starred visits`,
        iconBg: "bg-yellow-500/30",
        valueClass: "text-yellow-300",
        isVisible: starVisits > 0,
      },
      {
        key: "photos-per-visit",
        icon: "camera.fill" as const,
        label: "Photos per visit",
        value: formatNumber(totalVisits > 0 ? stats.photoStats.totalPhotos / totalVisits : 0, 1),
        subtitle: `${stats.photoStats.totalPhotos.toLocaleString()} photos`,
        iconBg: "bg-cyan-500/30",
        valueClass: "text-cyan-300",
        isVisible: totalVisits > 0,
      },
      {
        key: "top-spot-share",
        icon: "heart.fill" as const,
        label: "Top spot share",
        value: formatPercent(topSpotShare),
        subtitle: stats.mostRevisitedRestaurant?.name,
        iconBg: "bg-purple-500/30",
        valueClass: "text-purple-300",
        isVisible: Boolean(stats.mostRevisitedRestaurant),
      },
      {
        key: "active-months",
        icon: "calendar" as const,
        label: "Active months",
        value: activeMonths.toLocaleString(),
        subtitle: selectedYear ? `months with dining in ${selectedYear}` : "months with dining",
        iconBg: "bg-blue-500/30",
        valueClass: "text-blue-300",
        isVisible: activeMonths > 0,
      },
      {
        key: "restaurants-per-city",
        icon: "building.2.fill" as const,
        label: "Restaurants per city",
        value: formatNumber(restaurantsPerCity, 1),
        subtitle: `${stats.uniqueCities.toLocaleString()} cities`,
        iconBg: "bg-emerald-500/30",
        valueClass: "text-emerald-300",
        isVisible: stats.uniqueCities > 0 && uniqueRestaurants > 0,
      },
    ].filter((item) => item.isVisible);

    if (visibleInsights.length % 2 === 1) {
      visibleInsights.push({
        key: "visits-per-active-month",
        icon: "calendar" as const,
        label: "Visits per active month",
        value: formatNumber(activeMonths > 0 ? totalVisits / activeMonths : 0, 1),
        subtitle: selectedYear
          ? `${activeMonths.toLocaleString()} active months in ${selectedYear}`
          : `${activeMonths.toLocaleString()} active months`,
        iconBg: "bg-sky-500/30",
        valueClass: "text-sky-300",
        isVisible: true,
      });
    }

    return visibleInsights;
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
      <SectionHeading title={"Deep Dive"} icon={"magnifyingglass"} accentClass={"bg-amber-300"} />
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

function StaticMichelinBreakdownRow({ item, index }: { item: MichelinBreakdownItem; index: number }) {
  return (
    <Animated.View
      entering={FadeIn.delay(300 + index * 100).duration(300)}
      className={"border-b border-white/10 py-3 flex-row items-center justify-between"}
    >
      <View className={"flex-row items-center gap-3"}>
        <IconSymbol name={item.symbol} size={17} color={"#fbbf24"} />
        <ThemedText variant={"subhead"} className={"text-foreground font-medium"}>
          {item.label}
        </ThemedText>
      </View>
      <View className={"flex-row items-center gap-4"}>
        <View className={"items-end"}>
          <ThemedText variant={"subhead"} className={"text-amber-400 font-semibold"}>
            {item.unique.toLocaleString()}
          </ThemedText>
          <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
            {item.unique === 1 ? "restaurant" : "restaurants"}
          </ThemedText>
        </View>
        <View className={"w-px h-8 bg-secondary"} />
        <View className={"items-end"}>
          <ThemedText variant={"subhead"} className={"text-foreground font-semibold"}>
            {item.visits.toLocaleString()}
          </ThemedText>
          <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
            {item.visits === 1 ? "visit" : "visits"}
          </ThemedText>
        </View>
      </View>
    </Animated.View>
  );
}

function CollapsibleMichelinBreakdownRow({
  item,
  index,
  selectedYear,
}: {
  item: MichelinBreakdownItem;
  index: number;
  selectedYear: number | null;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const {
    data: restaurants,
    isLoading,
    error,
  } = useMichelinStatsBucketRestaurants(selectedYear, item.bucket, {
    enabled: isExpanded,
    staleTime: 5 * 60 * 1000,
  });

  const toggleExpanded = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsExpanded((value) => !value);
  }, []);

  const openRestaurant = useCallback((restaurantId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/restaurant/${restaurantId}`);
  }, []);

  return (
    <Animated.View
      entering={FadeIn.delay(300 + index * 100).duration(300)}
      className={"border-b border-white/10 overflow-hidden"}
    >
      <Pressable onPress={toggleExpanded} className={"py-3"}>
        <View className={"flex-row items-center justify-between gap-3"}>
          <View className={"flex-1 flex-row items-center gap-3"}>
            <IconSymbol name={item.symbol} size={17} color={"#fbbf24"} />
            <View className={"flex-1 gap-1"}>
              <ThemedText variant={"subhead"} className={"text-foreground font-medium"}>
                {item.label}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
                {isExpanded ? "Hide restaurants" : "Show restaurants"}
              </ThemedText>
            </View>
          </View>
          <View className={"flex-row items-center gap-3"}>
            <View className={"items-end"}>
              <ThemedText variant={"subhead"} className={"text-amber-400 font-semibold"}>
                {item.unique.toLocaleString()}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
                {item.unique === 1 ? "restaurant" : "restaurants"}
              </ThemedText>
            </View>
            <View className={"w-px h-8 bg-secondary"} />
            <View className={"items-end"}>
              <ThemedText variant={"subhead"} className={"text-foreground font-semibold"}>
                {item.visits.toLocaleString()}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
                {item.visits === 1 ? "visit" : "visits"}
              </ThemedText>
            </View>
            <View className={"w-7 h-7 rounded-full border border-white/10 items-center justify-center"}>
              <IconSymbol name={isExpanded ? "chevron.up" : "chevron.down"} size={13} color={"#8E8E93"} />
            </View>
          </View>
        </View>
      </Pressable>

      {isExpanded ? (
        <Animated.View entering={FadeIn.duration(180)} className={"border-t border-white/5 pb-4 pt-3"}>
          {isLoading ? (
            <View className={"min-h-24 items-center justify-center gap-3"}>
              <ActivityIndicator color={"#f59e0b"} />
              <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
                Loading restaurants...
              </ThemedText>
            </View>
          ) : error ? (
            <View className={"min-h-24 items-center justify-center px-4"}>
              <ThemedText variant={"footnote"} className={"text-center text-muted-foreground"}>
                Couldn't load restaurants right now.
              </ThemedText>
            </View>
          ) : restaurants && restaurants.length > 0 ? (
            <ScrollView
              nestedScrollEnabled
              showsVerticalScrollIndicator={restaurants.length > 4}
              style={{ maxHeight: 260 }}
              contentContainerStyle={{ gap: 10, paddingBottom: 2 }}
            >
              {restaurants.map((restaurant) => {
                const secondaryText = [restaurant.cuisine, restaurant.location].filter(Boolean).join(" • ");

                return (
                  <Pressable
                    key={restaurant.id}
                    onPress={() => openRestaurant(restaurant.id)}
                    className={"bg-white/5 border border-white/10 rounded-xl px-3 py-3"}
                    style={{ borderCurve: "continuous" }}
                  >
                    <View className={"flex-row items-start justify-between gap-3"}>
                      <View className={"flex-1 gap-1"}>
                        <ThemedText variant={"subhead"} className={"text-foreground font-medium"} numberOfLines={2}>
                          {restaurant.name}
                        </ThemedText>
                        {secondaryText ? (
                          <ThemedText variant={"caption1"} className={"text-muted-foreground"} numberOfLines={2}>
                            {secondaryText}
                          </ThemedText>
                        ) : null}
                      </View>
                      <View className={"items-end gap-1"}>
                        <ThemedText variant={"caption1"} className={"text-amber-400 font-semibold"}>
                          {restaurant.visitCount.toLocaleString()}
                        </ThemedText>
                        <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
                          {restaurant.visitCount === 1 ? "visit" : "visits"}
                        </ThemedText>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          ) : (
            <View className={"min-h-24 items-center justify-center px-4"}>
              <ThemedText variant={"footnote"} className={"text-center text-muted-foreground"}>
                No restaurants matched this award yet.
              </ThemedText>
            </View>
          )}
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

function StarBreakdown({
  stats,
  selectedYear,
  interactive = false,
}: {
  stats: WrappedStats["michelinStats"];
  selectedYear: number | null;
  interactive?: boolean;
}) {
  const items: MichelinBreakdownItem[] = MICHELIN_BREAKDOWN_META.map((item) => {
    switch (item.bucket) {
      case "three-stars":
        return { ...item, visits: stats.threeStars, unique: stats.distinctThreeStars };
      case "two-stars":
        return { ...item, visits: stats.twoStars, unique: stats.distinctTwoStars };
      case "one-star":
        return { ...item, visits: stats.oneStars, unique: stats.distinctOneStars };
      case "bib-gourmand":
        return { ...item, visits: stats.bibGourmand, unique: stats.distinctBibGourmand };
      case "selected":
        return { ...item, visits: stats.selected, unique: stats.distinctSelected };
    }
  }).filter((item) => item.visits > 0);

  if (items.length === 0) {
    return null;
  }

  const hasStars = stats.totalAccumulatedStars > 0;

  return (
    <Animated.View entering={FadeInDown.delay(200).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Michelin Index"} icon={"star.fill"} accentClass={"bg-amber-400"} />

      {/* Star Summary */}
      <Animated.View
        entering={FadeIn.delay(250).duration(400)}
        className={"border-y border-amber-300/25 overflow-hidden"}
      >
        <LinearGradient
          colors={["rgba(251, 191, 36, 0.2)", "rgba(250, 204, 21, 0.06)", "rgba(0,0,0,0)"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ paddingHorizontal: 16, paddingVertical: 24 }}
        >
          <View className={"flex-row items-end justify-between gap-5"}>
            <View className={"flex-1 gap-1"}>
              <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-amber-300"}>
                Guide visits
              </ThemedText>
              <ThemedText
                className={"text-amber-300 font-semibold"}
                style={{ fontSize: 56, lineHeight: 60, fontVariant: ["tabular-nums"] }}
              >
                {stats.totalStarredVisits.toLocaleString()}
              </ThemedText>
            </View>
            <View className={"items-end gap-3 pb-1"}>
              {hasStars && (
                <View className={"items-end"}>
                  <ThemedText variant={"title2"} className={"text-amber-300 font-semibold"}>
                    {stats.totalAccumulatedStars.toLocaleString()}
                  </ThemedText>
                  <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-muted-foreground"}>
                    stars earned
                  </ThemedText>
                </View>
              )}
              <View className={"items-end"}>
                <ThemedText variant={"title3"} className={"text-foreground font-semibold"}>
                  {stats.distinctStarredRestaurants.toLocaleString()}
                </ThemedText>
                <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-muted-foreground"}>
                  restaurants
                </ThemedText>
              </View>
            </View>
          </View>
        </LinearGradient>
      </Animated.View>

      {/* Breakdown by type */}
      <View className={"border-t border-white/10"}>
        {items.map((item, index) =>
          interactive ? (
            <CollapsibleMichelinBreakdownRow key={item.bucket} item={item} index={index} selectedYear={selectedYear} />
          ) : (
            <StaticMichelinBreakdownRow key={item.bucket} item={item} index={index} />
          ),
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
    <Animated.View entering={FadeInDown.delay(500).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Favorite Cuisines"} icon={"fork.knife"} accentClass={"bg-rose-400"} />
      <View className={"flex-row flex-wrap gap-3"}>
        {cuisines.map((cuisine, index) => {
          const intensity = cuisine.count / maxCount;
          const bgOpacity = 0.1 + intensity * 0.25;
          return (
            <Animated.View
              key={cuisine.cuisine}
              entering={FadeIn.delay(600 + index * 80).duration(300)}
              className={"rounded-full px-4 py-2 "}
              style={{ backgroundColor: `rgba(255, 255, 255, ${bgOpacity})` }}
            >
              <ThemedText
                variant={intensity > 0.7 ? "body" : "subhead"}
                className={"text-foreground"}
                style={{ fontWeight: intensity > 0.5 ? "600" : "400" }}
              >
                {cuisine.cuisine}
                <ThemedText variant={"footnote"} className={"text-muted-foreground/80"}>
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
  icon: IconSymbolName;
  iconBg: string;
  title: string;
  value: string;
  subtitle?: string;
  delay: number;
}) {
  return (
    <Animated.View
      entering={FadeInDown.delay(delay).duration(400)}
      className={"border-b border-white/10 py-3 flex-row items-center gap-4"}
    >
      <View className={`w-12 h-12 rounded-full items-center justify-center ${iconBg}`}>
        <IconSymbol name={icon} size={20} color={"#e5e7eb"} />
      </View>
      <View className={"flex-1"}>
        <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
          {title}
        </ThemedText>
        <ThemedText variant={"body"} className={"text-foreground font-semibold"} numberOfLines={1}>
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
function DiningMapSection({
  points,
  selectedYear,
}: {
  points: WrappedStats["mapPoints"];
  selectedYear: number | null;
}) {
  const insets = useSafeAreaInsets();
  const [isFullscreenOpen, setIsFullscreenOpen] = useState(false);
  const cameraPosition = useMemo(() => getMapCameraPosition(points), [points]);

  const appleMarkers = useMemo<AppleMaps.Marker[]>(
    () =>
      points.map((point) => ({
        id: point.id,
        coordinates: { latitude: point.latitude, longitude: point.longitude },
        title: point.name,
        tintColor: point.visits > 2 ? "#34d399" : "#f59e0b",
        systemImage: point.visits > 2 ? "fork.knife.circle.fill" : "fork.knife",
      })),
    [points],
  );

  const googleMarkers = useMemo<GoogleMaps.Marker[]>(
    () =>
      points.map((point) => ({
        id: point.id,
        coordinates: { latitude: point.latitude, longitude: point.longitude },
        title: point.name,
        snippet: `${point.visits.toLocaleString()} ${point.visits === 1 ? "visit" : "visits"}`,
      })),
    [points],
  );

  const openRestaurant = useCallback((restaurantId: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setIsFullscreenOpen(false);
    router.push(`/restaurant/${restaurantId}`);
  }, []);

  const handleMarkerPress = useCallback(
    (event: { id?: string }) => {
      if (!event.id) {
        return;
      }
      openRestaurant(event.id);
    },
    [openRestaurant],
  );

  if (points.length === 0) {
    return null;
  }

  const renderMap = () => {
    if (!cameraPosition) {
      return (
        <View className={"flex-1 items-center justify-center px-6"}>
          <ThemedText variant={"footnote"} className={"text-muted-foreground text-center"}>
            Map preview is available on iOS and Android builds.
          </ThemedText>
        </View>
      );
    }

    if (Platform.OS === "ios") {
      return (
        <AppleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          markers={appleMarkers}
          uiSettings={{
            compassEnabled: false,
            myLocationButtonEnabled: false,
            scaleBarEnabled: false,
            togglePitchEnabled: false,
          }}
          properties={{
            selectionEnabled: false,
          }}
          onMarkerClick={handleMarkerPress}
        />
      );
    }

    if (Platform.OS === "android") {
      return (
        <GoogleMaps.View
          style={{ flex: 1 }}
          cameraPosition={cameraPosition}
          markers={googleMarkers}
          uiSettings={{
            compassEnabled: false,
            mapToolbarEnabled: false,
            myLocationButtonEnabled: false,
            scaleBarEnabled: false,
            zoomControlsEnabled: false,
          }}
          properties={{
            selectionEnabled: false,
          }}
          onMarkerClick={handleMarkerPress}
        />
      );
    }

    return (
      <View className={"flex-1 items-center justify-center px-6"}>
        <ThemedText variant={"footnote"} className={"text-muted-foreground text-center"}>
          Map preview is available on iOS and Android builds.
        </ThemedText>
      </View>
    );
  };

  return (
    <>
      <Animated.View entering={FadeInDown.delay(420).duration(400)} className={"gap-4"}>
        <SectionHeading title={"Dining Map"} icon={"map.fill"} accentClass={"bg-emerald-300"} />

        <View className={"border-y border-white/15 py-3 gap-3"}>
          <View className={"flex-row items-center justify-between gap-3 px-1"}>
            <View className={"flex-1"}>
              <ThemedText variant={"footnote"} className={"text-muted-foreground"} numberOfLines={2}>
                {selectedYear
                  ? `Top visited restaurants in ${selectedYear}`
                  : "Top visited restaurants across your confirmed visits"}
              </ThemedText>
            </View>
            <View className={"rounded-full px-2.5 py-1 bg-emerald-500/15 border border-emerald-500/25"}>
              <ThemedText variant={"caption2"} className={"text-emerald-300 font-semibold"}>
                {points.length} pins
              </ThemedText>
            </View>
          </View>

          <View
            className={"relative rounded-2xl overflow-hidden border bg-secondary/40"}
            style={{
              height: 220,
              borderCurve: "continuous",
              borderColor: "rgba(52, 211, 153, 0.18)",
            }}
          >
            {renderMap()}
            <View className={"absolute top-2.5 right-2.5"}>
              <NativeStatsButton
                label={"Expand map"}
                systemImage={"arrow.up.left.and.arrow.down.right"}
                iconOnly
                size={"small"}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setIsFullscreenOpen(true);
                }}
              />
            </View>
          </View>
        </View>
      </Animated.View>

      <Modal animationType={"slide"} visible={isFullscreenOpen} onRequestClose={() => setIsFullscreenOpen(false)}>
        <View className={"flex-1 bg-black"}>
          <View className={"flex-1"}>{renderMap()}</View>
          <View style={{ position: "absolute", top: insets.top + 10, right: 12 }}>
            <NativeStatsButton
              label={"Done"}
              size={"small"}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setIsFullscreenOpen(false);
              }}
            />
          </View>
        </View>
      </Modal>
    </>
  );
}

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
      <SectionHeading title={"Your Dining World"} icon={"globe.americas.fill"} accentClass={"bg-emerald-400"} />

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
      <View className={"border-y border-white/15 py-4 gap-3"}>
        {locations.slice(0, 5).map((loc, index) => {
          const widthPercent = (loc.visits / maxVisits) * 100;
          return (
            <Animated.View
              key={loc.location}
              entering={FadeIn.delay(500 + index * 80).duration(300)}
              className={"gap-1"}
            >
              <View className={"flex-row justify-between items-center"}>
                <ThemedText variant={"subhead"} className={"text-foreground font-medium"} numberOfLines={1}>
                  {loc.city}
                </ThemedText>
                <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
                  {loc.visits} {loc.visits === 1 ? "visit" : "visits"}
                </ThemedText>
              </View>
              <View className={"h-2 bg-secondary/70 rounded-full overflow-hidden"}>
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
      <SectionHeading title={"Yearly Highlights"} icon={"calendar"} accentClass={"bg-blue-400"} />
      <View className={"border-y border-white/15 py-4 gap-3"}>
        {yearlyStats.map((year, index) => (
          <Animated.View
            key={year.year}
            entering={FadeIn.delay(420 + index * 80).duration(300)}
            className={"flex-row items-center justify-between gap-3"}
          >
            <View className={"flex-1"}>
              <ThemedText variant={"subhead"} className={"text-foreground font-semibold"}>
                {year.year}
              </ThemedText>
              {year.topRestaurant && (
                <ThemedText variant={"caption2"} className={"text-muted-foreground/80"} numberOfLines={1}>
                  Top spot: {year.topRestaurant.name} · {year.topRestaurant.visits}{" "}
                  {year.topRestaurant.visits === 1 ? "visit" : "visits"}
                </ThemedText>
              )}
            </View>
            <View className={"items-end"}>
              <ThemedText variant={"subhead"} className={"text-amber-300 font-semibold"}>
                {year.totalVisits.toLocaleString()}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
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
    { label: "Breakfast", count: mealTimes.breakfast, symbol: "sunrise.fill" as const, color: "bg-orange-400" },
    { label: "Lunch", count: mealTimes.lunch, symbol: "sun.max.fill" as const, color: "bg-yellow-400" },
    { label: "Dinner", count: mealTimes.dinner, symbol: "moon.fill" as const, color: "bg-indigo-400" },
    { label: "Late Night", count: mealTimes.lateNight, symbol: "moon.stars.fill" as const, color: "bg-purple-400" },
  ].filter((s) => s.count > 0);

  // Find the dominant meal time
  const dominant = segments.reduce((max, s) => (s.count > max.count ? s : max), segments[0]);

  return (
    <Animated.View entering={FadeInDown.delay(600).duration(400)} className={"gap-4"}>
      <SectionHeading title={"When You Dine"} icon={"clock.fill"} accentClass={"bg-indigo-400"} />

      <View className={"border-y border-white/15 py-4 gap-4"}>
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
                className={`w-[47%] flex-row items-center gap-2 border-t py-2 ${
                  isDominant ? "border-indigo-300/60" : "border-white/10"
                }`}
              >
                <IconSymbol name={segment.symbol} size={16} color={"#e5e7eb"} />
                <View>
                  <ThemedText
                    variant={"footnote"}
                    className={isDominant ? "text-foreground font-semibold" : "text-secondary-foreground/80"}
                  >
                    {segment.label}
                  </ThemedText>
                  <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
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
      <SectionHeading title={"Weekend vs Weekday"} icon={"calendar"} accentClass={"bg-sky-400"} />

      <View className={"border-y border-white/15 py-4"}>
        <View className={"flex-row items-center gap-4"}>
          {/* Weekday */}
          <View className={"flex-1 items-center gap-2"}>
            <View
              className={
                "w-24 h-24 rounded-full bg-blue-500/20 items-center justify-center border-2 border-blue-400/50"
              }
            >
              <ThemedText
                className={"text-blue-300 font-bold"}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                maxFontSizeMultiplier={1.15}
                style={{ width: "100%", paddingHorizontal: 8, fontSize: 22, lineHeight: 26, textAlign: "center" }}
              >
                {weekdayPercent}%
              </ThemedText>
            </View>
            <ThemedText variant={"footnote"} className={"text-secondary-foreground/80"}>
              Weekday
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
              {weekendVsWeekday.weekday} visits
            </ThemedText>
          </View>

          {/* Divider */}
          <View className={"h-20 w-px bg-secondary"} />

          {/* Weekend */}
          <View className={"flex-1 items-center gap-2"}>
            <View
              className={
                "w-24 h-24 rounded-full bg-rose-500/20 items-center justify-center border-2 border-rose-400/50"
              }
            >
              <ThemedText
                className={"text-rose-300 font-bold"}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                maxFontSizeMultiplier={1.15}
                style={{ width: "100%", paddingHorizontal: 8, fontSize: 22, lineHeight: 26, textAlign: "center" }}
              >
                {weekendPercent}%
              </ThemedText>
            </View>
            <ThemedText variant={"footnote"} className={"text-secondary-foreground/80"}>
              Weekend
            </ThemedText>
            <ThemedText variant={"caption2"} className={"text-muted-foreground/80"}>
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
      <SectionHeading title={"Your Food Photography"} icon={"camera.fill"} accentClass={"bg-cyan-400"} />

      <View className={"border-y border-white/15"}>
        <View className={"flex-row py-4"}>
          <View className={"flex-1 items-center gap-1"}>
            <ThemedText variant={"largeTitle"} className={"text-cyan-400 font-bold"}>
              {photoStats.totalPhotos.toLocaleString()}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-muted-foreground text-center"}>
              Total Photos
            </ThemedText>
          </View>
          <View className={"w-px bg-white/10"} />
          <View className={"flex-1 items-center gap-1"}>
            <ThemedText variant={"largeTitle"} className={"text-pink-400 font-bold"}>
              {photoStats.averagePerVisit}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-muted-foreground text-center"}>
              Avg Per Visit
            </ThemedText>
          </View>
        </View>

        {photoStats.mostPhotographedVisit && (
          <Animated.View
            entering={FadeIn.delay(900).duration(300)}
            className={"border-t border-white/10 py-3 flex-row items-center gap-3"}
          >
            <View className={"w-10 h-10 rounded-full bg-cyan-500/30 items-center justify-center"}>
              <IconSymbol name={"trophy.fill"} size={17} color={"#67e8f9"} />
            </View>
            <View className={"flex-1"}>
              <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
                Most Photographed
              </ThemedText>
              <ThemedText variant={"body"} className={"text-foreground font-semibold"} numberOfLines={1}>
                {photoStats.mostPhotographedVisit.restaurantName}
              </ThemedText>
              <ThemedText variant={"caption2"} className={"text-cyan-300"}>
                {photoStats.mostPhotographedVisit.photoCount} photos
              </ThemedText>
            </View>
          </Animated.View>
        )}
      </View>
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
  let symbol: IconSymbolName = "scale.3d";
  let description = "You enjoy both discovering new places and returning to favorites";

  if (isExplorer) {
    title = "Adventurous Explorer";
    symbol = "safari.fill";
    description = "You love discovering new restaurants!";
  } else if (isLoyal) {
    title = "Loyal Regular";
    symbol = "heart.fill";
    description = "You have your favorite spots and stick with them";
  }

  return (
    <Animated.View entering={FadeInDown.delay(900).duration(400)} className={"gap-4"}>
      <SectionHeading title={"Your Dining Style"} icon={"scope"} accentClass={"bg-violet-400"} />

      <View className={"border-y border-white/15 py-5 gap-4"}>
        {/* Title and emoji */}
        <View className={"flex-row items-center gap-3"}>
          <View className={"w-14 h-14 rounded-full bg-violet-500/30 items-center justify-center"}>
            <IconSymbol name={symbol} size={25} color={"#c4b5fd"} />
          </View>
          <View className={"flex-1"}>
            <ThemedText variant={"title3"} className={"text-violet-300 font-bold"}>
              {title}
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
              {description}
            </ThemedText>
          </View>
        </View>

        {/* Explorer bar */}
        <View className={"gap-2"}>
          <View className={"flex-row justify-between"}>
            <ThemedText variant={"caption1"} className={"text-secondary-foreground/80"}>
              New Places
            </ThemedText>
            <ThemedText variant={"caption1"} className={"text-secondary-foreground/80"}>
              Return Visits
            </ThemedText>
          </View>
          <View className={"h-3 bg-secondary/70 rounded-full overflow-hidden flex-row"}>
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
      <View className={"bg-green-500/10 border-y border-green-500/30 p-4 flex-row items-center gap-4"}>
        <View className={"w-14 h-14 rounded-full bg-green-500/30 items-center justify-center"}>
          <IconSymbol name={"leaf.fill"} size={25} color={"#4ade80"} />
        </View>
        <View className={"flex-1"}>
          <ThemedText variant={"subhead"} className={"text-green-300 font-bold"}>
            Eco-Conscious Diner
          </ThemedText>
          <ThemedText variant={"footnote"} className={"text-secondary-foreground/80"}>
            You visited{" "}
            <ThemedText variant={"footnote"} className={"text-green-400 font-semibold"}>
              {greenStarVisits} Michelin Green Star
            </ThemedText>{" "}
            {greenStarVisits === 1 ? "restaurant" : "restaurants"}
          </ThemedText>
          <ThemedText variant={"caption2"} className={"text-muted-foreground/80 mt-1"}>
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

function SectionHeading({ title, icon, accentClass }: { title: string; icon: IconSymbolName; accentClass: string }) {
  return (
    <View className={"flex-row items-center gap-3"}>
      <View className={`w-2 h-2 rounded-full ${accentClass}`} />
      <ThemedText variant={"caption1"} className={"uppercase tracking-widest text-foreground font-semibold"}>
        {title}
      </ThemedText>
      <View className={"flex-1 h-px bg-white/15"} />
      <IconSymbol name={icon} size={13} color={"#8e8e93"} />
    </View>
  );
}

function StatsStoriesModal({
  visible,
  onClose,
  stats,
  selectedYear,
}: {
  visible: boolean;
  onClose: () => void;
  stats: WrappedStats;
  selectedYear: number | null;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const storyRefs = useRef<Array<React.RefObject<View | null>>>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [sharingStoryId, setSharingStoryId] = useState<string | null>(null);

  const fourthStat = useMemo(() => getFourthStat(stats), [stats]);
  const hasMonthlyData = stats.monthlyVisits.length > 0;
  const hasMichelinData = stats.michelinStats.totalStarredVisits > 0;
  const hasLocationData = stats.topLocations.length > 0;
  const hasCuisineData = stats.topCuisines.length > 0;
  const hasPhotoData = stats.photoStats.totalPhotos > 0;
  const hasMealTimeData =
    stats.mealTimeBreakdown.breakfast +
      stats.mealTimeBreakdown.lunch +
      stats.mealTimeBreakdown.dinner +
      stats.mealTimeBreakdown.lateNight >
    0;
  const hasGreenStar = stats.michelinStats.greenStarVisits > 0;

  const stories = useMemo(
    () =>
      [
        {
          id: "overview",
          title: selectedYear ? `${selectedYear} Overview` : "All-Time Overview",
          content: (
            <View className={"gap-5"}>
              <View className={"flex-row gap-3"}>
                <StatCard icon={"mappin"} value={stats.totalConfirmedVisits} label={"Visits"} accentColor={"amber"} />
                <StatCard
                  icon={"fork.knife"}
                  value={stats.totalUniqueRestaurants}
                  label={"Restaurants"}
                  accentColor={"emerald"}
                />
              </View>
              <View className={"flex-row gap-3"}>
                <StatCard
                  icon={"building.2.fill"}
                  value={stats.uniqueCities > 0 ? stats.uniqueCities : "—"}
                  label={"Cities"}
                  accentColor={"violet"}
                />
                <StatCard
                  icon={fourthStat.icon}
                  value={fourthStat.value}
                  label={fourthStat.label}
                  accentColor={"rose"}
                />
              </View>
              {hasMonthlyData && (
                <View className={"gap-5"}>
                  <MonthlyVisitsChart monthlyVisits={stats.monthlyVisits} selectedYear={selectedYear} />
                  <SeasonalitySection monthlyVisits={stats.monthlyVisits} />
                </View>
              )}
            </View>
          ),
        },
        hasMichelinData
          ? {
              id: "michelin",
              title: "Michelin Moments",
              content: (
                <View className={"gap-5"}>
                  {hasGreenStar && <GreenStarSection greenStarVisits={stats.michelinStats.greenStarVisits} />}
                  <StarBreakdown stats={stats.michelinStats} selectedYear={selectedYear} />
                </View>
              ),
            }
          : null,
        hasLocationData || hasCuisineData
          ? {
              id: "places",
              title: "Where You Dine",
              content: (
                <View className={"gap-5"}>
                  {hasLocationData && <LocationBreakdown locations={stats.topLocations} />}
                  {hasCuisineData && <CuisineCloud cuisines={stats.topCuisines} />}
                </View>
              ),
            }
          : null,
        hasMealTimeData || hasPhotoData
          ? {
              id: "habits",
              title: "Habits & Captures",
              content: (
                <View className={"gap-5"}>
                  {hasMealTimeData && <DiningTimeChart mealTimes={stats.mealTimeBreakdown} />}
                  <WeekendWeekdayChart weekendVsWeekday={stats.weekendVsWeekday} />
                  {hasPhotoData && <PhotoStatsSection photoStats={stats.photoStats} />}
                </View>
              ),
            }
          : null,
        {
          id: "deep-dive",
          title: "Deep Dive",
          content: <DeepDiveSection stats={stats} selectedYear={selectedYear} />,
        },
      ].filter(Boolean) as Array<{ id: string; title: string; content: React.ReactNode }>,
    [
      fourthStat.icon,
      fourthStat.label,
      fourthStat.value,
      hasCuisineData,
      hasGreenStar,
      hasLocationData,
      hasMealTimeData,
      hasMichelinData,
      hasMonthlyData,
      hasPhotoData,
      selectedYear,
      stats,
    ],
  );

  const sanitizeForFileName = useCallback((value: string) => {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }, []);

  const shareStory = useCallback(
    async (storyIndex: number) => {
      const story = stories[storyIndex];
      const targetRef = storyRefs.current[storyIndex];
      if (!story || !targetRef) {
        return;
      }

      try {
        setSharingStoryId(story.id);
        const isSharingAvailable = await Sharing.isAvailableAsync();
        if (!isSharingAvailable) {
          Alert.alert("Sharing unavailable", "This device does not support sharing right now.");
          return;
        }

        const image = await makeImageFromView(targetRef);
        if (!image) {
          Alert.alert("Share failed", "Could not generate this story image. Please try again.");
          return;
        }
        const base64Image = image.encodeToBase64(ImageFormat.PNG, 100);
        const outputDirectory = Paths.cache ?? Paths.document;
        const yearSegment = selectedYear ? String(selectedYear) : "all-time";
        const storySegment = sanitizeForFileName(story.title) || story.id;
        const fileName = `palate-stats-${yearSegment}-${storySegment}.png`;
        const outputFile = new File(outputDirectory, fileName);
        outputFile.write(base64Image, { encoding: "base64" });

        await Sharing.shareAsync(outputFile.uri, {
          mimeType: "image/png",
          dialogTitle: `Share ${story.title}`,
        });
      } catch (error) {
        console.warn("Failed to share story image", error);
        Alert.alert("Share failed", "Could not generate this story image. Please try again.");
      } finally {
        setSharingStoryId(null);
      }
    },
    [sanitizeForFileName, selectedYear, stories],
  );

  useEffect(() => {
    if (!visible) {
      setCurrentIndex(0);
      setSharingStoryId(null);
    }
  }, [visible]);

  return (
    <Modal visible={visible} animationType={"slide"} onRequestClose={onClose}>
      <View
        className={"flex-1 bg-background"}
        style={{ paddingTop: insets.top + 8, paddingBottom: insets.bottom + 16 }}
      >
        <View className={"px-4 pb-4 flex-row items-center justify-between"}>
          <ThemedText variant={"heading"} className={"font-semibold"}>
            Stats Stories
          </ThemedText>
          <NativeStatsButton
            label={"Done"}
            size={"small"}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onClose();
            }}
          />
        </View>

        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentInsetAdjustmentBehavior={"never"}
          onMomentumScrollEnd={(event) => {
            const index = Math.round(event.nativeEvent.contentOffset.x / width);
            setCurrentIndex(index);
          }}
        >
          {stories.map((story, index) => {
            if (!storyRefs.current[index]) {
              storyRefs.current[index] = React.createRef<View>();
            }
            return (
              <View key={story.id} style={{ width }} className={"px-4 gap-4"}>
                <View className={"flex-row items-center justify-between"}>
                  <ThemedText variant={"title3"} className={"font-semibold text-foreground"}>
                    {story.title}
                  </ThemedText>
                  <NativeStatsButton
                    label={sharingStoryId === story.id ? "Sharing..." : "Share"}
                    systemImage={"square.and.arrow.up"}
                    disabled={sharingStoryId === story.id}
                    size={"small"}
                    onPress={() => {
                      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                      void shareStory(index);
                    }}
                  />
                </View>

                <ScrollView
                  contentInsetAdjustmentBehavior={"never"}
                  showsVerticalScrollIndicator={false}
                  contentContainerStyle={{ paddingBottom: 24 }}
                >
                  <View
                    ref={storyRefs.current[index]}
                    collapsable={false}
                    className={"rounded-3xl bg-background p-4 border border-border gap-5"}
                    style={{ borderCurve: "continuous" }}
                  >
                    {story.content}
                  </View>
                </ScrollView>
              </View>
            );
          })}
        </ScrollView>

        <View className={"pt-3 px-4 flex-row items-center justify-center gap-2"}>
          {stories.map((story, index) => (
            <View
              key={`${story.id}-dot`}
              className={"h-1.5 rounded-full"}
              style={{
                width: index === currentIndex ? 18 : 6,
                backgroundColor: index === currentIndex ? "rgba(10, 132, 255, 0.9)" : "rgba(255, 255, 255, 0.24)",
              }}
            />
          ))}
        </View>
      </View>
    </Modal>
  );
}

function WrappedContent({ stats, selectedYear }: { stats: WrappedStats; selectedYear: number | null }) {
  const hasMichelinData = stats.michelinStats.totalStarredVisits > 0;
  const hasCuisineData = stats.topCuisines.length > 0;
  const hasMonthlyData = stats.monthlyVisits.length > 0;
  const hasLocationData = stats.topLocations.length > 0;
  const hasMapData = stats.mapPoints.length > 0;
  const hasPhotoData = stats.photoStats.totalPhotos > 0;
  const hasMealTimeData =
    stats.mealTimeBreakdown.breakfast +
      stats.mealTimeBreakdown.lunch +
      stats.mealTimeBreakdown.dinner +
      stats.mealTimeBreakdown.lateNight >
    0;
  const hasGreenStar = stats.michelinStats.greenStarVisits > 0;
  const hasYearlyData = stats.yearlyStats.length > 0;

  return (
    <View className={"gap-6"}>
      {/* Michelin experiences lead the page when available. */}
      {hasMichelinData && <StarBreakdown stats={stats.michelinStats} selectedYear={selectedYear} interactive />}

      {/* Green Star Badge */}
      {hasGreenStar && <GreenStarSection greenStarVisits={stats.michelinStats.greenStarVisits} />}

      {/* Editorial overview */}
      <EditorialOverview stats={stats} />

      {/* Monthly Chart */}
      {hasMonthlyData && <MonthlyVisitsChart monthlyVisits={stats.monthlyVisits} selectedYear={selectedYear} />}

      {/* Geographic Breakdown */}
      {hasMapData && <DiningMapSection points={stats.mapPoints} selectedYear={selectedYear} />}

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
        <SectionHeading title={"Fun Facts"} icon={"sparkles"} accentClass={"bg-amber-300"} />
        <View className={"gap-3"}>
          {stats.peakDiningHour && (
            <FunFactCard
              icon={"clock.fill"}
              iconBg={"bg-cyan-500/30"}
              title={"Peak Dining Hour"}
              value={HOUR_LABELS[stats.peakDiningHour.hour]}
              subtitle={`${stats.peakDiningHour.visits} visits at this time`}
              delay={700}
            />
          )}

          {stats.busiestMonth && (
            <FunFactCard
              icon={"flame.fill"}
              iconBg={"bg-rose-500/30"}
              title={"Busiest Month"}
              value={`${MONTH_NAMES[stats.busiestMonth.month - 1]} ${stats.busiestMonth.year}`}
              subtitle={`${stats.busiestMonth.visits.toLocaleString()} visits`}
              delay={750}
            />
          )}

          {stats.busiestDayOfWeek && (
            <FunFactCard
              icon={"calendar"}
              iconBg={"bg-blue-500/30"}
              title={"Favorite Day"}
              value={DAY_NAMES[stats.busiestDayOfWeek.day]}
              subtitle={`${stats.busiestDayOfWeek.visits.toLocaleString()} visits`}
              delay={800}
            />
          )}

          {stats.topCuisines[0] && (
            <FunFactCard
              icon={"fork.knife"}
              iconBg={"bg-rose-500/30"}
              title={"Signature Cuisine"}
              value={stats.topCuisines[0].cuisine}
              subtitle={`${stats.topCuisines[0].count.toLocaleString()} visits`}
              delay={825}
            />
          )}

          {stats.topLocations[0] && (
            <FunFactCard
              icon={"mappin"}
              iconBg={"bg-emerald-500/30"}
              title={"Top Dining City"}
              value={stats.topLocations[0].city}
              subtitle={`${stats.topLocations[0].visits.toLocaleString()} visits`}
              delay={850}
            />
          )}

          {stats.mostRevisitedRestaurant && (
            <FunFactCard
              icon={"heart.fill"}
              iconBg={"bg-purple-500/30"}
              title={"Your Favorite Spot"}
              value={stats.mostRevisitedRestaurant.name}
              subtitle={`${stats.mostRevisitedRestaurant.visits.toLocaleString()} visits`}
              delay={875}
            />
          )}

          {stats.longestStreak && stats.longestStreak.days >= 2 && (
            <FunFactCard
              icon={"flame.fill"}
              iconBg={"bg-green-500/30"}
              title={"Longest Streak"}
              value={`${stats.longestStreak.days.toLocaleString()} consecutive days`}
              subtitle={`${formatDateShort(stats.longestStreak.startDate)} - ${formatDateShort(stats.longestStreak.endDate)}`}
              delay={900}
            />
          )}

          {stats.firstVisitDate && (
            <FunFactCard
              icon={"star.fill"}
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
      <View className={"w-24 h-24 rounded-full bg-secondary/70  items-center justify-center"}>
        <IconSymbol name={"fork.knife"} size={34} color={"#fbbf24"} />
      </View>
      <View className={"gap-2 items-center"}>
        <ThemedText variant={"title2"} className={"text-foreground font-semibold text-center"}>
          No Dining Data Yet
        </ThemedText>
        <ThemedText variant={"body"} className={"text-muted-foreground text-center"}>
          Start confirming restaurant visits to see your personalized dining stats!
        </ThemedText>
      </View>
      <NativeStatsButton
        label={"Go to Restaurants"}
        prominent
        size={"large"}
        onPress={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          router.push("/");
        }}
      />
    </View>
  );
}

function YearSelector({
  availableYears,
  selectedYear,
  onSelectYear,
}: {
  availableYears: number[];
  selectedYear: number | null;
  onSelectYear: (year: number | null) => void;
}) {
  const yearOptions = ["All Time", ...availableYears.map(String)];
  const selectedValue = selectedYear === null ? "all-time" : String(selectedYear);

  if (yearOptions.length <= 4) {
    const selectedIndex = selectedYear === null ? 0 : Math.max(availableYears.indexOf(selectedYear) + 1, 0);

    return (
      <SegmentedControl
        values={yearOptions}
        selectedIndex={selectedIndex}
        style={{ width: "100%" }}
        onChange={({ nativeEvent }) => {
          void Haptics.selectionAsync();
          onSelectYear(
            nativeEvent.selectedSegmentIndex === 0 ? null : availableYears[nativeEvent.selectedSegmentIndex - 1],
          );
        }}
      />
    );
  }

  return (
    <View className={"border-y border-white/15 px-1 py-2.5 flex-row items-center justify-between gap-4"}>
      <View className={"flex-row items-center gap-2.5"}>
        <IconSymbol name={"calendar"} size={16} color={"#fbbf24"} />
        <View>
          <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-amber-300"}>
            Archive period
          </ThemedText>
          <ThemedText variant={"caption2"} className={"text-muted-foreground"}>
            {availableYears.length} years available
          </ThemedText>
        </View>
      </View>
      <Host matchContents>
        <Picker
          selectedValue={selectedValue}
          appearance={"menu"}
          onValueChange={(value) => {
            void Haptics.selectionAsync();
            onSelectYear(value === "all-time" ? null : Number(value));
          }}
        >
          <Picker.Item label={"All Time"} value={"all-time"} />
          {availableYears.map((year) => (
            <Picker.Item key={year} label={String(year)} value={String(year)} />
          ))}
        </Picker>
      </Host>
    </View>
  );
}

export default function StatsScreen() {
  const insets = useSafeAreaInsets();
  const [selectedYear, setSelectedYear] = useState<number | null>(null);
  const [isStoriesOpen, setIsStoriesOpen] = useState(false);

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
      className={"flex-1 bg-background"}
      contentInsetAdjustmentBehavior={"automatic"}
      keyboardDismissMode={"interactive"}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{
        paddingTop: 0,
        paddingBottom: insets.bottom + 24,
        paddingHorizontal: 16,
      }}
    >
      {/* Header */}
      <Animated.View entering={FadeInDown.duration(500)} className={"gap-3 mb-5 pt-2"}>
        <View className={"flex-row items-center gap-3"}>
          <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-amber-300 font-semibold"}>
            Palate / Dining Archive
          </ThemedText>
          <View className={"flex-1 h-px bg-white/15"} />
          <ThemedText variant={"caption2"} className={"uppercase tracking-widest text-muted-foreground"}>
            {selectedYear ?? "All Time"}
          </ThemedText>
        </View>
        <View className={"flex-row items-start justify-between gap-3"}>
          <View className={"flex-1 gap-2"}>
            <ThemedText variant={"largeTitle"} className={"font-semibold"}>
              Stats
            </ThemedText>
            <ThemedText variant={"footnote"} className={"text-muted-foreground"}>
              {headerSubtitle}
            </ThemedText>
          </View>
          {hasData && (
            <NativeStatsButton
              label={"Stories"}
              systemImage={"rectangle.stack.badge.plus"}
              tintColor={"#fbbf24"}
              prominent
              size={"small"}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setIsStoriesOpen(true);
              }}
            />
          )}
        </View>
      </Animated.View>
      {/* Year Tabs */}
      {availableYears.length > 0 && (
        <Animated.View entering={FadeIn.delay(200).duration(400)} className={"mb-6"}>
          <YearSelector availableYears={availableYears} selectedYear={selectedYear} onSelectYear={setSelectedYear} />
        </Animated.View>
      )}
      {/* Content */}
      {isLoading ? (
        <View className={"flex-1 items-center justify-center"}>
          <ThemedText variant={"body"} className={"text-muted-foreground"}>
            Loading your stats...
          </ThemedText>
        </View>
      ) : hasData ? (
        <WrappedContent stats={stats} selectedYear={selectedYear} />
      ) : (
        <EmptyState />
      )}

      {hasData && stats && (
        <StatsStoriesModal
          visible={isStoriesOpen}
          onClose={() => setIsStoriesOpen(false)}
          stats={stats}
          selectedYear={selectedYear}
        />
      )}
    </ScrollView>
  );
}
