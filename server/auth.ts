import { createPrivateKey } from "crypto";
import { expo } from "@better-auth/expo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { SignJWT } from "jose";
import { db } from "./db/client";
import { authSchema } from "./db/schema";
import { serverEnv } from "./env";

const defaultTrustedOrigins = new Set(["palate://"]);
defaultTrustedOrigins.add("https://appleid.apple.com");
const APPLE_CLIENT_ID = "com.jonluca.palate.siwa";
const APPLE_APP_BUNDLE_IDENTIFIER = "com.jonluca.photo-restaurant-matcher";
const APPLE_TEAM_ID = "F35YQQ5672";
const APPLE_CLIENT_SECRET_TTL_SECONDS = 86400 * 180;
const appleClientSecretCache = new Map<string, string>();
const betterAuthOrigin = new URL(serverEnv.betterAuthUrl).origin;

defaultTrustedOrigins.add(betterAuthOrigin);

if (serverEnv.isDevelopment) {
  defaultTrustedOrigins.add(`http://localhost:${serverEnv.port}`);
}

for (const origin of serverEnv.trustedOrigins) {
  defaultTrustedOrigins.add(origin);
}

async function getAppleClientSecret() {
  if (serverEnv.appleClientSecret) {
    return serverEnv.appleClientSecret;
  }

  if (!serverEnv.applePrivateKey || !serverEnv.appleKeyId) {
    return null;
  }

  const today = new Date().toISOString().slice(0, 10);
  const cachedSecret = appleClientSecretCache.get(today);

  if (cachedSecret) {
    return cachedSecret;
  }

  const privateKeyPem = Buffer.from(serverEnv.applePrivateKey, "base64").toString("utf-8");
  const appleKey = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const expirationTime = Math.ceil(Date.now() / 1000) + APPLE_CLIENT_SECRET_TTL_SECONDS;

  const clientSecret = await new SignJWT({})
    .setAudience("https://appleid.apple.com")
    .setIssuer(APPLE_TEAM_ID)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .setSubject(APPLE_CLIENT_ID)
    .setProtectedHeader({ alg: "ES256", kid: serverEnv.appleKeyId })
    .sign(appleKey);

  appleClientSecretCache.set(today, clientSecret);
  return clientSecret;
}

async function appleProvider() {
  const clientSecret = await getAppleClientSecret();

  return {
    clientId: APPLE_CLIENT_ID,
    ...(clientSecret ? { clientSecret } : {}),
    appBundleIdentifier: serverEnv.appleAppBundleIdentifier ?? APPLE_APP_BUNDLE_IDENTIFIER,
  };
}

export const auth = betterAuth({
  secret: serverEnv.betterAuthSecret,
  baseURL: serverEnv.betterAuthUrl,
  trustedOrigins: Array.from(defaultTrustedOrigins),
  advanced: {
    useSecureCookies: false,
  },
  emailAndPassword: {
    enabled: false,
  },
  socialProviders: {
    apple: appleProvider,
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    usePlural: false,
  }),
  plugins: [expo()],
});

export type AuthSession = typeof auth.$Infer.Session;
