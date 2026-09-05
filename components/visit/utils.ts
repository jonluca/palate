import type { VisitStatus } from "@/utils/visit-status";

export const formatDate = (timestamp: number, timeZone?: string | null) => {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  };
  if (timeZone) {
    options.timeZone = timeZone;
  }
  return new Date(timestamp).toLocaleDateString(undefined, options);
};

export const formatTime = (timestamp: number, timeZone?: string | null) => {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  if (timeZone) {
    options.timeZone = timeZone;
  }
  return new Date(timestamp).toLocaleTimeString(undefined, options);
};

export const statusVariant = {
  pending: "warning",
  confirmed: "success",
  rejected: "destructive",
} satisfies Record<VisitStatus, "warning" | "success" | "destructive">;
