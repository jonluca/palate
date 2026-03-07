import "dotenv/config";
import { serve } from "@hono/node-server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./auth";
import { serverEnv } from "./env";
import { createTRPCContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

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

serve(
  {
    fetch: app.fetch,
    port: serverEnv.port,
  },
  (info) => {
    console.info(`Palate backend listening on http://127.0.0.1:${info.port}`);
  },
);
