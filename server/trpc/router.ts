import { healthRouter } from "./routers/health";
import { profileRouter } from "./routers/profile";
import { socialRouter } from "./routers/social";
import { router } from "./trpc";

export const appRouter = router({
  health: healthRouter,
  profile: profileRouter,
  social: socialRouter,
});

export type AppRouter = typeof appRouter;
