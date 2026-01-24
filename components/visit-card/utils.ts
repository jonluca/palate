import type { MichelinBadge } from "./types";

export function formatDate(timestamp: number, timeZone?: string | null): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function formatTime(timestamp: number, timeZone?: string | null): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  });
}

export function getMichelinBadge(award: string): MichelinBadge | null {
  if (!award) {
    return null;
  }
  const lowerAward = award.toLowerCase();
  if (lowerAward.includes("3 star")) {
    return { emoji: "⭐⭐⭐", label: "3 Michelin Stars" };
  }
  if (lowerAward.includes("2 star")) {
    return { emoji: "⭐⭐", label: "2 Michelin Stars" };
  }
  if (lowerAward.includes("1 star")) {
    return { emoji: "⭐", label: "1 Michelin Star" };
  }
  if (lowerAward.includes("bib")) {
    return { emoji: "🍽️", label: "Bib Gourmand" };
  }
  if (lowerAward.includes("selected")) {
    return { emoji: "🏆", label: "Michelin Selected" };
  }
  return null;
}
