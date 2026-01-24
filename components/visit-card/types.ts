import type { ExactCalendarMatch, PendingVisitForReview } from "@/hooks/queries";

export type VisitStatus = "pending" | "confirmed" | "rejected";

interface BaseVisitCardProps {
  id: string;
  startTime: number;
  photoCount: number;
  previewPhotos?: string[];
  foodProbable?: boolean;
  calendarEventTitle?: string | null;
  calendarEventIsAllDay?: boolean | null;
  /** Called when card is pressed. Optional photoIndex if a specific photo was tapped. */
  onPress?: (photoIndex?: number) => void;
  /** Whether to perform Apple Maps verification searches (expensive, use sparingly) */
  enableAppleMapsVerification?: boolean;
}

// List mode: simple card for the visits list
export type ListModeProps = BaseVisitCardProps & {
  mode?: "list"; // Optional for backwards compatibility
  restaurantName: string | null;
  status: VisitStatus;
  onStatusChange?: (status: VisitStatus) => void;
};

// Suggested restaurant detail
export interface SuggestedRestaurant {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  location: string;
  cuisine: string;
  award: string;
  distance: number;
}

// Review mode: simplified props that take a visit directly
export interface ReviewModeProps {
  /** The visit to review */
  visit: PendingVisitForReview;
  /** Optional exact calendar match for this visit */
  match?: ExactCalendarMatch;
  /** Whether to perform Apple Maps verification searches (expensive, use sparingly) */
  enableAppleMapsVerification?: boolean;
}

// Visit actions props
export type LoadingAction = "skip" | "confirm" | "find" | null;

export interface VisitActionsProps {
  onSkip: () => void;
  onConfirm: () => void;
  onFindRestaurant?: () => void;
  onNotThisRestaurant?: () => void;
  hasSuggestion: boolean;
  /** Which action is currently loading (shows spinner only on that button) */
  loadingAction?: LoadingAction;
  variant?: "pill" | "full";
  promptText?: string;
}

export interface MichelinBadge {
  emoji: string;
  label: string;
}

export const statusColors = {
  pending: { bg: "bg-orange-500/10", text: "text-orange-500", dot: "bg-orange-500" },
  confirmed: { bg: "bg-green-500/10", text: "text-green-500", dot: "bg-green-500" },
  rejected: { bg: "bg-red-500/10", text: "text-red-500", dot: "bg-red-500" },
} as const;
