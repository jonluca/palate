import type { ExactCalendarMatch } from "@/hooks/queries";

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
  index?: number;
}

// List mode: simple card for the visits list
export type ListModeProps = BaseVisitCardProps & {
  mode: "list";
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

// Review mode: card for the review flow with Michelin suggestions
export type ReviewModeProps = BaseVisitCardProps & {
  mode: "review";
  suggestedRestaurantName?: string | null;
  suggestedRestaurantAward?: string | null;
  suggestedRestaurantCuisine?: string | null;
  suggestedRestaurants?: SuggestedRestaurant[];
  hasSuggestion?: boolean;
  /** Which action is currently loading (shows spinner only on that button) */
  loadingAction?: LoadingAction;
  onConfirm?: (restaurant?: SuggestedRestaurant) => void;
  onReject?: () => void;
  onFindRestaurant?: () => void;
  /** Center latitude for Apple Maps verification searches */
  centerLat?: number;
  /** Center longitude for Apple Maps verification searches */
  centerLon?: number;
  /** Whether to perform Apple Maps verification searches (expensive, use sparingly) */
  enableAppleMapsVerification?: boolean;
  match?: ExactCalendarMatch;
};

export type VisitCardProps = ListModeProps | ReviewModeProps;

// Visit actions props
export type LoadingAction = "skip" | "confirm" | "find" | null;

export interface VisitActionsProps {
  onSkip: () => void;
  onConfirm: () => void;
  onFindRestaurant?: () => void;
  hasSuggestion: boolean;
  /** @deprecated Use loadingAction instead for per-button loading */
  isLoading?: boolean;
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
