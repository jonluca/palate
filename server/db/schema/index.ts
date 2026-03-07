import { authSchema } from "./auth-schema";
import { userProfile } from "./profile";

export { authSchema, userProfile };

export const databaseSchema = {
  ...authSchema,
  userProfile,
};
