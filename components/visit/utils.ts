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

const formatDuration = (start: number, end: number) => {
  const diffMs = end - start;
  const diffMins = Math.round(diffMs / (1000 * 60));
  if (diffMins < 60) {
    return `${diffMins} min`;
  }
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
};

export const statusVariant: Record<VisitStatus, "warning" | "success" | "destructive"> = {
  pending: "warning",
  confirmed: "success",
  rejected: "destructive",
};
