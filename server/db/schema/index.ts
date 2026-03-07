import { authSchema } from "./auth-schema";
import {
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
} from "./profile";

export { authSchema, userConfirmedVisit, userConfirmedVisitComment, userConfirmedVisitLike, userFollow, userProfile };

export const databaseSchema = {
  ...authSchema,
  userConfirmedVisit,
  userConfirmedVisitComment,
  userConfirmedVisitLike,
  userFollow,
  userProfile,
};
