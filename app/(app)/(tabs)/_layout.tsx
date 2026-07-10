import { NativeTabs } from "expo-router/unstable-native-tabs";
import React from "react";
import { Platform } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

export default function TabLayout() {
  const tabTintColor = "#0A84FF";

  return (
    <NativeTabs minimizeBehavior={"onScrollDown"} tintColor={tabTintColor} backgroundColor={"transparent"}>
      <NativeTabs.Trigger name={"index"}>
        <NativeTabs.Trigger.Label>Restaurants</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "fork.knife", selected: "fork.knife" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"restaurant"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"review"}>
        <NativeTabs.Trigger.Label>Review</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "checkmark.circle", selected: "checkmark.circle.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"check-circle"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"stats"}>
        <NativeTabs.Trigger.Label>Stats</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "chart.bar", selected: "chart.bar.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon
              src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"bar-chart"} />}
            />
          ),
        })}
      </NativeTabs.Trigger>

      <NativeTabs.Trigger name={"settings"}>
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
        {Platform.select({
          ios: <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />,
          android: (
            <NativeTabs.Trigger.Icon src={<NativeTabs.Trigger.VectorIcon family={MaterialIcons} name={"settings"} />} />
          ),
        })}
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
