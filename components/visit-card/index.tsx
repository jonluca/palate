import type { VisitCardProps } from "./types";
import { ListModeCard } from "./list-mode-card";
import { ReviewModeCard } from "./review-mode-card";

export function VisitCard(props: VisitCardProps) {
  if (props.mode === "list") {
    return <ListModeCard {...props} />;
  }
  return <ReviewModeCard {...props} />;
}
