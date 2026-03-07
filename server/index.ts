import { serve } from "@hono/node-server";
import { serverEnv } from "./env";
import app from "./app";

serve(
  {
    fetch: app.fetch,
    port: serverEnv.port,
  },
  (info) => {
    console.info(`Palate backend listening on http://127.0.0.1:${info.port}`);
  },
);
