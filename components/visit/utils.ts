import type { VisitStatus } from "@/hooks/queries";

export const formatDate = (timestamp: number) => {
  return new Date(timestamp).toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
};

export const formatTime = (timestamp: number) => {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
};

export const statusVariant: Record<VisitStatus, "warning" | "success" | "destructive"> = {
  pending: "warning",
  confirmed: "success",
  rejected: "destructive",
};
