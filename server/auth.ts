import { expo } from "@better-auth/expo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { db } from "./db/client";
import { authSchema } from "./db/schema";
import { serverEnv } from "./env";

const defaultTrustedOrigins = new Set(["palate://"]);

for (const origin of serverEnv.trustedOrigins) {
  defaultTrustedOrigins.add(origin);
}

export const auth = betterAuth({
  secret: serverEnv.betterAuthSecret,
  baseURL: serverEnv.betterAuthUrl,
  trustedOrigins: Array.from(defaultTrustedOrigins),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    usePlural: false,
  }),
  plugins: [expo()],
});

export type AuthSession = typeof auth.$Infer.Session;
