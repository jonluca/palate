// Re-export everything from the visit-card module for backwards compatibility
export type {
  VisitStatus,
  BaseVisitCardProps,
  ListModeProps,
  SuggestedRestaurant,
  ReviewModeProps,
  VisitCardProps,
  AppleMapsVerification,
  MergedRestaurantSuggestion,
  AppleMapsSearchResult,
  VisitActionsProps,
  MichelinBadge,
} from "./visit-card/types";
export { statusColors } from "./visit-card/types";

export { formatDate, formatTime, formatDistance, getMichelinBadge, calculateDistance } from "./visit-card/utils";

export {
  FoodBadge,
  CalendarBadge,
  NearbyRestaurantsBadge,
  ExactMatchBadge,
  AppleMapsVerifiedBadge,
} from "./visit-card/badges";

export { PhotoPreview } from "./visit-card/photo-preview";
export { VisitActions } from "./visit-card/visit-actions";
export { ListModeCard } from "./visit-card/list-mode-card";
export { ReviewModeCard } from "./visit-card/review-mode-card";
export { VisitCard } from "./visit-card/index";
