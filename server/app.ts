import "dotenv/config";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./auth";
import { serverEnv } from "./env";
import { createTRPCContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

const APP_STORE_URL = "https://apps.apple.com/us/app/palate-fine-dining-tracker/id6757490799";

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? serverEnv.betterAuthUrl,
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  }),
);

app.get("/", (c) => c.redirect(APP_STORE_URL, 302));

app.get("/health", (c) =>
  c.json({
    status: "ok",
    serverTime: new Date().toISOString(),
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.all("/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: createTRPCContext,
    onError({ error, path }) {
      console.error(`[trpc] ${path ?? "unknown"} failed`, error);
    },
  }),
);

export { app };
export default app;
