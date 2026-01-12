// Types
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
} from "./types";
export { statusColors } from "./types";

// Utils
export { formatDate, formatTime, formatDistance, getMichelinBadge, calculateDistance } from "./utils";

// Badge Components
export { FoodBadge, CalendarBadge, NearbyRestaurantsBadge, ExactMatchBadge, AppleMapsVerifiedBadge } from "./badges";

// Components
export { PhotoPreview } from "./photo-preview";
export { VisitActions } from "./visit-actions";
export { ListModeCard } from "./list-mode-card";
export { ReviewModeCard } from "./review-mode-card";

// Main component
import type { VisitCardProps } from "./types";
import { ListModeCard } from "./list-mode-card";
import { ReviewModeCard } from "./review-mode-card";

export function VisitCard(props: VisitCardProps) {
  if (props.mode === "list") {
    return <ListModeCard {...props} />;
  }
  return <ReviewModeCard {...props} />;
}
