import { healthRouter } from "./routers/health";
import { profileRouter } from "./routers/profile";
import { router } from "./trpc";

export const appRouter = router({
  health: healthRouter,
  profile: profileRouter,
});

export type AppRouter = typeof appRouter;
