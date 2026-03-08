import { authSchema } from "./auth-schema";
import { canonicalRestaurant } from "./canonical-restaurant";
import {
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
} from "./profile";

export {
  authSchema,
  canonicalRestaurant,
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
};

export const databaseSchema = {
  ...authSchema,
  canonicalRestaurant,
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
};
