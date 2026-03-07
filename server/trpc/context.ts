import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { auth } from "../auth";
import { db } from "../db/client";

export async function createTRPCContext({ req, resHeaders }: FetchCreateContextFnOptions) {
  const session = await auth.api.getSession({
    headers: req.headers,
  });

  return {
    db,
    req,
    resHeaders,
    session,
  };
}

export type TRPCContext = Awaited<ReturnType<typeof createTRPCContext>>;
