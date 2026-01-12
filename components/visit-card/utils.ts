import type { MichelinBadge } from "./types";

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters).toLocaleString()}m`;
  }
  const km = meters / 1000;
  return `${km.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}km`;
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

// Calculate distance between two coordinates in meters
export function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
