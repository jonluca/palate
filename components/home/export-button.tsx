import React from "react";
import { Alert } from "react-native";
import { Button, ButtonText } from "@/components/ui";
import { useExportData } from "@/hooks/queries";
import { useToast } from "@/components/ui/toast";
import { logExportStarted } from "@/services/analytics";

interface ExportButtonProps {
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  textVariant?: React.ComponentProps<typeof ButtonText>["variant"];
  textSize?: React.ComponentProps<typeof ButtonText>["size"];
  className?: string;
}

export function ExportButton({
  label = "Export Confirmed Visits",
  variant = "outline",
  size = "default",
  textVariant,
  textSize,
  className,
}: ExportButtonProps) {
  const exportMutation = useExportData();
  const { showToast } = useToast();

  const handleExport = () => {
    Alert.alert("Export Data", "Choose export format:", [
      {
        text: "JSON (Full Data)",
        onPress: async () => {
          try {
            logExportStarted("json");
            await exportMutation.mutateAsync("json");
            showToast({ type: "success", message: "Export data generated! Check console for preview." });
          } catch {
            showToast({ type: "error", message: "Failed to export data" });
          }
        },
      },
      {
        text: "CSV (Spreadsheet)",
        onPress: async () => {
          try {
            logExportStarted("csv");
            await exportMutation.mutateAsync("csv");
            showToast({ type: "success", message: "Export data generated! Check console for preview." });
          } catch {
            showToast({ type: "error", message: "Failed to export data" });
          }
        },
      },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  return (
    <Button
      onPress={handleExport}
      loading={exportMutation.isPending}
      variant={variant}
      size={size}
      className={className}
    >
      <ButtonText variant={textVariant ?? variant} size={textSize}>
        {label}
      </ButtonText>
    </Button>
  );
}
