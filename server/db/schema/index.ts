import { authSchema } from "./auth-schema";
import { userConfirmedVisit, userFollow, userProfile } from "./profile";

export { authSchema, userConfirmedVisit, userFollow, userProfile };

export const databaseSchema = {
  ...authSchema,
  userConfirmedVisit,
  userFollow,
  userProfile,
};
