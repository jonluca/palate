import React from "react";
import { View } from "react-native";
import { Card, StatRow, StatDivider } from "@/components/ui";
import type { Stats } from "@/hooks/queries";

interface StatsCardProps {
  stats: Stats;
}

export function StatsCard({ stats }: StatsCardProps) {
  if (stats.totalPhotos === 0) {
    return null;
  }

  return (
    <Card animated={false}>
      <View className={"p-4"}>
        <StatRow label={"Photos Scanned"} value={stats.totalPhotos} animated={false} />
        <StatRow label={"With Location"} value={stats.photosWithLocation} animated={false} />
        <StatDivider animated={false} />
        <StatRow label={"Visits with Food Found"} value={stats.foodProbableVisits} animated={false} />
        <StatRow label={"Confirmed"} value={stats.confirmedVisits} valueColor={"text-green-500"} animated={false} />
      </View>
    </Card>
  );
}
