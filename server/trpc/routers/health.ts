import { publicProcedure, router } from "../trpc";

export const healthRouter = router({
  ping: publicProcedure.query(({ ctx }) => ({
    status: "ok" as const,
    serverTime: new Date().toISOString(),
    authenticated: Boolean(ctx.session?.user),
  })),
});
